/**
 * Workflow capability.
 *
 * The agent builds a conversation flow graph (start → speak → collect →
 * tool_call → condition → transfer → end) as it shapes the voice agent.
 * Nodes + edges live in `config_cache.workflow` and stream to the right
 * panel via state_patch events so the SVG visualizer fills in live.
 *
 * Every workflow-mutating tool (set_workflow / edit_workflow /
 * workflow_reset) routes through `persistWorkflow`, which auto-installs
 * the `report_workflow_state` CLIENT runtime tool on the deployed agent
 * if it's missing. The browser test-call hook ([TestCallButton.tsx])
 * listens for invocations of that tool and highlights the matching
 * workflow node in real time — so tracking comes for free with any
 * workflow build, no extra builder-side tool required.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { createRuntimeTool, patchAgent } from "@/lib/elevenlabs/client";
import type {
  ElevenWorkflow,
  ElevenWorkflowEdge,
  ElevenWorkflowNode,
} from "@/lib/elevenlabs/client";
import type {
  RuntimeTool,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowState,
} from "@/types/agent";
import { DEFAULT_WORKFLOW } from "@/types/agent";
import { createLogger } from "@/lib/logger";
import type { Capability } from "./types";
import { runToolStep } from "./types";

/** Name of the CLIENT runtime tool the deployed voice agent calls to report
 *  its current workflow node. Kept here (and matched verbatim by the
 *  TestCallButton's `clientTools` handler) so the wire name stays consistent
 *  across registration and consumption. */
const TRACKING_TOOL_NAME = "report_workflow_state";

