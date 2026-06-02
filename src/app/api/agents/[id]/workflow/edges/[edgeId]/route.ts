/**
 * PATCH /api/agents/[id]/workflow/edges/[edgeId]
 *
 * UI-driven edge editor — used by the tool_call NodeInspector to
 * surface the incoming edge's `forward_condition` as the tool's "entry
 * condition", so the user edits "when does this tool fire?" from the
 * node they think of as the tool, not from a separate edge selection.
 *
 * Accepts a partial { label?, condition?, forward_condition? }. Updates
 * `config_cache.workflow.edges[i]`, re-serializes the workflow upstream,
 * and bumps revision. Preserves `workflow.bindings` (local-only field).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { patchAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import {
  composeSystemPromptWithWorkflow,
  toElevenWorkflow,
} from "@/lib/capabilities/experience/workflow";
import type { AgentConfigCache, WorkflowState } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EdgeForwardCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unconditional"), label: z.string().optional() }),
  z.object({
    type: z.literal("llm"),
    condition: z.string().min(1, "LLM condition cannot be empty"),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("expression"),
    expression: z.unknown(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal("result"),
    successful: z.boolean(),
    label: z.string().optional(),
  }),
]);

const Body = z
  .object({
    // `null` explicitly clears the edge-root label (pill text moves to
    // forward_condition.label). `undefined` keeps the current value.
    label: z.string().max(120).nullable().optional(),
    condition: z.string().optional(),
    forward_condition: EdgeForwardCondition.optional(),
    // `null` clears the backward (loop) condition; `undefined` keeps it.
    backward_condition: EdgeForwardCondition.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "empty patch");

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; edgeId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, edgeId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }

  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const idx = agent.config_cache.workflow.edges.findIndex((e) => e.id === edgeId);
  if (idx === -1) {
    return NextResponse.json(
      { error: `No edge with id "${edgeId}"` },
      { status: 404 },
    );
  }

  const current = agent.config_cache.workflow.edges[idx];
  // Keep the legacy `condition` string in lockstep with the structured
  // form so the inspector and the workflow validator agree. If the
  // caller updated only `condition` (legacy path), derive a forward_condition.
  // For label: explicit null clears it (pill text moves to
  // forward_condition.label); undefined keeps the current value.
  const nextLabel =
    parsed.data.label === null
      ? undefined
      : parsed.data.label ?? current.label;
  let nextForward = parsed.data.forward_condition ?? current.forward_condition;
  let nextCondition = parsed.data.condition ?? current.condition;
  if (parsed.data.forward_condition) {
    nextCondition =
      parsed.data.forward_condition.type === "llm"
        ? parsed.data.forward_condition.condition
        : undefined;
  } else if (parsed.data.condition !== undefined) {
    if (parsed.data.condition.trim().length > 0) {
      nextForward = { type: "llm", condition: parsed.data.condition.trim() };
    } else {
      nextForward = { type: "unconditional" };
      nextCondition = undefined;
    }
  }
  // Backward (loop) condition: null clears, a value sets, absent keeps.
  const nextBackward =
    parsed.data.backward_condition === null
      ? undefined
      : parsed.data.backward_condition ?? current.backward_condition;
  const updatedEdge = {
    ...current,
    label: nextLabel,
    condition: nextCondition,
    forward_condition: nextForward,
    backward_condition: nextBackward,
  };
  const nextEdges = [...agent.config_cache.workflow.edges];
  nextEdges[idx] = updatedEdge;
  const nextWorkflow: WorkflowState = {
    nodes: agent.config_cache.workflow.nodes,
    edges: nextEdges,
    // Preserve bindings — local-only field, would silently zero out
    // config.tools on the next derive otherwise.
    ...(agent.config_cache.workflow.bindings !== undefined
      ? { bindings: agent.config_cache.workflow.bindings }
      : {}),
  };
  const nextSystemPrompt = composeSystemPromptWithWorkflow(
    agent.config_cache.system_prompt,
  );
  const workflowPatch = toElevenWorkflow(nextWorkflow);

  try {
    await patchAgent(agent.elevenlabs_agent_id, {
      workflow: workflowPatch,
      ...(nextSystemPrompt !== agent.config_cache.system_prompt
        ? { system_prompt: nextSystemPrompt }
        : {}),
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status === 404 ? 404 : 502 },
      );
    }
    throw err;
  }

  const nextConfig: AgentConfigCache = {
    ...agent.config_cache,
    workflow: nextWorkflow,
    system_prompt: nextSystemPrompt,
  };
  const nextRevision = agent.revision + 1;
  await agents.updateOne(
    { _id, revision: agent.revision },
    {
      $set: {
        config_cache: nextConfig,
        revision: nextRevision,
        updated_at: new Date(),
      },
    },
  );

  await (await messagesCol()).insertOne({
    agent_id: agent._id,
    role: "system",
    content: [
      {
        type: "text",
        text: `Updated workflow edge "${edgeId}" (transition) from the panel.`,
      },
    ],
    turn_job_id: null,
    revision_before: agent.revision,
    revision_after: nextRevision,
    created_at: new Date(),
    panel_action: true,
  } as never);

  return NextResponse.json({
    revision: nextRevision,
    patch: { workflow: nextWorkflow, system_prompt: nextSystemPrompt },
  });
}
