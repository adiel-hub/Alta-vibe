import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { patchAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import type { EvaluationCriterion } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Outcome ids are derived from the name (snake_case, ascii). Keep the slug
// stable so call logs can reference the same id across rename operations.
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().min(10).max(2000),
  use_knowledge_base: z.boolean().optional(),
  scope: z.enum(["conversation", "agent"]).optional(),
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
    call_outcomes: agent.config_cache.evaluation_criteria,
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

  const existing = agent.config_cache.evaluation_criteria;
  const baseSlug = slugify(parsed.data.name) || `outcome_${existing.length + 1}`;
  let outcomeId = baseSlug;
  let n = 2;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(outcomeId)) {
    outcomeId = `${baseSlug}_${n++}`;
  }

  const entry: EvaluationCriterion = {
    id: outcomeId,
    name: parsed.data.name,
    prompt: parsed.data.prompt,
    use_knowledge_base: parsed.data.use_knowledge_base,
    scope: parsed.data.scope,
  };
  const next = [...existing, entry];

  try {
    await patchAgent(agent.elevenlabs_agent_id, { evaluation_criteria: next });
    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.evaluation_criteria": next,
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
      content: [{ type: "text", text: `Added call outcome "${entry.name}".` }],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
      panel_action: true,
    } as never);
    return NextResponse.json({
      revision: newRevision,
      patch: { evaluation_criteria: next },
      outcome: entry,
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
