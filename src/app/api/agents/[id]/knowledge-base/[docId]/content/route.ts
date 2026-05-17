import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { getKbDocumentContent, ElevenLabsError } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agents/[id]/knowledge-base/[docId]/content
 *
 * Returns the indexed plain-text content of a KB document — what the agent
 * actually sees when this doc is retrieved during a call.
 *
 * No ownership check: the shared-secret gate is enough for the prototype,
 * and the previous check raced against in-flight turns (the agent doc's
 * config_cache.knowledge_base is only persisted to Mongo when the turn
 * completes, so expanding a freshly-scraped doc mid-turn would 404).
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
