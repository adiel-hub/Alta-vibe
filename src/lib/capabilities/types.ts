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
import { createLogger } from "@/lib/logger";

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
  const log = createLogger(`capability:${section}`, {
    agent_id: ctx.elevenlabs_agent_id,
    turn_job_id: ctx.turn_job_id,
    op,
  });
  const t0 = Date.now();
  log.debug("tool start");
  try {
    const { patch, summary } = await fn();
    Object.assign(ctx.config, patch);
    const revision = ctx.bumpRevision();
    ctx.emit({ type: "state_patch", revision, patch });
    log.info("tool ok", {
      ms: Date.now() - t0,
      revision,
      patched: Object.keys(patch),
    });
    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // ElevenLabsError carries the upstream response body. Surface it
    // both in our app logs and in the agent-visible error text so the
    // model can self-correct (e.g. "field X must be Y") instead of
    // being stuck looping on a generic "request failed (422)".
    const upstreamBody =
      err && typeof err === "object" && "body" in err
        ? (err as { body?: unknown }).body
        : undefined;
    const upstreamStatus =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: number }).status
        : undefined;
    log.error("tool failed", {
      ms: Date.now() - t0,
      message,
      upstream_status: upstreamStatus,
      upstream_body: upstreamBody,
      stack: err instanceof Error ? err.stack : undefined,
    });
    ctx.emit({ type: "state_error", section, message });
    let agentText = `Tool "${op}" failed: ${message}.`;
    // Pydantic/FastAPI shape that ElevenLabs uses: detail is an array
    // of { loc, msg, type } describing each rejected field. Flatten so
    // the agent sees exactly which field needs fixing.
    if (
      upstreamBody &&
      typeof upstreamBody === "object" &&
      "detail" in upstreamBody &&
      Array.isArray((upstreamBody as { detail?: unknown }).detail)
    ) {
      const detail = (upstreamBody as { detail: unknown[] }).detail;
      const items = detail
        .map((it) => {
          if (typeof it !== "object" || it === null) return null;
          const msg = (it as { msg?: unknown }).msg;
          const loc = (it as { loc?: unknown }).loc;
          if (typeof msg !== "string") return null;
          const path = Array.isArray(loc)
            ? loc
                .filter((p) => p !== "body" && (typeof p === "string" || typeof p === "number"))
                .join(".")
            : "";
          return path ? `  - ${path}: ${msg}` : `  - ${msg}`;
        })
        .filter((s): s is string => s !== null);
      if (items.length > 0) {
        agentText += `\nUpstream validation errors:\n${items.join("\n")}`;
      }
    }
    agentText += "\nYou can adjust the inputs and try again, or ask the user how to proceed.";
    return {
      content: [{ type: "text", text: agentText }],
      isError: true,
    };
  }
}
