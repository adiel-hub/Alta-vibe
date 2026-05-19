import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  ElevenLabsError,
  listPhoneNumbersForAgent,
} from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the phone numbers currently assigned to THIS agent in ElevenLabs.
 * Source of truth: `GET /v1/convai/phone-numbers` (filtered by
 * `assigned_agent.agent_id`) — the agent GET response doesn't reliably
 * include `phone_numbers`, so we list the workspace and filter ourselves.
 */
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
  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const nums = await listPhoneNumbersForAgent(agent.elevenlabs_agent_id);
    return NextResponse.json(nums);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "List failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
