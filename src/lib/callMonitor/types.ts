import type { WorkflowState } from "@/types/agent";

/**
 * `exact`  — current node derived directly from a workflow transition signal.
 * `lost`   — a transition signal arrived that we couldn't resolve to an edge
 *            (e.g. missing `edge_order`); we hold the last known node.
 */
export type CallConfidence = "exact" | "lost";

export type CallStatus = "idle" | "live" | "ended";

/**
 * Normalized events the position engine understands. Decouples the engine from
 * the `@elevenlabs/react` SDK payload shapes (and from a future monitor-socket
 * source). Today the only signal that moves the cursor is `tool_response`.
 */
export type EngineEvent =
  | { kind: "connect" }
  | { kind: "tool_response"; toolName: string; toolType: string; isError: boolean }
  | { kind: "disconnect" };

export type EngineContext = { workflow: WorkflowState };

export type EngineState = {
  /** Best-known current node id, or null before connect / when no start node. */
  activeNodeId: string | null;
  /** Ordered trail of nodes the conversation has passed through. */
  visited: string[];
  status: CallStatus;
  confidence: CallConfidence;
};
