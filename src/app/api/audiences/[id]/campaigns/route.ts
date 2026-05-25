/**
 * GET /api/audiences/[id]/campaigns — list campaigns for this audience.
 * POST /api/audiences/[id]/campaigns — start a new campaign.
 *
 * Start body: { agent_id, agent_phone_number_id, concurrency? }
 *   - agent_id is the Mongo _id of the agent (not the ElevenLabs id).
 *   - concurrency is hard-capped at 1 in v1 (sequential auto-dial).
 *
 * The runner is fired-and-continued via `after()` so the POST returns
 * immediately with the new campaign id and the client can attach to the
 * SSE stream.
 */
import { NextResponse, type NextRequest, after } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import {
  agentsCol,
  audiencesCol,
  callCampaignsCol,
  prospectsCol,
} from "@/lib/mongodb";
import { runCampaign } from "@/lib/calls/campaign";
import { createLogger, newRequestId } from "@/lib/logger";
import type { CampaignItem, CallCampaignDocument } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const StartBody = z.object({
  agent_id: z.string().min(1),
  agent_phone_number_id: z.string().min(1),
  concurrency: z.number().int().min(1).max(4).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("campaigns", {
    route: "GET /audiences/[id]/campaigns",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const campaigns = await callCampaignsCol();
    // project({ events: 0 }) drops the typed shape — cast back to the
    // doc type minus the projected-away field.
    const rows = (await campaigns
      .find({ audience_id: new ObjectId(id) })
      .sort({ created_at: -1 })
      .limit(50)
      .project({ events: 0 })
      .toArray()) as unknown as Omit<CallCampaignDocument, "events">[];
    const data = rows.map((r) => ({
      id: r._id.toHexString(),
      audience_id: r.audience_id.toHexString(),
      agent_id: r.agent_id.toHexString(),
      status: r.status,
      total: r.items.length,
      completed: r.items.filter((i: CampaignItem) => i.status === "done").length,
      failed: r.items.filter((i: CampaignItem) => i.status === "failed").length,
      skipped: r.items.filter((i: CampaignItem) => i.status === "skipped")
        .length,
      created_at: r.created_at.toISOString(),
      started_at: r.started_at?.toISOString() ?? null,
      ended_at: r.ended_at?.toISOString() ?? null,
    }));
    log.info("ok", { audience_id: id, count: data.length });
    return NextResponse.json({ campaigns: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { audience_id: id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("campaigns", {
    route: "POST /audiences/[id]/campaigns",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = StartBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  if (!ObjectId.isValid(parsed.data.agent_id)) {
    return NextResponse.json({ error: "Invalid agent_id" }, { status: 400 });
  }
  try {
    const audiences = await audiencesCol();
    const audience = await audiences.findOne({ _id: new ObjectId(id) });
    if (!audience) {
      return NextResponse.json({ error: "Audience not found" }, { status: 404 });
    }
    if (audience.prospect_ids.length === 0) {
      return NextResponse.json(
        { error: "Audience has no prospects" },
        { status: 400 },
      );
    }
    const agents = await agentsCol();
    const agent = await agents.findOne({
      _id: new ObjectId(parsed.data.agent_id),
    });
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    const phoneOk = agent.config_cache.phone_numbers.some(
      (p) => p.id === parsed.data.agent_phone_number_id,
    );
    if (!phoneOk) {
      return NextResponse.json(
        { error: "agent_phone_number_id not attached to this agent" },
        { status: 400 },
      );
    }

    // Materialise items from the audience's prospect list. Snapshot the
    // phone number so a later edit of the prospect doesn't redirect a
    // call that's already queued.
    const prospects = await prospectsCol();
    const prospectDocs = await prospects
      .find({ _id: { $in: audience.prospect_ids } })
      .toArray();
    const byId = new Map(prospectDocs.map((p) => [p._id.toHexString(), p]));
    const items: CampaignItem[] = [];
    for (const pid of audience.prospect_ids) {
      const p = byId.get(pid.toHexString());
      if (!p) continue;
      items.push({
        prospect_id: p._id,
        to_number: p.mobile_phone ?? "",
        status: "queued",
        conversation_id: null,
        error: null,
        started_at: null,
        ended_at: null,
      });
    }

    const campaigns = await callCampaignsCol();
    const now = new Date();
    const insert = await campaigns.insertOne({
      audience_id: audience._id,
      agent_id: agent._id,
      agent_phone_number_id: parsed.data.agent_phone_number_id,
      status: "queued",
      concurrency: 1,
      items,
      events: [],
      next_seq: 0,
      last_event_at: now,
      created_at: now,
      started_at: null,
      ended_at: null,
    } as never);
    log.info("queued", {
      campaign_id: insert.insertedId.toHexString(),
      total_items: items.length,
    });

    after(async () => {
      try {
        await runCampaign(insert.insertedId);
      } catch (err) {
        log.error("runner crashed", {
          campaign_id: insert.insertedId.toHexString(),
          message: err instanceof Error ? err.message : "unknown",
        });
      }
    });

    return NextResponse.json({
      id: insert.insertedId.toHexString(),
      status: "queued",
      total: items.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { audience_id: id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
