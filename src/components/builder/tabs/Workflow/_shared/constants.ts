import type { WorkflowNodeType } from "@/types/agent";

export const NODE_W = 260;
export const NODE_H = 96;
export const COL_GAP = 160;
export const ROW_GAP = 88;
export const PADDING = 32;
export const EDGE_LABEL_W = 140;
/**
 * Visible height of a terminal pill ("Call connects" / "End call"). Used
 * only for edge-anchor y so connectors meet the pill's visual middle
 * instead of the slot's geometric middle. Matches the rendered pill height
 * for a 2-line label (the longest the auto-stamped terminals reach). For
 * a 1-line label the connector lands slightly high but still inside the
 * pill — much better than the old slot-center anchor which landed below
 * the pill entirely.
 */
export const TERMINAL_H = 56;

/** Options offered in the "+" popup when adding a node below an existing one. */
export const ADD_NODE_MENU: Array<{
  type: WorkflowNodeType;
  label: string;
  hint: string;
  defaultLabel: string;
}> = [
  { type: "speak", label: "Say", hint: "Agent speaks a line.", defaultLabel: "Speak" },
  { type: "collect", label: "Ask", hint: "Collect a field from the caller.", defaultLabel: "Collect" },
  { type: "condition", label: "Router", hint: "Branch on a variable or rule.", defaultLabel: "Route" },
  { type: "tool_call", label: "Tool", hint: "Run a runtime tool.", defaultLabel: "Tool call" },
  { type: "transfer", label: "Transfer", hint: "Hand off to another agent or number.", defaultLabel: "Transfer" },
  { type: "end", label: "End", hint: "End the call.", defaultLabel: "End call" },
];

/** Per-node glyph rendered inside the small circular badge on the card. */
export const ICON: Record<WorkflowNodeType, string> = {
  start: "⚑",
  speak: "🙂",
  collect: "❓",
  condition: "⤳",
  tool_call: "🔧",
  transfer: "↪",
  end: "✕",
};
