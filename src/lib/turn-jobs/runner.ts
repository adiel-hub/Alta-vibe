/**
 * Background turn-job runner. Owns the lifecycle of a single Claude agent
 * turn, decoupled from the HTTP request that enqueued it. Events are streamed
 * into Mongo on `turn_jobs.events` as the SDK produces them so any client
 * (including one that refreshed mid-turn) can tail from any seq.
 *
 * Survives across HTTP requests via Next.js `after()` (Vercel waitUntil).
 */
import { ObjectId } from "mongodb";
import { runTurn } from "@/lib/builder-agent/runTurn";
import {
  agentsCol,
  messagesCol,
  turnJobsCol,
} from "@/lib/mongodb";
import type { ContentBlock, SSEEvent, StoredTurnEvent } from "@/types/agent";

/**
 * Enqueue a new turn job, persist the user message turn, and return the job id.
 * The caller should schedule {@link processTurnJob} via `after()`.
 */
export async function enqueueTurnJob(
  agentId: ObjectId,
  userMessage: string,
): Promise<ObjectId> {
  const jobs = await turnJobsCol();
  const now = new Date();
  const insert = await jobs.insertOne({
    agent_id: agentId,
    status: "queued",
    user_message: userMessage,
    events: [],
    next_seq: 0,
    error: null,
    started_at: now,
    finished_at: null,
  } as never);

  const messages = await messagesCol();
  await messages.insertOne({
    agent_id: agentId,
    role: "user",
    content: [{ type: "text", text: userMessage }],
    turn_job_id: insert.insertedId,
    revision_before: 0,
    revision_after: 0,
    created_at: now,
  } as never);

  return insert.insertedId;
}

/**
 * Drive a queued turn job through the Claude Agent SDK to completion. All
 * progress is persisted to Mongo: events appended, final assistant turn
 * inserted into chat_messages, agent config_cache + revision committed.
 *
 * Idempotent on entry: if status is already running/done/failed, it returns.
 */
export async function processTurnJob(jobId: ObjectId): Promise<void> {
  const jobs = await turnJobsCol();
  const claim = await jobs.findOneAndUpdate(
    { _id: jobId, status: "queued" },
    { $set: { status: "running", started_at: new Date() } },
    { returnDocument: "after" },
  );
  if (!claim) return;
  const job = claim;

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

  const emit = async (event: SSEEvent) => {
    const stored: StoredTurnEvent = {
      seq: localSeq++,
      at: new Date(),
      event,
    };
    await jobs.updateOne(
      { _id: jobId },
      { $push: { events: stored }, $set: { next_seq: localSeq } },
    );
  };

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
        $set: { next_seq: localSeq },
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

  try {
    const result = await runTurn(
      {
        elevenlabsAgentId: agent.elevenlabs_agent_id,
        currentConfig: agent.config_cache,
        startingRevision: agent.revision,
        transcript: priorMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        userMessage: job.user_message,
      },
      bufferedEmit,
    );
    assistantContentSnapshot.push(...result.assistantContent);
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();

    // Persist assistant turn
    await messages.insertOne({
      agent_id: agent._id,
      role: "assistant",
      content: result.assistantContent,
      turn_job_id: jobId,
      revision_before: agent.revision,
      revision_after: result.endingRevision,
      created_at: new Date(),
    } as never);

    // Commit final config via optimistic lock
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
  } catch (err) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush().catch(() => {});
    const message = err instanceof Error ? err.message : "Turn failed";
    await emit({ type: "state_error", section: "turn", message });
    await emit({ type: "turn_aborted", reason: message });
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

    // Persist whatever assistant content we captured, so a refresh shows it.
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
