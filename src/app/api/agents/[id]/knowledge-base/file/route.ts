import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import {
  createKbFromFile,
  patchAgent,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type { KnowledgeBaseDocument } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  const filename =
    (file instanceof File && file.name) ||
    (typeof form?.get("filename") === "string" && (form.get("filename") as string)) ||
    "upload.bin";

  const col = await agentsCol();
  const agent = await col.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const doc = await createKbFromFile({ file, filename, name: filename });
    const entry: KnowledgeBaseDocument = {
      id: doc.id,
      name: doc.name,
      type: "file",
      source: filename,
    };
    const nextKb = [...agent.config_cache.knowledge_base, entry];
    await patchAgent(agent.elevenlabs_agent_id, {
      knowledge_base: nextKb.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    });

    const updated = await col.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          config_cache: { ...agent.config_cache, knowledge_base: nextKb },
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    // Drop a synthetic assistant note into the transcript so the chat side
    // stays coherent with the panel-driven upload.
    const messages = await messagesCol();
    await messages.insertOne({
      agent_id: _id,
      role: "assistant",
      content: [
        { type: "text", text: `Uploaded "${filename}" to your knowledge base.` },
      ],
      revision_before: agent.revision,
      revision_after: agent.revision + 1,
      created_at: new Date(),
    } as never);

    return NextResponse.json({
      revision: updated?.revision ?? agent.revision + 1,
      patch: { knowledge_base: nextKb },
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
