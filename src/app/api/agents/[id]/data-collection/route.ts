/**
 * Data-collection field CRUD — the typed-value extraction parallel to
 * call outcomes. While `evaluation_criteria` are scored success/failure/
 * unknown, `data_collection` produces concrete values (string / number /
 * boolean) that show up under `analysis.data_collection_results` on the
 * call log.
 *
 * Mirrors `call-outcomes/route.ts`; differences:
 *   - body has `type` (string|number|boolean) instead of prompt/scope/kb.
 *   - upstream field is `data_collection` (a Record keyed by name), so we
 *     send `{ [name]: { type, description } }` on PATCH.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { patchAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import type { DataCollectionField } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Field ids derive from the name so call logs reference the same id
 *  across renames. Kept identical to the call-outcomes slugifier so the
 *  two surfaces feel consistent. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Build the wire-shape Record ElevenLabs expects. For enum fields we ALSO
 * append a "must be one of: …" hint to the description so the LLM extractor
 * respects the constraint even if upstream silently ignores the enum field
 * (the JSON-schema enum keyword isn't officially documented for ElevenLabs
 * data_collection at time of writing).
 */
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

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().min(1).max(500),
  /** Optional value constraint. Only meaningful for `string` (and `number`/
   *  `integer` when the upstream LLM coerces the matched literal). Sent on the
   *  wire AND folded into the description so extractors honour it. */
  enum: z.array(z.string().min(1)).min(1).max(50).optional(),
});

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
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    revision: agent.revision,
    data_collection: agent.config_cache.data_collection,
  });
}

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
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
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

  const existing = agent.config_cache.data_collection;
  // Use the slug as both the row id AND the upstream key on ElevenLabs'
  // Record-keyed data_collection map. Collision-resolve with a numeric
  // suffix to keep names unique without surprising the caller.
  const baseSlug = slugify(parsed.data.name) || `field_${existing.length + 1}`;
  let fieldId = baseSlug;
  let n = 2;
  const taken = new Set(existing.map((d) => d.id));
  while (taken.has(fieldId)) {
    fieldId = `${baseSlug}_${n++}`;
  }

  const entry: DataCollectionField = {
    id: fieldId,
    name: fieldId,
    type: parsed.data.type,
    description: parsed.data.description,
    ...(parsed.data.enum && parsed.data.enum.length > 0
      ? { enum: parsed.data.enum }
      : {}),
  };
  const next = [...existing, entry];

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
        { type: "text", text: `Added data field "${entry.name}".` },
      ],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
      panel_action: true,
    } as never);
    return NextResponse.json({
      revision: newRevision,
      patch: { data_collection: next },
      field: entry,
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
