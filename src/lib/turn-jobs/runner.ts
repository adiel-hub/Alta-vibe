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
  } as never);

  log.info("enqueued", {
    job_id: insert.insertedId.toHexString(),
    agent_id: agentId.toHexString(),
    role,
    msg_len: userMessage.length,
  });
  return insert.insertedId;
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

  // Build prior transcript from chat_messages excluding this job's user turn
  const messages = await messagesCol();
  const priorMessages = await messages
    .find({
      agent_id: agent._id,
      $or: [
        { turn_job_id: { $exists: false } },
        { turn_job_id: { $ne: jobId } },
      ],
    })
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

    await messages.insertOne({
      agent_id: agent._id,
      role: "assistant",
      content: result.assistantContent,
      turn_job_id: jobId,
      revision_before: agent.revision,
      revision_after: result.endingRevision,
      created_at: new Date(),
    } as never);

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
      } as never);
    }
  }
}

/**
 * Watchdog: mark long-idle running jobs as failed so SSE tails close instead
 * of polling forever. Called from /turns/active before reading state.
 */
export async function reapStuckJobs(agentId: ObjectId): Promise<void> {
  const jobs = await turnJobsCol();
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const res = await jobs.updateMany(
    {
      agent_id: agentId,
      status: { $in: ["queued", "running"] },
      last_event_at: { $lt: cutoff },
    },
    {
      $set: {
        status: "failed",
        error: "Stalled: no events for over 90s (function probably crashed).",
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
