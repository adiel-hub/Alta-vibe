/**
 * GET /api/audiences — list audiences (most recently updated first).
 * POST /api/audiences — create an empty audience by name.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { audiencesCol } from "@/lib/mongodb";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const log = createLogger("audiences", {
    route: "GET /audiences",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  try {
    const audiences = await audiencesCol();
    const rows = await audiences
      .find()
      .sort({ updated_at: -1 })
      .limit(200)
      .toArray();
    const payload = rows.map((r) => ({
      id: r._id.toHexString(),
      name: r.name,
      description: r.description,
      prospect_count: r.prospect_ids.length,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    }));
    log.info("ok", { count: payload.length });
    return NextResponse.json({ audiences: payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const log = createLogger("audiences", {
    route: "POST /audiences",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const name = parsed.data.name.trim();
  try {
    const audiences = await audiencesCol();
    const existing = await audiences.findOne({ name });
    if (existing) {
      return NextResponse.json(
        { error: `Audience "${name}" already exists` },
        { status: 409 },
      );
    }
    const now = new Date();
    const insert = await audiences.insertOne({
      name,
      description: parsed.data.description ?? "",
      prospect_ids: [],
      created_at: now,
      updated_at: now,
    } as never);
    log.info("created", { id: insert.insertedId.toHexString(), name });
    return NextResponse.json({
      id: insert.insertedId.toHexString(),
      name,
      description: parsed.data.description ?? "",
      prospect_count: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
