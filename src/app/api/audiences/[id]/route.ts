/**
 * GET /api/audiences/[id] — audience metadata + the hydrated prospect list.
 * PATCH /api/audiences/[id] — rename / update description.
 * DELETE /api/audiences/[id] — remove the audience (prospects stay).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { audiencesCol, prospectsCol } from "@/lib/mongodb";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("audience", {
    route: "GET /audiences/[id]",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const audiences = await audiencesCol();
    const audience = await audiences.findOne({ _id: new ObjectId(id) });
    if (!audience) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const prospects = await prospectsCol();
    const docs =
      audience.prospect_ids.length > 0
        ? await prospects
            .find({ _id: { $in: audience.prospect_ids } })
            .toArray()
        : [];
    // Preserve the audience's stored ordering rather than mongo's natural
    // order — the user adds prospects in batches and the chronological
    // order is the only signal of "newest at the bottom".
    const byId = new Map(docs.map((d) => [d._id.toHexString(), d]));
    const ordered = audience.prospect_ids
      .map((id) => byId.get(id.toHexString()))
      .filter((d): d is NonNullable<typeof d> => Boolean(d));

    log.info("ok", {
      id,
      prospects: ordered.length,
      missing: audience.prospect_ids.length - ordered.length,
    });
    return NextResponse.json({
      id: audience._id.toHexString(),
      name: audience.name,
      description: audience.description,
      prospect_count: audience.prospect_ids.length,
      created_at: audience.created_at.toISOString(),
      updated_at: audience.updated_at.toISOString(),
      prospects: ordered.map((p) => ({
        id: p._id.toHexString(),
        pdl_id: p.pdl_id,
        full_name: p.full_name,
        job_title: p.job_title,
        job_company_name: p.job_company_name,
        location_name: p.location_name,
        mobile_phone: p.mobile_phone,
        email: p.email,
        linkedin_url: p.linkedin_url,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("audience", {
    route: "PATCH /audiences/[id]",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  try {
    const audiences = await audiencesCol();
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (parsed.data.name !== undefined) update.name = parsed.data.name.trim();
    if (parsed.data.description !== undefined)
      update.description = parsed.data.description;
    if (Object.keys(update).length === 1) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }
    const res = await audiences.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" },
    );
    if (!res) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    log.info("updated", { id, fields: Object.keys(update) });
    return NextResponse.json({
      id: res._id.toHexString(),
      name: res.name,
      description: res.description,
      prospect_count: res.prospect_ids.length,
      created_at: res.created_at.toISOString(),
      updated_at: res.updated_at.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("audience", {
    route: "DELETE /audiences/[id]",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const audiences = await audiencesCol();
    const res = await audiences.deleteOne({ _id: new ObjectId(id) });
    if (res.deletedCount === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    log.info("deleted", { id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
