/**
 * SSE tail for a call campaign. Replays all events with seq >= `since`,
 * then polls Mongo every 500 ms for new events until the campaign's
 * status is terminal (completed/cancelled/failed). Mirrors the turn-job
 * stream route so the client component can use the same attach pattern.
 */
import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { requireSharedSecret } from "@/lib/auth";
import { callCampaignsCol } from "@/lib/mongodb";
import { encodeComment, SSE_HEADERS } from "@/lib/sse";
import { createLogger, newRequestId } from "@/lib/logger";
import type { CampaignEvent } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 800;

function encodeEvent(stored: CampaignEvent): Uint8Array {
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
  { params }: { params: Promise<{ id: string; campaignId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id, campaignId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(campaignId)) {
    return new Response(JSON.stringify({ error: "Invalid id" }), { status: 400 });
  }
  const audienceId = new ObjectId(id);
  const _campaignId = new ObjectId(campaignId);
  const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
  const log = createLogger("campaign-sse", {
    route: "GET /audiences/[id]/campaigns/[campaignId]/stream",
    req_id: newRequestId(),
    campaign_id: campaignId,
    audience_id: id,
    since,
  });
  log.info("attach");

  const campaigns = await callCampaignsCol();
  const initial = await campaigns.findOne({
    _id: _campaignId,
    audience_id: audienceId,
  });
  if (!initial) {
    log.warn("campaign not found");
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

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

      const isTerminal = (s: string) =>
        s === "completed" || s === "cancelled" || s === "failed";

      const drain = async () => {
        const fresh = await campaigns.findOne({ _id: _campaignId });
        if (!fresh) return { done: true };
        for (const ev of fresh.events) {
          if (ev.seq > lastSeq) {
            safeEnqueue(encodeEvent(ev));
            lastSeq = ev.seq;
          }
        }
        return { done: isTerminal(fresh.status) };
      };

      try {
        const first = await drain();
        if (first.done) {
          safeEnqueue(encodeComment("campaign complete"));
          if (!closed) controller.close();
          return;
        }
        while (!closed) {
          await new Promise((r) => setTimeout(r, 500));
          if (closed) break;
          const res = await drain();
          if (res.done) break;
        }
        if (!closed) {
          log.info("campaign complete; closing stream", { last_seq: lastSeq });
          safeEnqueue(encodeComment("campaign complete"));
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
