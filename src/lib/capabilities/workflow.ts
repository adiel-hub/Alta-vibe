/**
 * Workflow capability.
 *
 * The agent builds a conversation flow graph (start → speak → collect →
 * tool_call → condition → transfer → end) as it shapes the voice agent.
 * Nodes + edges live in `config_cache.workflow` and stream to the right
 * panel via state_patch events so the SVG visualizer fills in live.
 *
 * The workflow is also surfaced to the deployed voice agent through the
 * system prompt: tools here automatically re-render a "workflow context"
 * section onto the prompt so the deployed agent follows the graph at
 * runtime. A companion `client` runtime tool (`report_workflow_state`)
 * lets the deployed agent report its current node back to the browser
 * during a test call — see capabilities/workflow_tracking.ts.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type {
  ElevenWorkflow,
  ElevenWorkflowEdge,
  ElevenWorkflowNode,
} from "@/lib/elevenlabs/client";
import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowState,
} from "@/types/agent";
import { DEFAULT_WORKFLOW } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

/**
 * Translate our internal WorkflowState (arrays, our type names) into the
 * ElevenAgents `conversation_config.workflow` shape (object-keyed maps,
 * their type names). Used by every workflow-mutating path so the runtime
 * actually walks the graph instead of relying on prompt text.
 *
 * Mapping:
 *   start              → start
 *   speak / collect    → override_agent  (with additional_prompt)
 *   condition          → override_agent  (acts as a router via edge_order)
 *   tool_call          → dispatch_tool   (tool_id from data.tool_id)
 *   transfer           → agent_transfer | transfer_to_number  (data-dependent)
 *   end                → end
 *
 * Edges:
 *   our edge.condition (non-empty) → forward_condition: { type: "llm", condition }
 *   else                            → forward_condition: { type: "unconditional" }
 *   our edge.label  is preserved on the ElevenLabs side as `label` (passthrough).
 */
export function toElevenWorkflow(w: WorkflowState): ElevenWorkflow {
  const outgoingByNode = new Map<string, WorkflowEdge[]>();
  for (const e of w.edges) {
    const list = outgoingByNode.get(e.from) ?? [];
    list.push(e);
    outgoingByNode.set(e.from, list);
  }

  const nodes: Record<string, ElevenWorkflowNode> = {};
  for (const n of w.nodes) {
    const out = outgoingByNode.get(n.id) ?? [];
    const edgeOrder = out.map((e) => e.id);
    const base: ElevenWorkflowNode = { type: "end", edge_order: edgeOrder };
    if (n.label) base.label = n.label;

    switch (n.type) {
      case "start":
        base.type = "start";
        break;
      case "end":
        base.type = "end";
        break;
      case "speak":
      case "collect":
      case "condition": {
        base.type = "override_agent";
        const prompt =
          (n.data?.prompt as string | undefined) ??
          (n.data?.instruction as string | undefined) ??
          (n.data?.expression as string | undefined);
        if (prompt) base.additional_prompt = prompt;
        // Pass through any tool / KB / voice overrides verbatim if present.
        for (const k of [
          "system_prompt_override",
          "llm",
          "voice_id",
          "knowledge_base_overrides",
          "tool_overrides",
        ] as const) {
          if (n.data?.[k] !== undefined) base[k] = n.data[k];
        }
        break;
      }
      case "tool_call": {
        base.type = "dispatch_tool";
        if (n.data?.tool_id) base.tool_id = n.data.tool_id;
        if (n.data?.instruction) base.additional_prompt = n.data.instruction;
        break;
      }
      case "transfer": {
        if (n.data?.phone_number) {
          base.type = "transfer_to_number";
          base.phone_number = n.data.phone_number;
        } else {
          base.type = "agent_transfer";
          if (n.data?.target_agent_id)
            base.target_agent_id = n.data.target_agent_id;
        }
        break;
      }
    }
    nodes[n.id] = base;
  }

  const edges: Record<string, ElevenWorkflowEdge> = {};
  for (const e of w.edges) {
    const forward_condition: ElevenWorkflowEdge["forward_condition"] =
      e.condition && e.condition.trim().length > 0
        ? { type: "llm", condition: e.condition }
        : { type: "unconditional" };
    edges[e.id] = {
      source: e.from,
      target: e.to,
      forward_condition,
    };
    if (e.label) (edges[e.id] as Record<string, unknown>).label = e.label;
  }

  return { nodes, edges };
}

