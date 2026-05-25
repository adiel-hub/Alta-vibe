/**
 * Background turn-job runner. Owns the lifecycle of a single Claude agent
 * turn, decoupled from the HTTP request that enqueued it. Events stream into
 * Mongo on `turn_jobs.events` as the SDK produces them so any client
 * (including one that refreshed mid-turn) can tail from any seq.
 *
 * Survives across HTTP requests via Next.js `after()` (Vercel waitUntil).
 * Stuck-job watchdog: if `last_event_at` falls behind `STUCK_THRESHOLD_MS`
 * the reaper (in `reapStuckJobs`) marks the job failed.
 */
import { ObjectId } from "mongodb";
import { runTurn } from "@/lib/builder-agent/runTurn";
import { maybeUpdateConversationSummary } from "@/lib/builder-agent/summarizer";
import {
  agentsCol,
  audienceChatSessionsCol,
  messagesCol,
  turnJobsCol,
} from "@/lib/mongodb";
import { createLogger } from "@/lib/logger";
import type { ContentBlock, SSEEvent, StoredTurnEvent } from "@/types/agent";

const log = createLogger("turn-job");

export const STUCK_THRESHOLD_MS = 180_000;

export async function enqueueTurnJob(
  agentId: ObjectId,
  userMessage: string,
  role: "user" | "system" = "user",
  chatSessionId: ObjectId | null = null,
): Promise<ObjectId> {
  const jobs = await turnJobsCol();
  const now = new Date();
  const insert = await jobs.insertOne({
    agent_id: agentId,
    status: "queued",
    user_message: userMessage,
    events: [],
    next_seq: 0,
    last_event_at: now,
    error: null,
    started_at: now,
    finished_at: null,
    chat_session_id: chatSessionId ?? undefined,
  } as never);

  const messages = await messagesCol();
  await messages.insertOne({
    agent_id: agentId,
    role,
    content: [{ type: "text", text: userMessage }],
    turn_job_id: insert.insertedId,
    revision_before: 0,
    revision_after: 0,
    created_at: now,
    ...(chatSessionId ? { chat_session_id: chatSessionId } : {}),
  } as never);

  // Bump the session's last-activity timestamp so the sidebar re-sorts it
  // to the top, and lazily set the title from the first user message.
  if (chatSessionId) {
    await (await audienceChatSessionsCol()).updateOne(
      { _id: chatSessionId },
      {
        $set: { last_message_at: now, updated_at: now },
        $setOnInsert: { title: deriveSessionTitle(userMessage) },
      },
    );
  }

  log.info("enqueued", {
    job_id: insert.insertedId.toHexString(),
    agent_id: agentId.toHexString(),
    role,
    msg_len: userMessage.length,
    chat_session_id: chatSessionId?.toHexString(),
  });
  return insert.insertedId;
}

/** Compact a free-text user message into a sidebar-friendly title. */
function deriveSessionTitle(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 60) return cleaned || "New audience chat";
  return `${cleaned.slice(0, 57).trimEnd()}…`;
}

