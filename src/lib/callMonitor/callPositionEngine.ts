/**
 * Pure state machine that tracks which workflow node a live call is on.
 *
 * How ElevenLabs surfaces transitions (confirmed by spike against a live web
 * call — see scripts/monitor-probe.ts): on EVERY workflow edge traversal the
 * agent emits an `agent_tool_response` with
 *     tool_type: "workflow", tool_name: "notify_condition_<N>_met"
 * where N is the 1-based index into the SOURCE node's `edge_order` (the ordered
 * list of its outgoing edge ids, preserved into `node.data.edge_order`). The
 * Nth edge's `to` is the destination node. Reaching the end node also emits a
 * system `end_call`. This makes tracking EXACT — no inference needed.
 *
 * Framework-free and side-effect-free so it can be unit-tested directly.
 */
import type { WorkflowState } from "@/types/agent";
import type { EngineContext, EngineEvent, EngineState } from "./types";

const NOTIFY_RE = /^notify_condition_(\d+)_met$/;

export function findStartNodeId(wf: WorkflowState): string | null {
  return wf.nodes.find((n) => n.type === "start")?.id ?? null;
}

function findEndNodeId(wf: WorkflowState): string | null {
  return wf.nodes.find((n) => n.type === "end")?.id ?? null;
}

/** Ordered outgoing-edge ids for a node, authoritative `edge_order` first. */
function outgoingEdgeOrder(nodeId: string, wf: WorkflowState): string[] {
  const node = wf.nodes.find((n) => n.id === nodeId);
  const order = node?.data?.edge_order;
  if (Array.isArray(order) && order.every((x) => typeof x === "string")) {
    return order as string[];
  }
  // Fallback for cached agents projected before edge_order was preserved.
  // Object-iteration order is not guaranteed to match ElevenLabs', but it's
  // the best we can do without a re-projection.
  return wf.edges.filter((e) => e.from === nodeId).map((e) => e.id);
}

export function createInitialState(wf: WorkflowState): EngineState {
  const start = findStartNodeId(wf);
  return {
    activeNodeId: start,
    visited: start ? [start] : [],
    status: "live",
    confidence: "exact",
  };
}

function moveTo(state: EngineState, nodeId: string): EngineState {
  return {
    ...state,
    activeNodeId: nodeId,
    visited: state.visited.includes(nodeId)
      ? state.visited
      : [...state.visited, nodeId],
    confidence: "exact",
  };
}

export function reduce(
  state: EngineState,
  event: EngineEvent,
  ctx: EngineContext,
): EngineState {
  switch (event.kind) {
    case "connect":
      return createInitialState(ctx.workflow);

    case "disconnect":
      return { ...state, status: "ended" };

    case "tool_response": {
      if (state.status !== "live") return state;
      const { toolName, toolType } = event;

      // Reaching the end node.
      if (toolType === "system" && toolName === "end_call") {
        const end = findEndNodeId(ctx.workflow);
        return end ? moveTo(state, end) : state;
      }

      // Workflow edge traversal: notify_condition_<N>_met (1-based into edge_order).
      const match = toolType === "workflow" ? NOTIFY_RE.exec(toolName) : null;
      if (match) {
        const idx = Number(match[1]) - 1;
        const cur = state.activeNodeId;
        if (!cur) return { ...state, confidence: "lost" };
        const edgeId = outgoingEdgeOrder(cur, ctx.workflow)[idx];
        const target = edgeId
          ? ctx.workflow.edges.find((e) => e.id === edgeId)?.to
          : undefined;
        if (!target) return { ...state, confidence: "lost" };
        return moveTo(state, target);
      }

      // Real tool calls (webhook/client/mcp) and transfer_to_agent are not
      // movement signals — notify_condition already moves the cursor onto/off
      // tool nodes. Ignore.
      return state;
    }

    default:
      return state;
  }
}