const log = createLogger("capability:workflow");

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
        // ElevenLabs renamed `dispatch_tool` → `tool` in the workflow
        // node enum. The 422 from upstream listed the new accepted set:
        // start, end, phone_number, override_agent, standalone_agent,
        // say, tool, update_state.
        base.type = "tool";
        const toolId = n.data?.tool_id as string | undefined;
        const instruction = n.data?.instruction as string | undefined;
        if (toolId) base.tool_id = toolId;
        if (instruction) base.additional_prompt = instruction;
        break;
      }
      case "transfer": {
        // `transfer_to_number` → `phone_number`, `agent_transfer` →
        // `standalone_agent` per the renamed enum above.
        if (n.data?.phone_number) {
          base.type = "phone_number";
          base.phone_number = n.data.phone_number;
        } else {
          base.type = "standalone_agent";
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
      // ElevenLabs renamed: `dispatch_tool` → `tool`,
      // `agent_transfer` → `standalone_agent`,
      // `transfer_to_number` → `phone_number`. Accept both for backward
      // compat reading historical agents.
      case "tool":
      case "dispatch_tool":
        return "tool_call";
      case "standalone_agent":
      case "agent_transfer":
      case "phone_number":
      case "transfer_to_number":
        return "transfer";
      case "say":
      case "override_agent":
      case "update_state":
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
 * Pre-flight validation matching ElevenLabs' upstream validator. We catch
 * the cases that would otherwise come back as opaque 422s ("workflow.edges:
 * Value error, …") and throw a clear, agent-actionable error first.
 *
 * Today the only rule we mirror is the most painful one: a single source
 * node may have AT MOST ONE unconditional outgoing edge. If the agent tries
 * to wire two `from: X` edges without conditions, upstream rejects because
 * the runtime branch-picker would be ambiguous.
 *
 * Throws on the first violation with enough context (node id, label, the
 * conflicting edge ids) for the agent to self-correct in one follow-up
 * tool call instead of guessing.
 */
function validateWorkflow(w: WorkflowState): void {
  const labelById = new Map(w.nodes.map((n) => [n.id, n.label]));
  const unconditionalBySource = new Map<string, string[]>();
  for (const e of w.edges) {
    const isUnconditional = !e.condition || e.condition.trim().length === 0;
    if (!isUnconditional) continue;
    const list = unconditionalBySource.get(e.from) ?? [];
    list.push(e.id);
    unconditionalBySource.set(e.from, list);
  }
  for (const [sourceId, edgeIds] of unconditionalBySource) {
    if (edgeIds.length > 1) {
      const label = labelById.get(sourceId) ?? "(unknown)";
      throw new Error(
        `Node "${sourceId}" ("${label}") has ${edgeIds.length} unconditional outgoing edges (${edgeIds.join(
          ", ",
        )}). Upstream requires at most one unconditional next step per node — keep one as the default and put a natural-language condition on the rest (e.g. "the caller wants billing"), OR remove the extras.`,
      );
    }
  }
  // Edges must reference existing nodes. set_workflow already checks this,
  // but edit_workflow's add_edge can let stale ids through if the agent
  // composes ops sloppily. A clear pre-flight beats a 404 from upstream.
  const nodeIds = new Set(w.nodes.map((n) => n.id));
  for (const e of w.edges) {
    if (!nodeIds.has(e.from)) {
      throw new Error(
        `Edge "${e.id}" references unknown source node "${e.from}". Available node ids: ${[
          ...nodeIds,
        ].join(", ")}.`,
      );
    }
    if (!nodeIds.has(e.to)) {
      throw new Error(
        `Edge "${e.id}" references unknown target node "${e.to}". Available node ids: ${[
          ...nodeIds,
        ].join(", ")}.`,
      );
    }
  }
}

/**
 * Lazily provision the `report_workflow_state` client tool that powers the
 * live-node highlight during test calls. Returns the new RuntimeTool entry
 * if one was created, or null when the deployed agent already has it.
 * Idempotent across set_workflow / edit_workflow / workflow_reset calls.
 */
async function ensureTrackingTool(
  ctx: Parameters<Capability["tools"]>[0],
): Promise<RuntimeTool | null> {
  if (ctx.config.tools.some((t) => t.name === TRACKING_TOOL_NAME)) {
    return null;
  }
  const created = await createRuntimeTool({
    name: TRACKING_TOOL_NAME,
    description:
      "Report the current workflow node the conversation is in. Call this immediately upon entering each node. Argument: node_id (string).",
    type: "client",
    phase: "in_call",
  });
  return {
    id: created.id,
    name: TRACKING_TOOL_NAME,
    type: "client",
    description: "Workflow node tracker.",
    phase: "in_call",
  };
}

/**
 * Push the workflow as structured data on conversation_config.workflow.
 * The agent runtime walks the graph itself — no prompt footer required.
 * Also scrubs any legacy footer from the system prompt in the same call,
 * and auto-installs the workflow tracking client tool the first time the
 * agent grows a graph.
 *
 * Returns the resulting tools list when tracking was just provisioned, so
 * the calling builder tool can fold it into its state_patch.
 */
async function persistWorkflow(
  ctx: Parameters<Capability["tools"]>[0],
  nextWorkflow: WorkflowState,
): Promise<{ tools?: RuntimeTool[] }> {
  const tTotal = Date.now();
  // Pre-flight validate BEFORE we translate or PATCH, so the agent sees
  // a precise error ("Node X has 2 unconditional outgoing edges") rather
  // than upstream's generic 422.
  validateWorkflow(nextWorkflow);
  const cleanPrompt = composeSystemPromptWithWorkflow(
    ctx.config.system_prompt ?? "",
  );
  const tTranslate = Date.now();
  const workflow = toElevenWorkflow(nextWorkflow);
  const addedTrackingTool = await ensureTrackingTool(ctx);
  const nextTools = addedTrackingTool
    ? [...ctx.config.tools, addedTrackingTool]
    : null;
  const tPatchStart = Date.now();
  await patchAgent(ctx.elevenlabs_agent_id, {
    workflow,
    // Only push system_prompt when we actually trimmed a stale footer,
    // to avoid clobbering recent edits with a stale snapshot.
    ...(cleanPrompt !== ctx.config.system_prompt
      ? { system_prompt: cleanPrompt }
      : {}),
    // Patch tool_ids only when we just added the tracking tool, so
    // unrelated tool changes still come from their own capabilities.
    ...(nextTools ? { tool_ids: nextTools.map((t) => t.id) } : {}),
  });
  const tDone = Date.now();
  ctx.config.system_prompt = cleanPrompt;
  if (nextTools) ctx.config.tools = nextTools;
  log.info("persistWorkflow done", {
    agent_id: ctx.elevenlabs_agent_id,
    turn_job_id: ctx.turn_job_id,
    nodes: nextWorkflow.nodes.length,
    edges: nextWorkflow.edges.length,
    tracking_tool_installed: !!addedTrackingTool,
    translate_ms: tPatchStart - tTranslate,
    eleven_patch_ms: tDone - tPatchStart,
    total_ms: tDone - tTotal,
    prompt_trimmed: cleanPrompt !== ctx.config.system_prompt,
  });
  return nextTools ? { tools: nextTools } : {};
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── set_workflow / edit_workflow schemas ────────────────────────────────

const NodeInput = z.object({
  /** Optional. Omit when adding a fresh node; provide to keep a stable id
   *  across set_workflow calls so React + ElevenLabs treat it as the same node. */
  id: z.string().optional(),
  type: NodeTypeEnum,
  label: z.string().min(1).max(80),
  data: z.record(z.string(), z.unknown()).default({}),
});

const EdgeInput = z.object({
  id: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  condition: z.string().optional(),
});

const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: NodeInput }),
  z.object({
    op: z.literal("update_node"),
    id: z.string().min(1),
    label: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    type: NodeTypeEnum.optional(),
  }),
  z.object({ op: z.literal("remove_node"), id: z.string().min(1) }),
  z.object({ op: z.literal("add_edge"), edge: EdgeInput }),
  z.object({
    op: z.literal("update_edge"),
    id: z.string().min(1),
    label: z.string().optional(),
    condition: z.string().optional(),
  }),
  z.object({ op: z.literal("remove_edge"), id: z.string().min(1) }),
]);

