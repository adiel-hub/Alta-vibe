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
import { processTurnJob, reapStuckJobs } from "@/lib/turn-jobs/runner";

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
      const stale = await jobs
        .find({
          status: { $in: ["queued", "running"] },
          last_event_at: { $lt: new Date(Date.now() - 90_000) },
        })
        .project({ agent_id: 1 })
        .limit(50)
        .toArray();
      const uniq = new Set(stale.map((s) => (s.agent_id as ObjectId).toHexString()));
      for (const a of uniq) await reapStuckJobs(new ObjectId(a));
    } catch (err) {
      console.error("[worker] reap error", err);
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

  for (const c of candidates) {
    inFlight++;
    processTurnJob(c._id as ObjectId)
      .catch((err) => console.error("[worker] processTurnJob error", err))
      .finally(() => {
        inFlight--;
      });
  }
}

async function main() {
  console.log(
    `[worker] starting · maxConcurrent=${MAX_CONCURRENT} · pollMs=${POLL_INTERVAL_MS}`,
  );
  process.on("SIGTERM", () => {
    console.log("[worker] SIGTERM received; finishing in-flight jobs");
    shuttingDown = true;
  });
  process.on("SIGINT", () => {
    console.log("[worker] SIGINT received; finishing in-flight jobs");
    shuttingDown = true;
  });

  while (!shuttingDown) {
    try {
      await tick();
    } catch (err) {
      console.error("[worker] tick error", err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  while (inFlight > 0) {
    console.log(`[worker] waiting on ${inFlight} job(s) before exit`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("[worker] clean exit");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
