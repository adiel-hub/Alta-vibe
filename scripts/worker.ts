/**
 * Railway-hosted background worker.
 *
 * Polls the `turn_jobs` collection for queued jobs and runs them through
 * `processTurnJob` — the same code path the Vercel API route invokes via
 * `after()`. Multiple workers can run safely thanks to processTurnJob's
 * atomic findOneAndUpdate claim.
 *
 * Why this exists: Vercel functions are time-limited (max 800 s on Pro
 * with Fluid Compute). For sustained throughput, or for turns that would
 * exceed that, point traffic at a worker on Railway. The web app keeps
 * enqueuing jobs; the worker drains the queue.
 *
 * Deploy: see DEPLOYMENT.md. Default behaviour stays Vercel-only — adding
 * the worker is an opt-in production upgrade.
 */
import { ObjectId } from "mongodb";
import { turnJobsCol } from "@/lib/mongodb";
import { STUCK_THRESHOLD_MS, processTurnJob, reapStuckJobs } from "@/lib/turn-jobs/runner";
import { createLogger } from "@/lib/logger";

const log = createLogger("worker");

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "1000");
const MAX_CONCURRENT = Number(process.env.WORKER_MAX_CONCURRENT ?? "4");
const REAP_INTERVAL_MS = Number(process.env.WORKER_REAP_INTERVAL_MS ?? "30000");

let inFlight = 0;
let shuttingDown = false;
let lastReapAt = 0;

async function tick() {
  if (shuttingDown) return;

  // Periodic reaper for stuck jobs across all agents.
  if (Date.now() - lastReapAt > REAP_INTERVAL_MS) {
    lastReapAt = Date.now();
    try {
      const jobs = await turnJobsCol();
      // Only "running" — queued jobs are just waiting for a slot, not stalled.
      const stale = await jobs
        .find({
          status: "running",
          last_event_at: { $lt: new Date(Date.now() - STUCK_THRESHOLD_MS) },
        })
        .project({ agent_id: 1 })
        .limit(50)
        .toArray();
      const uniq = new Set(stale.map((s) => (s.agent_id as ObjectId).toHexString()));
      for (const a of uniq) await reapStuckJobs(new ObjectId(a));
    } catch (err) {
      log.error("reap error", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (inFlight >= MAX_CONCURRENT) return;
  const slots = MAX_CONCURRENT - inFlight;

  const jobs = await turnJobsCol();
  const candidates = await jobs
    .find({ status: "queued" })
    .sort({ started_at: 1 })
    .limit(slots)
    .project({ _id: 1 })
    .toArray();

  if (candidates.length > 0) {
    log.debug("claimed", { count: candidates.length, in_flight: inFlight });
  }
  for (const c of candidates) {
    inFlight++;
    processTurnJob(c._id as ObjectId)
      .catch((err) =>
        log.error("processTurnJob error", {
          job_id: (c._id as ObjectId).toHexString(),
          error: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        inFlight--;
      });
  }
}

async function main() {
  log.info("starting", {
    max_concurrent: MAX_CONCURRENT,
    poll_ms: POLL_INTERVAL_MS,
    reap_ms: REAP_INTERVAL_MS,
  });
  process.on("SIGTERM", () => {
    log.info("SIGTERM received; finishing in-flight jobs");
    shuttingDown = true;
  });
  process.on("SIGINT", () => {
    log.info("SIGINT received; finishing in-flight jobs");
    shuttingDown = true;
  });

  while (!shuttingDown) {
    try {
      await tick();
    } catch (err) {
      log.error("tick error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  while (inFlight > 0) {
    log.info("waiting before exit", { in_flight: inFlight });
    await new Promise((r) => setTimeout(r, 1000));
  }
  log.info("clean exit");
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
