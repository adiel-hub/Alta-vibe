/**
 * Server-side dispatcher for pre/post-call tools.
 *
 * The pre-call and post-call webhooks (see ../../app/api/elevenlabs/) hand
 * us a phase + an agent_id + a context bag (caller info for pre, transcript
 * + data_collection for post). This module:
 *
 *   1. Loads the agent and filters `config_cache.tools` to the requested
 *      phase.
 *   2. Substitutes `{{field:NAME}}` placeholders in each tool's request
 *      body using the context bag.
 *   3. Forwards the request to the same secret-substituting proxy ElevenLabs
 *      would have hit if these tools were registered upstream
 *      (`/api/integrations/<provider>/proxy/...` for provider tools,
 *      `/api/custom-tools/proxy/...` for write_tool-synthesized tools).
 *   4. For pre-call: returns the per-tool outputs so the route can fold
 *      them into ElevenLabs' `dynamic_variables` response.
 *   5. For post-call: best-effort fire each; one failure doesn't block the
 *      others.
 *
 * The proxy stays the single point that talks to upstream APIs — we don't
 * duplicate OAuth decryption or secret substitution here. The dispatcher
 * is just glue: read tool → template body → POST through proxy.
 */
import { ObjectId } from "mongodb";
import {
  agentsCol,
  customToolsCol,
} from "@/lib/mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import { createLogger } from "@/lib/logger";

const log = createLogger("lifecycle-dispatch");

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
};

/**
 * Substitute `{{field:NAME}}` (and the legacy `{NAME}` form) inside a
 * string with values from the context bag. Unknown keys are left as-is so
 * the upstream API surface still sees them — easier to debug than a silent
 * empty string.
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
  agentMongoId: ObjectId,
  tool: RuntimeTool,
): Promise<string | null> {
  if (tool.provider) {
    // Workspace-shared lookup — any agent's lifecycle tool resolves the
    // same workspace integration row.
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

/**
 * Pick the right HTTP method for the lifecycle call. We fire the tool's
 * own `method` (POST for log_call, etc.); only fall back to POST when the
 * spec is missing one entirely.
 */
function methodFor(tool: RuntimeTool): string {
  return tool.method ?? "POST";
}

/**
 * Fire a single tool. Returns a typed result (never throws). The proxy
 * handles auth + secret substitution; we only template the body.
 */
async function fireOne(
  agentMongoId: ObjectId,
  tool: RuntimeTool,
  bodyTemplate: Record<string, unknown> | null,
  ctx: DispatchContext,
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
  const bearer = await lookupProxyBearer(agentMongoId, tool);
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

  try {
    const res = await fetch(tool.url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(hasBody ? { "content-type": "application/json" } : {}),
        accept: "application/json",
      },
      body,
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
    const message = err instanceof Error ? err.message : String(err);
    log.error("lifecycle dispatch threw", { tool: tool.name, message });
    return {
      tool_name: tool.name,
      ok: false,
      status: 0,
      output: null,
      error: message,
    };
  }
}

/**
 * Dispatch every tool on the agent whose phase matches `phase`. Returns
 * one DispatchResult per tool, in declaration order.
 */
export async function dispatchLifecycle(
  agentMongoId: string | ObjectId,
  phase: RuntimePhase,
  ctx: DispatchContext,
  /**
   * Optional body factory — receives the tool spec and returns the
   * template (pre-substitution) body to send. Defaults to an empty body
   * for GET/DELETE methods and `{}` otherwise.
   */
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
    results.push(await fireOne(_id, tool, bodyFor(tool), ctx));
  }
  return results;
}
