import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { getKbDocumentContent, ElevenLabsError } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[id]/knowledge-base/[docId]/content
 *
 * Returns the indexed plain-text content of a KB document — what the agent
 * actually sees when this doc is retrieved during a call.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, docId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Confirm the doc belongs to an agent the caller actually has access to.
  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const owns = agent.config_cache.knowledge_base.some((d) => d.id === docId);
  if (!owns)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const { content } = await getKbDocumentContent(docId);
    return NextResponse.json({ content });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status === 404 ? 404 : 502 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Fetch failed" },
      { status: 500 },
    );
  }
}
