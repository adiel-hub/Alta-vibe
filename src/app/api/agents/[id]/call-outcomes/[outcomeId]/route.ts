import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { patchAgent, ElevenLabsError } from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  prompt: z.string().min(10).max(2000).optional(),
  use_knowledge_base: z.boolean().optional(),
  scope: z.enum(["conversation", "agent"]).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; outcomeId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, outcomeId } = await params;
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

  const idx = agent.config_cache.evaluation_criteria.findIndex(
    (c) => c.id === outcomeId,
  );
  if (idx === -1) {
    return NextResponse.json(
      { error: "Call outcome not found" },
      { status: 404 },
    );
  }

  const current = agent.config_cache.evaluation_criteria[idx];
  const merged = {
    ...current,
    ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
    ...(parsed.data.prompt !== undefined ? { prompt: parsed.data.prompt } : {}),
    ...(parsed.data.use_knowledge_base !== undefined
      ? { use_knowledge_base: parsed.data.use_knowledge_base }
      : {}),
    ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
  };
  const next = [...agent.config_cache.evaluation_criteria];
  next[idx] = merged;

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
    return NextResponse.json({
      revision: updated?.revision ?? agent.revision + 1,
      patch: { evaluation_criteria: next },
      outcome: merged,
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
  { params }: { params: Promise<{ id: string; outcomeId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, outcomeId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const removed = agent.config_cache.evaluation_criteria.find(
    (c) => c.id === outcomeId,
  );
  if (!removed) {
    return NextResponse.json(
      { error: "Call outcome not found" },
      { status: 404 },
    );
  }
  const next = agent.config_cache.evaluation_criteria.filter(
    (c) => c.id !== outcomeId,
  );

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
      content: [
        { type: "text", text: `Removed call outcome "${removed.name}".` },
      ],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
    } as never);
    return NextResponse.json({
      revision: newRevision,
      patch: { evaluation_criteria: next },
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