export async function processTurnJob(jobId: ObjectId): Promise<void> {
  const jobs = await turnJobsCol();
  const claim = await jobs.findOneAndUpdate(
    { _id: jobId, status: "queued" },
    { $set: { status: "running", started_at: new Date(), last_event_at: new Date() } },
    { returnDocument: "after" },
  );
  if (!claim) {
    log.debug("claim missed (already running or done)", {
      job_id: jobId.toHexString(),
    });
    return;
  }
  const job = claim;
  const tStart = Date.now();
  const tlog = log.child({
    job_id: jobId.toHexString(),
    agent_id: job.agent_id.toHexString(),
  });
  tlog.info("turn start");

  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: job.agent_id });
  if (!agent) {
    await jobs.updateOne(
      { _id: jobId },
      {
        $set: {
          status: "failed",
          error: "Agent not found",
          finished_at: new Date(),
        },
      },
    );
    return;
  }

  // Build prior transcript from chat_messages excluding this job's user turn.
  // When the job is scoped to an audience-builder chat session, only pull
  // messages from THAT session so independent chats stay siloed. Other agents
  // (voice agents) never carry chat_session_id and behave like before.
  const sessionId = (job as { chat_session_id?: ObjectId }).chat_session_id ?? null;
  const messages = await messagesCol();
  const messageFilter: Record<string, unknown> = {
    agent_id: agent._id,
    $or: [
      { turn_job_id: { $exists: false } },
      { turn_job_id: { $ne: jobId } },
    ],
  };
  if (sessionId) messageFilter.chat_session_id = sessionId;
  const priorMessages = await messages
    .find(messageFilter)
    .sort({ created_at: 1 })
    .toArray();

  let localSeq = job.next_seq;
  const assistantContentSnapshot: ContentBlock[] = [];

  // Batch event emit to reduce Mongo round-trips for high-frequency deltas.
  let pending: StoredTurnEvent[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await jobs.updateOne(
      { _id: jobId },
      {
        $push: { events: { $each: batch } },
        $set: { next_seq: localSeq, last_event_at: new Date() },
      },
    );
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await flush().catch(() => {});
    }, 80);
  };
  const bufferedEmit = (event: SSEEvent) => {
    pending.push({ seq: localSeq++, at: new Date(), event });
    scheduleFlush();
  };

  // Roll up any messages that have fallen out of the live window into the
  // stored conversation_summary on the agent doc. Best-effort: if it fails the
  // turn still proceeds with the most recent summary we already had.
  const { summary: conversationSummary } =
    await maybeUpdateConversationSummary(
      agent._id,
      priorMessages,
      agent.conversation_summary ?? null,
      agent.summary_through_message_id ?? null,
    );

  try {
    const result = await runTurn(
      {
        agentMongoId: agent._id.toHexString(),
        elevenlabsAgentId: agent.elevenlabs_agent_id,
        agentName: agent.name,
        agentDescription: agent.description,
        agentKind: agent.kind ?? "voice_agent",
        lastError: agent.last_error,
        currentConfig: agent.config_cache,
        startingRevision: agent.revision,
        conversationSummary,
        transcript: priorMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        userMessage: job.user_message,
        turnJobId: jobId.toHexString(),
      },
      bufferedEmit,
    );
    assistantContentSnapshot.push(...result.assistantContent);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();

    const assistantInsertedAt = new Date();
    await messages.insertOne({
      agent_id: agent._id,
      role: "assistant",
      content: result.assistantContent,
      turn_job_id: jobId,
      revision_before: agent.revision,
      revision_after: result.endingRevision,
      created_at: assistantInsertedAt,
      ...(sessionId ? { chat_session_id: sessionId } : {}),
    } as never);
    if (sessionId) {
      await (await audienceChatSessionsCol()).updateOne(
        { _id: sessionId },
        { $set: { last_message_at: assistantInsertedAt, updated_at: assistantInsertedAt } },
      );
    }

    if (result.endingRevision !== agent.revision) {
      await agents.updateOne(
        { _id: agent._id, revision: agent.revision },
        {
          $set: {
            config_cache: result.finalConfig,
            revision: result.endingRevision,
            updated_at: new Date(),
          },
        },
      );
    }

    await jobs.updateOne(
      { _id: jobId },
      { $set: { status: "done", finished_at: new Date() } },
    );
    tlog.info("turn done", {
      ms: Date.now() - tStart,
      revision_after: result.endingRevision,
      events_emitted: localSeq,
    });
  } catch (err) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush().catch(() => {});
    const message = err instanceof Error ? err.message : "Turn failed";
    tlog.error("turn failed", { ms: Date.now() - tStart, message });
    bufferedEmit({ type: "state_error", section: "turn", message });
    bufferedEmit({ type: "turn_aborted", reason: message });
    await flush().catch(() => {});
    await jobs.updateOne(
      { _id: jobId },
      {
        $set: {
          status: "failed",
          error: message,
          finished_at: new Date(),
        },
      },
    );
    if (assistantContentSnapshot.length > 0) {
      await messages.insertOne({
        agent_id: agent._id,
        role: "assistant",
        content: assistantContentSnapshot,
        turn_job_id: jobId,
        revision_before: agent.revision,
        revision_after: agent.revision,
        created_at: new Date(),
        ...(sessionId ? { chat_session_id: sessionId } : {}),
      } as never);
    }
  }
}

/**
 * Watchdog: mark long-idle RUNNING jobs as failed so SSE tails close
 * instead of polling forever. Called from /turns/active before reading
 * state.
 *
 * Only `running` jobs are reaped — never `queued`. A queued job that's
 * been sitting for 5 min just means the worker was down or busy; the
 * worker will pick it up when it polls. Reaping queued jobs eats the
 * backlog after any worker outage and is exactly what hit us before.
 */
export async function reapStuckJobs(agentId: ObjectId): Promise<void> {
  const jobs = await turnJobsCol();
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const res = await jobs.updateMany(
    {
      agent_id: agentId,
      status: "running",
      last_event_at: { $lt: cutoff },
    },
    {
      $set: {
        status: "failed",
        error: "Stalled: no events for over 3 min (function probably crashed).",
        finished_at: new Date(),
      },
    },
  );
  if (res.modifiedCount > 0) {
    log.warn("reaped stuck jobs", {
      agent_id: agentId.toHexString(),
      count: res.modifiedCount,
    });
  }
}
