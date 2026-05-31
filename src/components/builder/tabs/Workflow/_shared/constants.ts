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
  /**
   * Optional pre-seed for `node.data` when this menu entry is picked. Used
   * to split the two transfer modes into separate menu items: picking
   * "Agent transfer" seeds `{ agent_id: "" }` so the inspector lands on
   * the agent sub-form, and picking "Phone number transfer" seeds
   * `{ phone_number: "" }` for the phone sub-form. Inspector already keys
   * its mode picker off these two fields.
   */
  data?: Record<string, unknown>;
}> = [
  { type: "speak", label: "Say", hint: "Agent speaks a line.", defaultLabel: "Speak" },
  { type: "collect", label: "Ask", hint: "Collect a field from the caller.", defaultLabel: "Collect" },
  { type: "condition", label: "Router", hint: "Branch on a variable or rule.", defaultLabel: "Route" },
  { type: "tool_call", label: "Tool", hint: "Run a runtime tool.", defaultLabel: "Tool call" },
  {
    type: "transfer",
    label: "Agent transfer",
    hint: "Hand off to another ElevenLabs agent.",
    defaultLabel: "Transfer to agent",
    data: { agent_id: "" },
  },
  {
    type: "transfer",
    label: "Phone number transfer",
    hint: "Hand off to a phone number.",
    defaultLabel: "Transfer to phone",
    data: { phone_number: "" },
  },
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
