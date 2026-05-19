/**
 * POST /api/agents/[id]/workflow
 *
 * UI-driven node creation. Mirrors the workflow_add_node chat tool so the
 * panel's hover-revealed "+ add node" action and its popup picker can grow
 * the graph from the canvas. Optional `after_node_id` wires the new node
 * downstream of an existing one in the same call.
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
import type {
  AgentConfigCache,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowState,
} from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NODE_TYPES: WorkflowNodeType[] = [
  "start",
  "speak",
  "collect",
  "condition",
  "tool_call",
  "transfer",
  "end",
];

const Body = z
  .object({
    type: z.enum(NODE_TYPES as [WorkflowNodeType, ...WorkflowNodeType[]]),
    label: z.string().min(1).max(120),
    data: z.record(z.string(), z.unknown()).optional(),
    after_node_id: z.string().optional(),
    edge_label: z.string().optional(),
  })
  .strict();

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
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

  if (
    parsed.data.after_node_id &&
    !agent.config_cache.workflow.nodes.some(
      (n) => n.id === parsed.data.after_node_id,
    )
  ) {
    return NextResponse.json(
      { error: `after_node_id "${parsed.data.after_node_id}" does not exist.` },
      { status: 400 },
    );
  }

  const node: WorkflowNode = {
    id: newId(parsed.data.type),
    type: parsed.data.type,
    label: parsed.data.label,
    data: parsed.data.data ?? {},
  };
  const edges: WorkflowEdge[] = [...agent.config_cache.workflow.edges];
  if (parsed.data.after_node_id) {
    const sourceId = parsed.data.after_node_id;
    // ElevenLabs validates: a single source node may have AT MOST ONE
    // unconditional outgoing edge (anything more would make the runtime's
    // branch picker ambiguous). If the source already has one, "add
    // downstream" from the UI means SPLICE — re-point the existing
    // unconditional edge to come from the new node instead, then wire
    // parent → newNode. That preserves the user's chain while inserting
    // the tool in the middle, exactly as the "+" button visually suggests.
    // If the source has no unconditional edge yet (terminal node, or a
    // pure router with only conditional edges), just append.
    const unconditionalIdx = edges.findIndex(
      (e) =>
        e.from === sourceId &&
        (!e.condition || e.condition.trim().length === 0),
    );
    if (unconditionalIdx !== -1) {
      const existing = edges[unconditionalIdx];
      edges[unconditionalIdx] = { ...existing, from: node.id };
    }
    edges.push({
      id: newId("edge"),
      from: sourceId,
      to: node.id,
      label: parsed.data.edge_label,
    });
  }
  const nextWorkflow: WorkflowState = {
    nodes: [...agent.config_cache.workflow.nodes, node],
    edges,
  };
  // Strip any legacy "--- WORKFLOW ---" footer the prompt may still carry,
  // and push the structured workflow to conversation_config.workflow so the
  // ElevenAgents runtime walks the graph itself.
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
        text: `Added workflow node "${node.label}" (${node.id}) from the panel.`,
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
    node,
  });
}
