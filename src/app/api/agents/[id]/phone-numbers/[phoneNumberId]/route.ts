import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  ElevenLabsError,
  updatePhoneNumber,
} from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Detach a phone number from THIS agent. Sends PATCH /v1/convai/phone-numbers/{id}
 * with `agent_id: null` upstream — the number stays in the workspace and can
 * be re-attached later. This is a detach, NOT a workspace-level delete; for
 * permanent deletion the user goes through the chat / `delete_phone_number`
 * tool, which is a destructive, irreversible action.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; phoneNumberId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, phoneNumberId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await updatePhoneNumber(phoneNumberId, { agent_id: null });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Detach failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
