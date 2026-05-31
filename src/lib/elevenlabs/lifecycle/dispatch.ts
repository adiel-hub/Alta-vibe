/**
 * Server-side dispatcher for pre/post-call tools.
 *
 * The pre-call enrichment ([enrichment.ts]) and the post-call webhook
 * (see /api/elevenlabs/post-call) both end up here. This module:
 *
 *   1. For HTTP-typed tools — templates `{{field:NAME}}` placeholders in
 *      the body using the dispatch context, then POSTs through the same
 *      secret-substituting proxy that ElevenLabs would have hit if these
 *      tools were registered upstream.
 *   2. For function-typed tools (pre-call only) — invokes `spec.execute`
 *      directly with the CallerContext + prior wave outputs. No HTTP.
 *   3. Wraps both paths in a per-tool timeout (AbortController for HTTP,
 *      Promise.race for function).
 *
 * The proxy stays the single point that talks to upstream APIs — we don't
 * duplicate OAuth decryption or secret substitution here. The dispatcher
 * is just glue: read tool → template body or call execute → return result.
 */
import { ObjectId } from "mongodb";
import {
  agentsCol,
  customToolsCol,
} from "@/lib/mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type {
  ProviderRuntimeToolSpec,
  PriorOutputs,
} from "@/lib/integrations/providers/types";
import type { CallerContext } from "@/lib/calls/callerContext";
import { createLogger } from "@/lib/logger";

const log = createLogger("lifecycle-dispatch");

const DEFAULT_TIMEOUT_MS = 5000;

/** Values available for `{{field:NAME}}` substitution. */
export type DispatchContext = Record<string, string | number | boolean | null>;

export type DispatchResult = {
  tool_name: string;
  ok: boolean;
  status: number;
  /** Parsed JSON body when the response was JSON; otherwise the raw text. */
  output: unknown;
  /** Present when ok === false. */
  error?: string;
  /** True when the tool was aborted by a per-tool timeout. */
  timed_out?: boolean;
};

/**
 * Substitute `{{field:NAME}}` inside a string with values from the context
 * bag. Unknown keys are left as-is so the upstream API surface still sees
 * them — easier to debug than a silent empty string.
 */
