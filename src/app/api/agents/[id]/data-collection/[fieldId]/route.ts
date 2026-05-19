import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { patchAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import type { DataCollectionField } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See sibling route.ts — enum is folded into the description so the LLM
 *  extractor honours it even if ElevenLabs ignores the wire field. */
function toUpstreamMap(fields: DataCollectionField[]) {
  return Object.fromEntries(
    fields.map((f) => {
      const descriptionWithEnum =
        f.enum && f.enum.length > 0
          ? `${f.description}\n\nMust be exactly one of: ${f.enum.join(", ")}.`
          : f.description;
      return [
        f.name,
        {
          type: f.type,
          description: descriptionWithEnum,
          ...(f.enum && f.enum.length > 0 ? { enum: f.enum } : {}),
        },
      ];
    }),
  );
}

const PatchBody = z.object({
  type: z.enum(["string", "number", "integer", "boolean"]).optional(),
  description: z.string().min(1).max(500).optional(),
  /** Pass `[]` (or omit) to clear the enum constraint; pass `[...values]` to
   *  set/replace it. PATCH semantics: undefined leaves it as-is. */
  enum: z.array(z.string().min(1)).max(50).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; fieldId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, fieldId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const idx = agent.config_cache.data_collection.findIndex(
    (d) => d.id === fieldId,
  );
  if (idx === -1) {
    return NextResponse.json(
      { error: "Data field not found" },
      { status: 404 },
    );
  }

  const current = agent.config_cache.data_collection[idx];
  // We intentionally don't allow renaming the field. The id IS the upstream
  // key, and renames would orphan historical data_collection_results rows.
  // Type + description + enum are the safe-to-edit surface; if a user wants
  // a new name they can delete + recreate. Passing `enum: []` explicitly
  // clears the constraint; omitting it leaves the existing one in place.
  const enumPatch =
    parsed.data.enum === undefined
      ? {}
      : parsed.data.enum.length === 0
        ? { enum: undefined }
        : { enum: parsed.data.enum };
  const merged: DataCollectionField = {
    ...current,
    ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
    ...(parsed.data.description !== undefined
      ? { description: parsed.data.description }
      : {}),
    ...enumPatch,
  };
  // Strip enum from the persisted row when it's been cleared, so the wire
  // shape doesn't carry `enum: undefined` keys forward.
  if (merged.enum === undefined) delete (merged as { enum?: string[] }).enum;
  const next = [...agent.config_cache.data_collection];
  next[idx] = merged;

  try {
    await patchAgent(agent.elevenlabs_agent_id, {
      data_collection: toUpstreamMap(next),
    });
    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.data_collection": next,
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    return NextResponse.json({
      revision: updated?.revision ?? agent.revision + 1,
      patch: { data_collection: next },
      field: merged,
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
  { params }: { params: Promise<{ id: string; fieldId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, fieldId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const removed = agent.config_cache.data_collection.find(
    (d) => d.id === fieldId,
  );
  if (!removed) {
    return NextResponse.json(
      { error: "Data field not found" },
      { status: 404 },
    );
  }
  const next = agent.config_cache.data_collection.filter(
    (d) => d.id !== fieldId,
  );

  try {
    await patchAgent(agent.elevenlabs_agent_id, {
      data_collection: toUpstreamMap(next),
    });
    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.data_collection": next,
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
        { type: "text", text: `Removed data field "${removed.name}".` },
      ],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
      panel_action: true,
    } as never);
    return NextResponse.json({
      revision: newRevision,
      patch: { data_collection: next },
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
