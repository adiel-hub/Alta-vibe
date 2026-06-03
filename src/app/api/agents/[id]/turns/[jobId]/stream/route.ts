/**
 * SSE tail for a turn job. Replays all events with seq >= `since` (default 0),
 * then polls Mongo every 250 ms for new events until the job's status is
 * terminal (done/failed). Designed to be re-attachable: refresh the page and
 * the client passes its highest-seen seq to pick up exactly where it left off.
 */
import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { requireSharedSecret } from "@/lib/auth";
import { turnJobsCol } from "@/lib/mongodb";
import { encodeComment, SSE_HEADERS } from "@/lib/sse";
import { createLogger, newRequestId } from "@/lib/logger";
import type { StoredTurnEvent } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 800;

function encodeEvent(stored: StoredTurnEvent): Uint8Array {
  const enc = new TextEncoder();
  const lines = [
    `id: ${stored.seq}`,
    `event: ${stored.event.type}`,
    `data: ${JSON.stringify(stored.event)}`,
    "",
    "",
  ];
  return enc.encode(lines.join("\n"));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, jobId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(jobId)) {
    return new Response(JSON.stringify({ error: "Invalid id" }), { status: 400 });
  }
  const _id = new ObjectId(id);
  const _jobId = new ObjectId(jobId);
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
  const log = createLogger("sse", {
    route: "GET /turns/[jobId]/stream",
    req_id: newRequestId(),
    job_id: jobId,
    agent_id: id,
    since,
  });
  log.info("attach");

  const jobs = await turnJobsCol();
  const initial = await jobs.findOne({ _id: _jobId, agent_id: _id });
  if (!initial) {
    log.warn("job not found");
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }
  log.debug("initial job state", {
    status: initial.status,
    events_so_far: initial.events.length,
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSeq = since - 1;
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      req.signal.addEventListener("abort", () => {
        log.debug("client disconnected", { last_seq: lastSeq });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      const drain = async () => {
        const fresh = await jobs.findOne({ _id: _jobId });
        if (!fresh) return { done: true, emitted: false };
        let emitted = false;
        for (const ev of fresh.events) {
          if (ev.seq > lastSeq) {
            safeEnqueue(encodeEvent(ev));
            lastSeq = ev.seq;
            emitted = true;
          }
        }
        return {
          done: fresh.status === "done" || fresh.status === "failed",
          emitted,
        };
      };

      // Heartbeat: Vercel's edge terminates a streaming response that goes
      // idle (no bytes) during the quiet gaps between events — e.g. while the
      // worker is crawling a site or indexing the knowledge base. The browser
      // then sees the stream close and (with the client's reconnect) re-attaches,
      // but keeping the socket warm avoids the drop in the first place. Comments
      // (`: …`) are ignored by the client's parseBlock, so they're inert.
      // 250ms poll × 60 ticks ≈ 15s of silence between pings.
      const PING_EVERY_TICKS = 60;

      try {
        // initial fast drain
        const first = await drain();
        if (first.done) {
          safeEnqueue(encodeComment("turn complete"));
          if (!closed) controller.close();
          return;
        }
        // Prime the connection with a comment so there's traffic from the start.
        safeEnqueue(encodeComment("ping"));
        // poll loop
        let idleTicks = 0;
        while (!closed) {
          await new Promise((r) => setTimeout(r, 250));
          if (closed) break;
          const res = await drain();
          if (res.done) break;
          if (res.emitted) {
            idleTicks = 0;
          } else if (++idleTicks >= PING_EVERY_TICKS) {
            idleTicks = 0;
            safeEnqueue(encodeComment("ping"));
          }
        }
        if (!closed) {
          log.info("turn complete; closing stream", { last_seq: lastSeq });
          safeEnqueue(encodeComment("turn complete"));
          controller.close();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "stream failed";
        log.error("stream error", { message });
        safeEnqueue(encodeComment(`error: ${message}`));
        try {
          controller.close();
        } catch {
          /* */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
