import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
import { requireSharedSecret } from "@/lib/auth";
import {
  getAgent,
  projectAgentConfig,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type { AgentDocument, AgentDTO } from "@/types/agent";

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
  const col = await agentsCol();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let freshened = doc;
  try {
    const el = await getAgent(doc.elevenlabs_agent_id);
    const projected = projectAgentConfig(el, doc.config_cache);
    if (JSON.stringify(projected) !== JSON.stringify(doc.config_cache)) {
      const updated = await col.findOneAndUpdate(
        { _id: doc._id },
        {
          $set: {
            config_cache: projected,
            updated_at: new Date(),
          },
        },
        { returnDocument: "after" },
      );
      if (updated) freshened = updated;
    }
  } catch (err) {
    // Keep serving cached config — ElevenLabs unreachable shouldn't kill the page.
    if (!(err instanceof ElevenLabsError)) throw err;
  }

  const dto: AgentDTO = {
    id: freshened._id.toHexString(),
    elevenlabs_agent_id: freshened.elevenlabs_agent_id,
    name: freshened.name,
    description: freshened.description,
    revision: freshened.revision,
    config_cache: freshened.config_cache,
    last_error: freshened.last_error,
    created_at: freshened.created_at.toISOString(),
    updated_at: freshened.updated_at.toISOString(),
  };
  return NextResponse.json(dto);
}

export type AgentRouteDoc = AgentDocument;