/**
 * Reverse direction: an ElevenLabs workflow object (returned by getAgent)
 * back into our internal WorkflowState. We can't perfectly recover the
 * original speak/collect/condition distinction (all three project as
 * override_agent on their side), so we default to `speak` for those.
 */
export function fromElevenWorkflow(w: ElevenWorkflow | undefined): WorkflowState | null {
  if (!w || !w.nodes) return null;

  const ourTypeFor = (t: ElevenWorkflowNode["type"]): WorkflowNodeType => {
    switch (t) {
      case "start":
        return "start";
      case "end":
        return "end";
      case "dispatch_tool":
        return "tool_call";
      case "agent_transfer":
      case "transfer_to_number":
        return "transfer";
      case "override_agent":
      default:
        return "speak";
    }
  };

  const nodes: WorkflowNode[] = Object.entries(w.nodes).map(([id, n]) => {
    const data: Record<string, unknown> = {};
    if (n.additional_prompt) data.prompt = n.additional_prompt;
    if ((n as Record<string, unknown>).tool_id)
      data.tool_id = (n as Record<string, unknown>).tool_id;
    if ((n as Record<string, unknown>).target_agent_id)
      data.target_agent_id = (n as Record<string, unknown>).target_agent_id;
    if ((n as Record<string, unknown>).phone_number)
      data.phone_number = (n as Record<string, unknown>).phone_number;
    return {
      id,
      type: ourTypeFor(n.type),
      label: n.label ?? id,
      data,
    };
  });

  const edges: WorkflowEdge[] = Object.entries(w.edges ?? {}).map(([id, e]) => ({
    id,
    from: e.source,
    to: e.target,
    label: (e as Record<string, unknown>).label as string | undefined,
    condition:
      e.forward_condition?.type === "llm" ||
      e.forward_condition?.type === "expression"
        ? e.forward_condition.condition
        : undefined,
  }));

  return { nodes, edges };
}

const NodeTypeEnum = z.enum([
  "start",
  "speak",
  "collect",
  "tool_call",
  "condition",
  "transfer",
  "end",
]);

/**
 * Strip any legacy "--- WORKFLOW ---" prose footer from a system prompt.
 * We used to inline a markdown rendering of the graph here; now that the
 * structured workflow is pushed to conversation_config.workflow and the
 * runtime walks it itself, the footer is just noise. Kept here so existing
 * agents migrate cleanly the next time they're updated.
 */
export function composeSystemPromptWithWorkflow(prompt: string): string {
  const marker = "\n\n--- WORKFLOW ---\n";
  const idx = prompt.indexOf(marker);
  return idx === -1 ? prompt : prompt.slice(0, idx);
}

/**
 * Push the workflow as structured data on conversation_config.workflow.
 * The agent runtime walks the graph itself — no prompt footer required.
 * Also scrubs any legacy footer from the system prompt in the same call.
 */
