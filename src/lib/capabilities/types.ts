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
import type { AgentPatch } from "@/lib/elevenlabs/agents/types";
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
  /**
   * Accumulator for upstream PATCH fields across a single turn. Each tool
   * merges its `upstreamPatch` (an `AgentPatch` slice — note this is a
   * separate shape from the local `patch`, since e.g. tools live in the
   * cache as `RuntimeTool[]` but go upstream as `tool_ids: string[]`)
   * here via top-level Object.assign, and `runTurn`'s finally block flushes
   * it in one PATCH so a turn that runs N modifying tools produces 1
   * ElevenLabs version instead of N. Tools without an `upstreamPatch` (or
   * with `skipUpstream`) leave this untouched.
   */
  deferredPatch: AgentPatch;
  /**
   * Per-turn abort signal (fires on hard timeout, and reserved for a future
   * user-driven Stop). Used by `runToolStep` to short-circuit the post-tool
   * "viewability" hold so a cancelled turn doesn't sit idle for 3-4 s.
   */
  abortSignal?: AbortSignal;
};

/**
 * After certain tools succeed, hold the turn for a beat so the user can
 * register the change on the canvas before the LLM emits the next tool
 * (which auto-switches the panel via `sseClient`'s `bumpActiveSection`).
 * Keep this map tiny — most tools should run back-to-back.
 */
const VIEW_HOLD_MS: Record<string, number> = {
  set_workflow: 3500,
};

function sleepCancellable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

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
  fn: () => Promise<{
    /** Local config_cache slice — applied to ctx.config + emitted as state_patch. */
    patch: Partial<AgentConfigCache>;
    /**
     * Upstream PATCH slice — merged into `ctx.deferredPatch` and sent to
     * ElevenLabs at end of turn. Must be supplied explicitly because many
     * fields have different shapes between cache and upstream (e.g.
     * `tools: RuntimeTool[]` locally vs `tool_ids: string[]` upstream).
     * Omit for tools that only mutate local state.
     */
    upstreamPatch?: AgentPatch;
    summary: string;
    data?: T;
    /**
     * If true, suppresses the upstream merge even if `upstreamPatch` is set.
     * Used by tools that conditionally skip the ElevenLabs round-trip
     * (e.g. lifecycle-only write_tool branch).
     */
    skipUpstream?: boolean;
  }>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const log = createLogger(`capability:${section}`, {
    agent_id: ctx.elevenlabs_agent_id,
    turn_job_id: ctx.turn_job_id,
    op,
  });
  const t0 = Date.now();
  log.debug("tool start");
  try {
    const { patch, upstreamPatch, summary, skipUpstream } = await fn();
    Object.assign(ctx.config, patch);
    if (upstreamPatch && !skipUpstream) {
      Object.assign(ctx.deferredPatch, upstreamPatch);
    }
    const revision = ctx.bumpRevision();
    ctx.emit({ type: "state_patch", revision, patch });
    log.info("tool ok", {
      ms: Date.now() - t0,
      revision,
      patched: Object.keys(patch),
      upstream_keys: upstreamPatch ? Object.keys(upstreamPatch) : [],
      skip_upstream: skipUpstream === true,
    });
    // Hold the turn AFTER the canvas has rendered the new state but BEFORE
    // returning the tool result. This is the only window where the user can
    // register the change before the LLM emits the next tool (which auto-
    // switches the panel away). Aborts immediately on turn cancel.
    const holdMs = VIEW_HOLD_MS[op];
    if (holdMs && holdMs > 0) {
      log.debug("post-tool hold", { ms: holdMs });
      await sleepCancellable(holdMs, ctx.abortSignal);
    }
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
