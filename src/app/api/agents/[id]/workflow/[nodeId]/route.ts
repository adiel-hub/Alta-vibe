/**
 * UI-driven workflow node editor.
 *
 * Mirrors the `workflow_update_node` chat tool but accepts direct PATCHes
 * from the right-panel inspector. Updates the agent's `config_cache.workflow`
 * in Mongo, recomposes the workflow footer on the system prompt, and pushes
 * the new prompt to ElevenLabs.
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

const Body = z
  .object({
    label: z.string().min(1).max(120).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "empty patch");

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, nodeId } = await params;
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

  const idx = agent.config_cache.workflow.nodes.findIndex((n) => n.id === nodeId);
  if (idx === -1) {
    return NextResponse.json(
      { error: `No node with id "${nodeId}"` },
      { status: 404 },
    );
  }

  const current = agent.config_cache.workflow.nodes[idx];
  const updatedNode = {
    ...current,
    label: parsed.data.label ?? current.label,
    data: parsed.data.data ? { ...current.data, ...parsed.data.data } : current.data,
  };
  const nextNodes = [...agent.config_cache.workflow.nodes];
  nextNodes[idx] = updatedNode;
  const nextWorkflow: WorkflowState = {
    nodes: nextNodes,
    edges: agent.config_cache.workflow.edges,
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

  // Synthetic system message so the chat reflects the panel edit.
  await (await messagesCol()).insertOne({
    agent_id: agent._id,
    role: "system",
    content: [
      {
        type: "text",
        text: `Updated workflow node "${updatedNode.label}" (${nodeId}) from the panel.`,
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

/**
 * DELETE /api/agents/[id]/workflow/[nodeId]
 *
 * Removes a node from the workflow and any edges that touch it. Mirrors
 * the workflow_remove_node chat tool. Refuses to delete the start node so
 * the graph always has an entry point.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, nodeId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (nodeId === "start") {
    return NextResponse.json(
      { error: "Can't delete the start node." },
      { status: 400 },
    );
  }

  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const existing = agent.config_cache.workflow.nodes.find(
    (n) => n.id === nodeId,
  );
  if (!existing) {
    return NextResponse.json(
      { error: `No node with id "${nodeId}"` },
      { status: 404 },
    );
  }

  const nextWorkflow: WorkflowState = {
    nodes: agent.config_cache.workflow.nodes.filter((n) => n.id !== nodeId),
    edges: agent.config_cache.workflow.edges.filter(
      (e) => e.from !== nodeId && e.to !== nodeId,
    ),
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
        text: `Removed workflow node "${existing.label}" (${nodeId}) from the panel.`,
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
