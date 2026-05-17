/**
 * Capability registry — the architectural seam every voice-agent feature
 * (voice settings, knowledge base, workflow, integrations, future X) plugs
 * into. A `Capability` is a self-contained module that exposes:
 *
 *   - `tools(ctx)` — the MCP tools the builder agent (Claude) calls to
 *     mutate this capability's slice of agent state.
 *   - `defaultSlice()` — the initial config_cache shape for this capability.
 *   - `sections` — keys the right-panel renderer uses to show "syncing…"
 *     spinners and to route state_error events.
 *
 * Adding a new capability = create one file under capabilities/, register it
 * in capabilities/index.ts. The builder agent picks up its tools, the store
 * picks up its slice, and the panel renders the corresponding tab.
 */
import type { SSEEvent, AgentConfigCache } from "@/types/agent";

export type ToolContext = {
  agentMongoId: string;
  elevenlabs_agent_id: string;
  /** Current config snapshot, mutated in place as tools succeed. */
  config: AgentConfigCache;
  /** Active turn_job id; widgets are scoped to this. */
  turn_job_id: string;
  emit: (event: SSEEvent) => void;
  bumpRevision: () => number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkTool = any;

export type Capability = {
  /** Unique slug — also the section key for spinners/errors. */
  id: string;
  /** Human-facing label (for the architecture inspector). */
  label: string;
  /** MCP tool factory. May return any number of tools (often 1–5). */
  tools: (ctx: ToolContext) => SdkTool[];
  /** Default state-slice the capability contributes to AgentConfigCache. */
  defaultSlice: () => Partial<AgentConfigCache>;
};

/**
 * Centralised guarded executor for capability tool handlers. Catches all
 * errors, normalises them into agent-visible tool_result with is_error=true
 * (so the agent stays in its loop and self-corrects), and emits a state_error
 * event for the right-panel UI.
 */
export async function runToolStep<T>(
  ctx: ToolContext,
  section: string,
  op: string,
  fn: () => Promise<{ patch: Partial<AgentConfigCache>; summary: string; data?: T }>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const { patch, summary } = await fn();
    Object.assign(ctx.config, patch);
    const revision = ctx.bumpRevision();
    ctx.emit({ type: "state_patch", revision, patch });
    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    ctx.emit({ type: "state_error", section, message });
    return {
      content: [
        {
          type: "text",
          text: `Tool "${op}" failed: ${message}. You can adjust the inputs and try again, or ask the user how to proceed.`,
        },
      ],
      isError: true,
    };
  }
}