type EditOpT = z.infer<typeof EditOp>;

function applyOps(
  state: WorkflowState,
  ops: EditOpT[],
): WorkflowState {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
  for (const op of ops) {
    switch (op.op) {
      case "add_node": {
        const id = op.node.id ?? newId(op.node.type);
        if (nodes.some((n) => n.id === id))
          throw new Error(`Node id "${id}" already exists.`);
        nodes.push({
          id,
          type: op.node.type,
          label: op.node.label,
          data: op.node.data ?? {},
        });
        break;
      }
      case "update_node": {
        const idx = nodes.findIndex((n) => n.id === op.id);
        if (idx === -1) throw new Error(`No node with id "${op.id}".`);
        const cur = nodes[idx];
        nodes[idx] = {
          ...cur,
          type: op.type ?? cur.type,
          label: op.label ?? cur.label,
          data: op.data ? { ...cur.data, ...op.data } : cur.data,
        };
        break;
      }
      case "remove_node": {
        if (op.id === "start")
          throw new Error("Cannot remove the start node.");
        if (!nodes.some((n) => n.id === op.id))
          throw new Error(`No node with id "${op.id}".`);
        nodes = nodes.filter((n) => n.id !== op.id);
        edges = edges.filter((e) => e.from !== op.id && e.to !== op.id);
        break;
      }
      case "add_edge": {
        const id = op.edge.id ?? newId("edge");
        if (edges.some((e) => e.id === id))
          throw new Error(`Edge id "${id}" already exists.`);
        if (!nodes.some((n) => n.id === op.edge.from))
          throw new Error(`from "${op.edge.from}" does not exist.`);
        if (!nodes.some((n) => n.id === op.edge.to))
          throw new Error(`to "${op.edge.to}" does not exist.`);
        edges.push({
          id,
          from: op.edge.from,
          to: op.edge.to,
          label: op.edge.label,
          condition: op.edge.condition,
        });
        break;
      }
      case "update_edge": {
        const idx = edges.findIndex((e) => e.id === op.id);
        if (idx === -1) throw new Error(`No edge with id "${op.id}".`);
        const cur = edges[idx];
        edges[idx] = {
          ...cur,
          label: op.label ?? cur.label,
          condition: op.condition ?? cur.condition,
        };
        break;
      }
      case "remove_edge": {
        if (!edges.some((e) => e.id === op.id))
          throw new Error(`No edge with id "${op.id}".`);
        edges = edges.filter((e) => e.id !== op.id);
        break;
      }
    }
  }
  return { nodes, edges };
}

