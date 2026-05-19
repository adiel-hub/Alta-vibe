import type { RuntimePhase } from "@/types/agent";
import { elFetch } from "../core/fetch";
import { log, logTrunc } from "../core/logger";

export type RuntimeToolSpec = {
  name: string;
  description: string;
  type: "webhook" | "client" | "system";
  phase: RuntimePhase;
  api_schema?: {
    url: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    request_headers?: Record<string, string>;
    request_body_schema?: unknown;
    query_params_schema?: unknown;
  };
};

/**
 * True when `v` is an actual JSON-Schema-shaped object the upstream API
 * will accept. We send body / query schemas only when they're real objects;
 * null and empty objects produce 422s on /v1/convai/tools.
 */
function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length > 0
  );
}

export async function createRuntimeTool(
  spec: RuntimeToolSpec,
): Promise<{ id: string; name: string }> {
  let api_schema: Record<string, unknown> | undefined;
  if (spec.api_schema) {
    api_schema = {
      url: spec.api_schema.url,
      method: spec.api_schema.method,
    };
    if (
      spec.api_schema.request_headers &&
      Object.keys(spec.api_schema.request_headers).length > 0
    ) {
      api_schema.request_headers = spec.api_schema.request_headers;
    }
    if (isNonEmptyObject(spec.api_schema.request_body_schema)) {
      api_schema.request_body_schema = spec.api_schema.request_body_schema;
    }
    if (isNonEmptyObject(spec.api_schema.query_params_schema)) {
      api_schema.query_params_schema = spec.api_schema.query_params_schema;
    }
  }
  const body = {
    tool_config: {
      name: spec.name,
      description: spec.description,
      type: spec.type,
      ...(api_schema ? { api_schema } : {}),
    },
  };
  // Log the whole tool_config we're about to send. /v1/convai/tools
  // returns 422 on subtle schema shape issues (e.g. `type: "object"` at
  // the outer schema level, unknown JSON-Schema fields) — having the
  // exact body in logs lets us tell synthesizer bugs from upstream
  // schema drift without re-running with debug toggles.
  log.info("createRuntimeTool → POST /v1/convai/tools", {
    name: spec.name,
    type: spec.type,
    method: api_schema?.method,
    has_request_body_schema: "request_body_schema" in (api_schema ?? {}),
    has_query_params_schema: "query_params_schema" in (api_schema ?? {}),
    tool_config: logTrunc(body.tool_config),
  });
  const res = await elFetch("/v1/convai/tools", {
    method: "POST",
    section: "tools",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id: string; tool_config?: { name?: string } };
  return { id: json.id, name: json.tool_config?.name ?? spec.name };
}

export async function deleteRuntimeTool(toolId: string): Promise<void> {
  await elFetch(`/v1/convai/tools/${toolId}`, {
    method: "DELETE",
    section: "tools",
  });
}
