import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { widgetActionsCol } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; actionId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, actionId } = await params;
  if (!ObjectId.isValid(id) || !ObjectId.isValid(actionId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const action = await (await widgetActionsCol()).findOne({
    _id: new ObjectId(actionId),
    agent_id: new ObjectId(id),
  });
  if (!action) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    id: action._id.toHexString(),
    kind: action.kind,
    payload: action.payload,
    status: action.status,
    result: action.result,
    created_at: action.created_at.toISOString(),
    resolved_at: action.resolved_at?.toISOString() ?? null,
  });
}
