/**
 * POST /api/agents/:id/integrations/:provider/disconnect
 *
 * Workspace-scoped disconnect surface for the connect_integration widget
 * UI. Mirrors the chat-driven `disconnect_integration` capability: marks
 * the workspace `integrations` row as disconnected and strips the
 * provider's runtime tools from THIS agent. Used when the user opens the
 * connect widget while the workspace already has the provider connected
 * and chooses to disconnect.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { disconnectProviderForAgent } from "@/lib/integrations/registerProviderTools";
import { ElevenLabsError, patchAgent } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; provider: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, provider } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (!provider || provider.length === 0) {
    return NextResponse.json({ error: "Missing provider" }, { status: 400 });
  }

  try {
    const result = await disconnectProviderForAgent(id, provider);
    const agents = await agentsCol();
    const agent = await agents.findOne({ _id: new ObjectId(id) });
    if (agent) {
      await patchAgent(agent.elevenlabs_agent_id, result.upstreamPatch);
    }
    const { upstreamPatch: _upstreamPatch, ...response } = result;
    void _upstreamPatch;
    return NextResponse.json(response);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
