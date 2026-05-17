import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import {
  deleteKbDocument,
  patchAgent,
  renameKbDocument,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, docId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const Body = z.object({ name: z.string().min(1).max(120) });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await renameKbDocument(docId, parsed.data.name);
    const nextKb = agent.config_cache.knowledge_base.map((d) =>
      d.id === docId ? { ...d, name: parsed.data.name } : d,
    );
    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.knowledge_base": nextKb,
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, docId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const nextKb = agent.config_cache.knowledge_base.filter((d) => d.id !== docId);
    await patchAgent(agent.elevenlabs_agent_id, {
      knowledge_base: nextKb.map((d) => ({ id: d.id, name: d.name, type: d.type })),
    });
    await deleteKbDocument(docId).catch(() => {});

    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.knowledge_base": nextKb,
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    const newRevision = updated?.revision ?? agent.revision + 1;

    await (await messagesCol()).insertOne({
      agent_id: _id,
      role: "assistant",
      content: [
        { type: "text", text: `Removed a knowledge base document from the panel.` },
      ],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
    } as never);

    return NextResponse.json({
      revision: newRevision,
      patch: { knowledge_base: nextKb },
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