export const workflowCapability: Capability = {
  id: "workflow",
  label: "Workflow",
  defaultSlice: () => ({ workflow: { ...DEFAULT_WORKFLOW } }),
  tools: (ctx) => [
    tool(
      "set_workflow",
      // Big up-front graph definition. Use this when building a workflow
      // from scratch — one call, whole graph. Cheaper than 12 add_node +
      // edge calls and keeps the canvas from flickering as nodes pop in.
      "Define (or REPLACE) the entire conversation workflow in a single call. Provide the full `nodes` and `edges` arrays. Use this when first building the workflow or when rewriting it wholesale. For incremental tweaks (rename a node, add one branch, etc.) use `edit_workflow` instead.\n\nNode types: 'start' (always exactly one, id='start'), 'speak' (agent says something — put the line in data.prompt), 'collect' (ask the caller for a value — data.prompt for the question, data.field for the variable name), 'condition' (router that branches on outgoing edges' conditions — data.expression names the variable being checked), 'tool_call' (run a runtime tool — data.tool_id), 'transfer' (hand off — data.target_agent_id for agent transfer, data.phone_number for phone transfer), 'end' (hang up).\n\nEdges: connect node ids via `from`/`to`. A `condition` string on an outgoing edge from a router becomes a natural-language branch ('the caller wants billing'). Leave condition empty for unconditional flow.",
      {
        nodes: z.array(NodeInput).min(1).max(40),
        edges: z.array(EdgeInput).max(80).default([]),
      },
      async ({ nodes, edges }) =>
        runToolStep(ctx, "workflow", "set_workflow", async () => {
          log.info("set_workflow entry", {
            turn_job_id: ctx.turn_job_id,
            input_nodes: nodes.length,
            input_edges: edges.length,
            node_types: nodes.reduce<Record<string, number>>((acc, n) => {
              acc[n.type] = (acc[n.type] ?? 0) + 1;
              return acc;
            }, {}),
            edges_with_condition: edges.filter(
              (e) => typeof e.condition === "string" && e.condition.length > 0,
            ).length,
          });
          // Stamp missing ids so the agent doesn't have to.
          const stampedNodes: WorkflowNode[] = nodes.map((n) => ({
            id: n.id ?? newId(n.type),
            type: n.type,
            label: n.label,
            data: n.data ?? {},
          }));
          const knownIds = new Set(stampedNodes.map((n) => n.id));
          const stampedEdges: WorkflowEdge[] = edges.map((e) => {
            if (!knownIds.has(e.from))
              throw new Error(`Edge "from" references unknown node "${e.from}".`);
            if (!knownIds.has(e.to))
              throw new Error(`Edge "to" references unknown node "${e.to}".`);
            return {
              id: e.id ?? newId("edge"),
              from: e.from,
              to: e.to,
              label: e.label,
              condition: e.condition,
            };
          });
          const next: WorkflowState = {
            nodes: stampedNodes,
            edges: stampedEdges,
          };
          const persistResult = await persistWorkflow(ctx, next);
          return {
            patch: {
              workflow: next,
              system_prompt: ctx.config.system_prompt,
              ...(persistResult.tools ? { tools: persistResult.tools } : {}),
            },
            summary: `Workflow set: ${stampedNodes.length} nodes, ${stampedEdges.length} edges.`,
          };
        }),
    ),

    tool(
      "edit_workflow",
      "Apply a list of incremental edits to the existing workflow WITHOUT having to re-send the whole graph. Operations run in order, so you can rename a node, add two new branches, and remove an edge in one call. Cheaper than rewriting the workflow with set_workflow when only a few things change.\n\nEach `operations` entry is one of:\n- { op: 'add_node', node: { type, label, data?, id? } }\n- { op: 'update_node', id, label?, data?, type? }  (data is shallow-merged into node.data)\n- { op: 'remove_node', id }  (also drops any edges touching the node; cannot remove 'start')\n- { op: 'add_edge', edge: { from, to, label?, condition?, id? } }\n- { op: 'update_edge', id, label?, condition? }\n- { op: 'remove_edge', id }",
      {
        operations: z.array(EditOp).min(1).max(40),
      },
      async ({ operations }) =>
        runToolStep(ctx, "workflow", "edit_workflow", async () => {
          log.info("edit_workflow entry", {
            turn_job_id: ctx.turn_job_id,
            ops: operations.length,
            op_kinds: operations.reduce<Record<string, number>>((acc, o) => {
              acc[o.op] = (acc[o.op] ?? 0) + 1;
              return acc;
            }, {}),
            current_nodes: ctx.config.workflow.nodes.length,
            current_edges: ctx.config.workflow.edges.length,
          });
          const next = applyOps(ctx.config.workflow, operations);
          const persistResult = await persistWorkflow(ctx, next);
          return {
            patch: {
              workflow: next,
              system_prompt: ctx.config.system_prompt,
              ...(persistResult.tools ? { tools: persistResult.tools } : {}),
            },
            summary: `Applied ${operations.length} edit${operations.length === 1 ? "" : "s"} to the workflow.`,
          };
        }),
    ),

    tool(
      "workflow_reset",
      "Wipe the entire conversation workflow back to just a start node. Use only when explicitly asked, or before a fresh set_workflow call on a previously-built agent.",
      {},
      async () =>
        runToolStep(ctx, "workflow", "workflow_reset", async () => {
          log.info("workflow_reset entry", {
            turn_job_id: ctx.turn_job_id,
            current_nodes: ctx.config.workflow.nodes.length,
            current_edges: ctx.config.workflow.edges.length,
          });
          const next: WorkflowState = { ...DEFAULT_WORKFLOW };
          const persistResult = await persistWorkflow(ctx, next);
          return {
            patch: {
              workflow: next,
              system_prompt: ctx.config.system_prompt,
              ...(persistResult.tools ? { tools: persistResult.tools } : {}),
            },
            summary: "Workflow reset.",
          };
        }),
    ),
  ],
};