function templateString(input: string, ctx: DispatchContext): string {
  return input.replace(
    /\{\{\s*field\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (match, key: string) => {
      if (key in ctx) {
        const v = ctx[key];
        return v === null || v === undefined ? "" : String(v);
      }
      return match;
    },
  );
}

/**
 * Walk an arbitrary JSON value and template every string leaf. Mutates a
 * deep copy; the original argument is left untouched.
 */
function templateValue(value: unknown, ctx: DispatchContext): unknown {
  if (typeof value === "string") return templateString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => templateValue(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = templateValue(v, ctx);
    }
    return out;
  }
  return value;
}

/** Lookup the proxy bearer for a tool's URL. */
async function lookupProxyBearer(
  tool: RuntimeTool,
): Promise<string | null> {
  if (tool.provider) {
    const doc = await findWorkspaceIntegration(tool.provider);
    const secret = (doc?.metadata as { proxy_secret?: unknown } | undefined)
      ?.proxy_secret;
    return typeof secret === "string" ? secret : null;
  }
  // Custom-tool URL shape: /api/custom-tools/proxy/<agentId>/<customToolId>
  const m = tool.url?.match(/\/api\/custom-tools\/proxy\/[^/]+\/([a-f0-9]{24})/i);
  if (!m) return null;
  const customToolId = m[1];
  const doc = await (await customToolsCol()).findOne({ _id: new ObjectId(customToolId) });
  return typeof doc?.proxy_secret === "string" ? doc.proxy_secret : null;
}

function methodFor(tool: RuntimeTool): string {
  return tool.method ?? "POST";
}

/**
 * Fire a single HTTP-typed lifecycle tool. Returns a typed result (never
 * throws). Honors `timeout_ms` via AbortController.
 */
export async function fireHttp(
  tool: RuntimeTool,
  bodyTemplate: Record<string, unknown> | null,
  ctx: DispatchContext,
  timeout_ms: number = DEFAULT_TIMEOUT_MS,
): Promise<DispatchResult> {
  if (!tool.url) {
    return {
      tool_name: tool.name,
      ok: false,
      status: 0,
      output: null,
      error: "tool.url is missing — cannot dispatch",
    };
  }
  const bearer = await lookupProxyBearer(tool);
  if (!bearer) {
    return {
      tool_name: tool.name,
      ok: false,
      status: 0,
      output: null,
      error:
        "proxy_secret not found (provider not connected or custom_tools row missing)",
    };
  }
  const method = methodFor(tool);
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "DELETE";
  const body = hasBody && bodyTemplate
    ? JSON.stringify(templateValue(bodyTemplate, ctx))
    : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const res = await fetch(tool.url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
        accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let output: unknown = text;
    try {
      output = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON response — keep the raw text.
    }
    if (!res.ok) {
      log.warn("lifecycle dispatch non-2xx", {
        tool: tool.name,
        status: res.status,
        body_preview: text.slice(0, 200),
      });
      return {
        tool_name: tool.name,
        ok: false,
        status: res.status,
        output,
        error: `proxy returned ${res.status}`,
      };
    }
    return { tool_name: tool.name, ok: true, status: res.status, output };
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    const message = err instanceof Error ? err.message : String(err);
    log.error("lifecycle dispatch threw", {
      tool: tool.name,
      message,
      aborted,
    });
    return {
      tool_name: tool.name,
      ok: false,
      status: 0,
      output: null,
      error: aborted ? `timed out after ${timeout_ms}ms` : message,
      timed_out: aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a single pre-call tool, branching on `spec.execute` vs `spec.build_body`.
 * Both paths return the same DispatchResult shape and honor `timeout_ms`.
 */
export async function runPreCallTool(
  tool: RuntimeTool,
  spec: ProviderRuntimeToolSpec,
  ctx: CallerContext,
  prior: PriorOutputs,
): Promise<DispatchResult> {
  const timeout_ms = spec.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  if (spec.execute) {
    // Function-typed: race the promise against a timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        spec.execute(ctx, prior),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${timeout_ms}ms`)),
            timeout_ms,
          );
        }),
      ]);
      return {
        tool_name: tool.name,
        ok: true,
        status: 200,
        output: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timed_out = message.startsWith("timed out");
      log.warn("execute tool failed", {
        tool: tool.name,
        message,
        timed_out,
      });
      return {
        tool_name: tool.name,
        ok: false,
        status: 0,
        output: null,
        error: message,
        timed_out,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // HTTP-typed: build the body from the CallerContext + prior, template
  // substitution via the dispatch context (CallerContext scalars are a
  // subset of DispatchContext for `{{field:NAME}}` purposes).
  const bodyTemplate = spec.build_body?.(ctx, prior) ?? null;
  if (bodyTemplate === null) {
    return {
      tool_name: tool.name,
      ok: true,
      status: 0,
      output: null,
    };
  }
  return fireHttp(tool, bodyTemplate, ctx as unknown as DispatchContext, timeout_ms);
}

/**
 * Dispatch every tool on the agent whose phase matches `phase`. Returns
 * one DispatchResult per tool. Used by post-call (HTTP-only, sequential).
 * Pre-call uses its own wave-based orchestration — see enrichment.ts.
 */
export async function dispatchLifecycle(
  agentMongoId: string | ObjectId,
  phase: RuntimePhase,
  ctx: DispatchContext,
  bodyFor: (tool: RuntimeTool) => Record<string, unknown> | null = () => ({}),
): Promise<DispatchResult[]> {
  const _id = typeof agentMongoId === "string"
    ? new ObjectId(agentMongoId)
    : agentMongoId;
  const agent = await (await agentsCol()).findOne({ _id });
  if (!agent) {
    log.warn("dispatch: agent not found", { agent_id: _id.toHexString() });
    return [];
  }
  const tools = agent.config_cache.tools.filter((t) => t.phase === phase);
  if (tools.length === 0) return [];
  log.info("dispatching lifecycle tools", {
    agent_id: _id.toHexString(),
    phase,
    count: tools.length,
  });
  const results: DispatchResult[] = [];
  for (const tool of tools) {
    results.push(await fireHttp(tool, bodyFor(tool), ctx));
  }
  return results;
}
