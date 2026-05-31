// ── ElevenAgents Workflow schema (conversation_config.workflow) ─────────
//
// Spec reference (Sep 2025): https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows
// Nodes and edges are object-keyed maps (not arrays), unlike our internal
// WorkflowState model.

/**
 * Discriminated union for `forward_condition` and `backward_condition` on
 * an ElevenLabs workflow edge. All four variants accept an optional `label`
 * — the human-readable description that renders on the edge pill.
 *
 * `expression` carries an opaque ASTNode JSON tree (and/or/not, operators,
 * literals); we don't model the AST here because the upstream schema is
 * deep and we treat it as a pass-through.
 */
export type ElevenForwardCondition =
  | { type: "unconditional"; label?: string }
  | { type: "llm"; condition: string; label?: string }
  | { type: "expression"; expression: unknown; label?: string }
  | { type: "result"; successful: boolean; label?: string };

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
  backward_condition?: ElevenForwardCondition;
};

export type ElevenWorkflow = {
  /** Map keyed by node id. Schema makes this optional — an empty workflow
   *  legitimately omits it. */
  nodes?: Record<string, ElevenWorkflowNode>;
  /** Map keyed by edge id. Same optionality as `nodes`. */
  edges?: Record<string, ElevenWorkflowEdge>;
  /** Block sub-agent transfer cycles. When true, ElevenLabs' runtime
   *  refuses a `standalone_agent` hop that would loop back to an agent
   *  that's already on the call's transfer stack. Top-level setting on
   *  the workflow object, not per-node. */
  prevent_subagent_loops?: boolean;
};
