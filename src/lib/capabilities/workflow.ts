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
  WorkflowEdge,
  WorkflowNode,
  WorkflowState,
} from "@/types/agent";
import { DEFAULT_WORKFLOW } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

const NodeTypeEnum = z.enum([
  "start",
  "speak",
  "collect",
  "tool_call",
  "condition",
  "transfer",
  "end",
]);

function renderWorkflowForPrompt(w: WorkflowState): string {
  if (w.nodes.length <= 1) return "(no workflow defined yet)";
  const lines: string[] = [];
  lines.push("Conversation workflow:");
  for (const n of w.nodes) {
    const outgoing = w.edges
      .filter((e) => e.from === n.id)
      .map((e) => `→ ${e.to}${e.condition ? ` if [${e.condition}]` : ""}`);
    const data = Object.entries(n.data)
      .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
      .join(", ");
    lines.push(`- [${n.id}] ${n.type}: ${n.label}${data ? ` (${data})` : ""} ${outgoing.join("; ")}`);
  }
  lines.push(
    "Follow this flow at runtime. After each step, call the report_workflow_state tool with the node id you are about to enter.",
  );
  return lines.join("\n");
}

async function persistWorkflowIntoPrompt(
  ctx: Parameters<Capability["tools"]>[0],
  nextWorkflow: WorkflowState,
): Promise<void> {
  // Re-render the system prompt with the current workflow context appended.
  // We keep the user-authored prompt verbatim and append a `--- WORKFLOW ---`
  // marker so subsequent updates can replace the section cleanly.
  const marker = "\n\n--- WORKFLOW ---\n";
  const existing = ctx.config.system_prompt ?? "";
  const idx = existing.indexOf(marker);
  const base = idx === -1 ? existing : existing.slice(0, idx);
  const next = `${base}${marker}${renderWorkflowForPrompt(nextWorkflow)}`;
  await patchAgent(ctx.elevenlabs_agent_id, { system_prompt: next });
  ctx.config.system_prompt = next;
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
          await persistWorkflowIntoPrompt(ctx, next);
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
          await persistWorkflowIntoPrompt(ctx, next);
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
          await persistWorkflowIntoPrompt(ctx, next);
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
          await persistWorkflowIntoPrompt(ctx, next);
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
          await persistWorkflowIntoPrompt(ctx, next);
          return {
            patch: { workflow: next, system_prompt: ctx.config.system_prompt },
            summary: "Workflow reset.",
          };
        }),
    ),
  ],
};