async function persistWorkflow(
  ctx: Parameters<Capability["tools"]>[0],
  nextWorkflow: WorkflowState,
): Promise<void> {
  const cleanPrompt = composeSystemPromptWithWorkflow(
    ctx.config.system_prompt ?? "",
  );
  const workflow = toElevenWorkflow(nextWorkflow);
  await patchAgent(ctx.elevenlabs_agent_id, {
    workflow,
    // Only push system_prompt when we actually trimmed a stale footer,
    // to avoid clobbering recent edits with a stale snapshot.
    ...(cleanPrompt !== ctx.config.system_prompt
      ? { system_prompt: cleanPrompt }
      : {}),
  });
  ctx.config.system_prompt = cleanPrompt;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export const workflowCapability: Capability = {
  id: "workflow",
  label: "Workflow",
  defaultSlice: () => ({ workflow: { ...DEFAULT_WORKFLOW } }),
  tools: (ctx) => [
    tool(
      "workflow_add_node",
      "Add a node AND wire it to its predecessor in a single call. ALWAYS pass `after_node_id` (the parent node's id, usually the node you just added or 'start') so the graph stays connected as it grows. Don't add a batch of orphan nodes and then add edges later — the right panel renders the graph live, and orphans look broken. Common types: 'speak' (agent says something), 'collect' (asks for a field), 'tool_call' (invoke a runtime tool), 'condition' (branch), 'transfer' (hand off), 'end' (hang up).",
      {
        type: NodeTypeEnum,
        label: z.string().min(1).max(80),
        data: z.record(z.string(), z.unknown()).default({}),
        after_node_id: z.string().optional(),
        edge_label: z.string().optional(),
        edge_condition: z.string().optional(),
      },
      async ({ type, label, data, after_node_id, edge_label, edge_condition }) =>
        runToolStep(ctx, "workflow", "workflow_add_node", async () => {
          const node: WorkflowNode = { id: newId(type), type, label, data };
          const edges = [...ctx.config.workflow.edges];
          if (after_node_id) {
            if (!ctx.config.workflow.nodes.some((n) => n.id === after_node_id)) {
              throw new Error(`after_node_id "${after_node_id}" does not exist.`);
            }
            edges.push({
              id: newId("edge"),
              from: after_node_id,
              to: node.id,
              label: edge_label,
              condition: edge_condition,
            });
          }
          const next: WorkflowState = {
            nodes: [...ctx.config.workflow.nodes, node],
            edges,
          };
          await persistWorkflow(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: `Added workflow node "${label}" (${node.id}).`,
          };
        }),
    ),

    tool(
      "workflow_connect_nodes",
      "Add an edge between two existing workflow nodes. Only use this for back-edges or fan-in connections that you couldn't express with `after_node_id` on workflow_add_node. For straight-line growth, prefer workflow_add_node({ after_node_id })`.",
      {
        from_id: z.string().min(1),
        to_id: z.string().min(1),
        label: z.string().optional(),
        condition: z.string().optional(),
      },
      async ({ from_id, to_id, label, condition }) =>
        runToolStep(ctx, "workflow", "workflow_connect_nodes", async () => {
          if (!ctx.config.workflow.nodes.some((n) => n.id === from_id))
            throw new Error(`from_id "${from_id}" does not exist.`);
          if (!ctx.config.workflow.nodes.some((n) => n.id === to_id))
            throw new Error(`to_id "${to_id}" does not exist.`);
          const edge: WorkflowEdge = {
            id: newId("edge"),
            from: from_id,
            to: to_id,
            label,
            condition,
          };
          const next: WorkflowState = {
            nodes: ctx.config.workflow.nodes,
            edges: [...ctx.config.workflow.edges, edge],
          };
          await persistWorkflow(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: `Connected ${from_id} → ${to_id}.`,
          };
        }),
    ),

    tool(
      "workflow_update_node",
      "Update a workflow node's label or data.",
      {
        node_id: z.string().min(1),
        label: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      async ({ node_id, label, data }) =>
        runToolStep(ctx, "workflow", "workflow_update_node", async () => {
          const idx = ctx.config.workflow.nodes.findIndex((n) => n.id === node_id);
          if (idx === -1) throw new Error(`No node with id "${node_id}".`);
          const node = ctx.config.workflow.nodes[idx];
          const updated: WorkflowNode = {
            ...node,
            label: label ?? node.label,
            data: data ? { ...node.data, ...data } : node.data,
          };
          const nextNodes = [...ctx.config.workflow.nodes];
          nextNodes[idx] = updated;
          const next: WorkflowState = {
            nodes: nextNodes,
            edges: ctx.config.workflow.edges,
          };
          await persistWorkflow(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: `Updated node ${node_id}.`,
          };
        }),
    ),

    tool(
      "workflow_remove_node",
      "Delete a workflow node and any edges touching it.",
      { node_id: z.string().min(1) },
      async ({ node_id }) =>
        runToolStep(ctx, "workflow", "workflow_remove_node", async () => {
          if (node_id === "start")
            throw new Error("Cannot remove the start node.");
          if (!ctx.config.workflow.nodes.some((n) => n.id === node_id))
            throw new Error(`No node with id "${node_id}".`);
          const next: WorkflowState = {
            nodes: ctx.config.workflow.nodes.filter((n) => n.id !== node_id),
            edges: ctx.config.workflow.edges.filter(
              (e) => e.from !== node_id && e.to !== node_id,
            ),
          };
          await persistWorkflow(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: `Removed node ${node_id}.`,
          };
        }),
    ),

    tool(
      "workflow_reset",
      "Wipe the entire conversation workflow back to just a start node. Use only when explicitly asked.",
      {},
      async () =>
        runToolStep(ctx, "workflow", "workflow_reset", async () => {
          const next: WorkflowState = { ...DEFAULT_WORKFLOW };
          await persistWorkflow(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: "Workflow reset.",
          };
        }),
    ),
  ],
};
