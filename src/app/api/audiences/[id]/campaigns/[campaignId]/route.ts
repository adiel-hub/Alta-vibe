/**
 * GET /api/audiences/[id]/campaigns/[campaignId] — full campaign state
 *   (status + per-item progress). Used by the detail page for the initial
 *   render before the SSE stream takes over.
 *
 * POST /api/audiences/[id]/campaigns/[campaignId] — body { action: "cancel" }
 *   transitions queued|running → cancelled. The runner picks up the flag
 *   between items.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { callCampaignsCol, prospectsCol } from "@/lib/mongodb";
import { cancelCampaign } from "@/lib/calls/campaign";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; campaignId: string }> },
) {
  const log = createLogger("campaign", {
    route: "GET /audiences/[id]/campaigns/[campaignId]",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id, campaignId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(campaignId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const campaigns = await callCampaignsCol();
    const campaign = await campaigns.findOne({
      _id: new ObjectId(campaignId),
      audience_id: new ObjectId(id),
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const prospects = await prospectsCol();
    const ids = campaign.items.map((i) => i.prospect_id);
    const docs =
      ids.length > 0 ? await prospects.find({ _id: { $in: ids } }).toArray() : [];
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    log.info("ok", { campaign_id: campaignId, status: campaign.status });
    return NextResponse.json({
      id: campaign._id.toHexString(),
      audience_id: campaign.audience_id.toHexString(),
      agent_id: campaign.agent_id.toHexString(),
      agent_phone_number_id: campaign.agent_phone_number_id,
      status: campaign.status,
      created_at: campaign.created_at.toISOString(),
      started_at: campaign.started_at?.toISOString() ?? null,
      ended_at: campaign.ended_at?.toISOString() ?? null,
      next_seq: campaign.next_seq,
      items: campaign.items.map((it) => {
        const p = byId.get(it.prospect_id.toHexString());
        return {
          prospect_id: it.prospect_id.toHexString(),
          full_name: p?.full_name ?? "(unknown)",
          job_title: p?.job_title ?? null,
          job_company_name: p?.job_company_name ?? null,
          to_number: it.to_number,
          status: it.status,
          conversation_id: it.conversation_id,
          error: it.error,
          started_at: it.started_at?.toISOString() ?? null,
          ended_at: it.ended_at?.toISOString() ?? null,
        };
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { campaign_id: campaignId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const ActionBody = z.object({
  action: z.enum(["cancel"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; campaignId: string }> },
) {
  const log = createLogger("campaign", {
    route: "POST /audiences/[id]/campaigns/[campaignId]",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id, campaignId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(campaignId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = ActionBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  try {
    if (parsed.data.action === "cancel") {
      await cancelCampaign(new ObjectId(campaignId));
      log.info("cancel requested", { campaign_id: campaignId });
      return NextResponse.json({ ok: true, status: "cancelled" });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { campaign_id: campaignId, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
