import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { turnJobsCol } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const jobs = await turnJobsCol();
  const active = await jobs
    .find({ agent_id: new ObjectId(id), status: { $in: ["queued", "running"] } })
    .sort({ started_at: -1 })
    .limit(1)
    .next();
  if (!active) return NextResponse.json({ active: null });
  return NextResponse.json({
    active: {
      id: active._id.toHexString(),
      status: active.status,
      user_message: active.user_message,
      started_at: active.started_at.toISOString(),
    },
  });
}
