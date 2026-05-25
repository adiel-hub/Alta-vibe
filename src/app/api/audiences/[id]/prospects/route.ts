/**
 * DELETE /api/audiences/[id]/prospects — remove one or more prospects from
 * the audience. The prospect rows themselves stay in the `prospects`
 * collection so they can be reused in other audiences.
 *
 * Body: { prospect_ids: string[] }   (audience-local Mongo ids, not pdl_id)
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { audiencesCol } from "@/lib/mongodb";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  prospect_ids: z.array(z.string().min(1)).min(1).max(500),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("audience-prospects", {
    route: "DELETE /audiences/[id]/prospects",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const objectIds: ObjectId[] = parsed.data.prospect_ids
    .filter((s) => ObjectId.isValid(s))
    .map((s) => new ObjectId(s));
  if (objectIds.length === 0) {
    return NextResponse.json(
      { error: "No valid prospect ids" },
      { status: 400 },
    );
  }
  try {
    const audiences = await audiencesCol();
    const res = await audiences.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $pullAll: { prospect_ids: objectIds },
        $set: { updated_at: new Date() },
      },
      { returnDocument: "after" },
    );
    if (!res) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    log.info("removed", {
      id,
      requested: objectIds.length,
      remaining: res.prospect_ids.length,
    });
    return NextResponse.json({
      id: res._id.toHexString(),
      prospect_count: res.prospect_ids.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { id, message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
