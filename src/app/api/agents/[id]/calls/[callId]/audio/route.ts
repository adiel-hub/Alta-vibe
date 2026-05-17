import { type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { fetchConversationAudio } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; callId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, callId } = await params;
  if (!ObjectId.isValid(id)) {
    return new Response(JSON.stringify({ error: "Invalid id" }), { status: 400 });
  }
  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

  try {
    const upstream = await fetchConversationAudio(callId);
    return new Response(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  }
}
