// ── ElevenAgents Workflow schema (conversation_config.workflow) ─────────
//
// Spec reference (Sep 2025): https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows
// Nodes and edges are object-keyed maps (not arrays), unlike our internal
// WorkflowState model.

export type ElevenForwardCondition =
  | { type: "unconditional" }
  | { type: "llm"; condition: string }
  | { type: "expression"; condition: string };

export type ElevenWorkflowNode = {
  /** Node type recognised by the agent runtime. */
  type:
    | "start"
    | "end"
    | "override_agent"
    | "say"
    | "tool"
    | "standalone_agent"
    | "phone_number"
    | "update_state"
    // Legacy names kept for parsing old agents that haven't been
    // re-saved since ElevenLabs renamed the enum:
    //   dispatch_tool      → tool
    //   agent_transfer     → standalone_agent
    //   transfer_to_number → phone_number
    | "dispatch_tool"
    | "agent_transfer"
    | "transfer_to_number";
  /** Human-readable label for the visual editor. */
  label?: string;
  /**
   * Prompt fragment appended to the agent's system prompt while this node
   * is active. Most commonly used on `override_agent` nodes to give them
   * scoped instructions (e.g. "Help with the support request, then move on").
   */
  additional_prompt?: string;
  /**
   * Ordered list of outgoing edge ids. The runtime evaluates each edge's
   * forward_condition in order; the first one that matches wins.
   */
  edge_order?: string[];
  /** Free-form per-type config (tool_id, target_agent_id, phone_number, …). */
  [extra: string]: unknown;
};

export type ElevenWorkflowEdge = {
  source: string;
  target: string;
  forward_condition: ElevenForwardCondition;
};

export type ElevenWorkflow = {
  nodes: Record<string, ElevenWorkflowNode>;
  edges: Record<string, ElevenWorkflowEdge>;
};
