/**
 * Webhook proxy. ElevenLabs fires runtime tool webhooks here mid-call /
 * post-call. We verify a per-integration bearer secret, decrypt the
 * provider's token, attach it as Authorization, and forward the request
 * upstream (e.g. api.hubapi.com). Response body is piped back to the LLM.
 *
 * URL shape: /api/integrations/<provider>/proxy/<agentMongoId>/<toolName>
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { findWorkspaceIntegration } from "@/lib/integrations/store";
import { getProvider, findProviderTool } from "@/lib/integrations/providers";
import { resolveProviderToken } from "@/lib/integrations/oauth/tokenResolvers";
import { createLogger, newRequestId } from "@/lib/logger";

/**
 * Substitute `{name}` placeholders in a path template using values pulled
 * from the request body (or, for GET/DELETE, the query). Returns the
 * resolved path AND a copy of the body/query with the consumed keys
 * removed — we don't want HubSpot to see `contactId` as an unknown
 * property in the body of a PATCH /contacts/{contactId}.
 */
function resolvePathTemplate(
  template: string,
  source: Record<string, unknown> | null,
): { path: string; remaining: Record<string, unknown> | null; missing: string[] } {
  const placeholders = Array.from(template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)).map(
    (m) => m[1],
  );
  if (placeholders.length === 0) {
    return { path: template, remaining: source, missing: [] };
  }
  const remaining: Record<string, unknown> | null = source ? { ...source } : null;
  const missing: string[] = [];
  let path = template;
  for (const name of placeholders) {
    const raw = remaining ? remaining[name] : undefined;
    if (raw === undefined || raw === null || raw === "") {
      missing.push(name);
      continue;
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(raw)));
    if (remaining) delete remaining[name];
  }
  return { path, remaining, missing };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(
  req: NextRequest,
  params: { provider: string; agentId: string; toolName: string },
): Promise<NextResponse> {
  const log = createLogger("integration-proxy", {
    provider: params.provider,
    agent_id: params.agentId,
    tool: params.toolName,
    req_id: newRequestId(),
  });

  if (!ObjectId.isValid(params.agentId)) {
    return NextResponse.json({ error: "Invalid agentId" }, { status: 400 });
  }
  const providerDef = getProvider(params.provider);
  if (!providerDef) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  const spec = findProviderTool(params.provider, params.toolName);
  if (!spec) {
    return NextResponse.json({ error: "Unknown tool" }, { status: 404 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!bearer) {
    return NextResponse.json({ error: "Missing bearer" }, { status: 401 });
  }

  // Integrations are workspace-shared: any agent's tool URL points at the
  // workspace's HubSpot/Google/etc. integration row. The agentId URL
  // segment is informational (for logs and routing); the bearer secret on
  // the request authoritatively names the integration.
  const doc = await findWorkspaceIntegration(params.provider);
  if (!doc) {
    log.warn("no integration");
    return NextResponse.json({ error: "Not connected" }, { status: 401 });
  }

  const storedSecret = (doc.metadata as { proxy_secret?: unknown }).proxy_secret;
  if (typeof storedSecret !== "string" || storedSecret !== bearer) {
    log.warn("bearer mismatch");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve the upstream access token via the provider→resolver registry:
  // OAuth2 providers (Google, Salesforce, Dynamics, Outlook) refresh in-place
  // when near expiry; static-credential providers (HubSpot PAT, Slack bot
  // token) just decrypt the stored access_token.
  let token: string;
  try {
    token = await resolveProviderToken(params.provider, params.agentId);
  } catch (err) {
    log.error("token resolve failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token resolve failed" },
      { status: 500 },
    );
  }

  // Pull body (or query, for GET/DELETE) up front so we can lift any
  // `{var}` keys out of it for path-template substitution.
  //
  // The proxy is authoritative on the upstream method, not the incoming
  // request — ElevenLabs' api_schema only accepts GET/POST/PUT/DELETE, so
  // PATCH-flavored mutations get registered as POST with ElevenLabs but
  // need to leave the proxy as PATCH so HubSpot sees the right verb.
  const upstreamMethod = spec.method;
  const url = new URL(req.url);
  const hasBody = !["GET", "HEAD", "DELETE"].includes(upstreamMethod);
  const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  let bodyObj: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        bodyObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body — pass through unchanged. Path templates with
      // non-JSON bodies aren't a thing in HubSpot/Slack/Notion, so this
      // is fine.
    }
  }

  let resolvedPath = spec.path;
  if (spec.path_template) {
    // For methods without a body, lift placeholder values from query
    // params instead. ElevenLabs sends the LLM's query_params_schema
    // arguments as actual URL query params.
    const source: Record<string, unknown> | null = bodyObj
      ? bodyObj
      : (() => {
          const q: Record<string, unknown> = {};
          for (const [k, v] of url.searchParams) q[k] = v;
          return Object.keys(q).length > 0 ? q : null;
        })();
    const resolved = resolvePathTemplate(spec.path, source);
    if (resolved.missing.length > 0) {
      log.warn("path template missing values", { missing: resolved.missing });
      return NextResponse.json(
        {
          error: `Missing required path values: ${resolved.missing.join(", ")}. The LLM must supply these in the request.`,
        },
        { status: 400 },
      );
    }
    resolvedPath = resolved.path;
    if (bodyObj && resolved.remaining) bodyObj = resolved.remaining;
    if (!bodyObj && resolved.remaining) {
      // Strip the consumed keys from the forwarded query string too.
      const next = new URLSearchParams();
      for (const [k, v] of url.searchParams) {
        if (resolved.remaining[k] !== undefined) next.append(k, v);
      }
      url.search = next.toString() ? `?${next.toString()}` : "";
    }
  }

  // Per-tenant providers (Salesforce, Dynamics) store the customer's API base
  // (`instance_url` / org URL) on the integration row at connect time. Prefer
  // it over the provider's static base_api_url when present.
  const instanceUrl = (doc.credentials as { instance_url?: unknown }).instance_url;
  const baseApiUrl =
    typeof instanceUrl === "string" && instanceUrl
      ? instanceUrl.replace(/\/$/, "")
      : providerDef.base_api_url;
  const upstream = baseApiUrl + resolvedPath + (url.search || "");

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const ct = req.headers.get("content-type");
  if (ct) upstreamHeaders["content-type"] = ct;

  // Re-serialize the body if we touched it during path substitution.
  const body = hasBody
    ? bodyObj !== null
      ? JSON.stringify(bodyObj)
      : rawBody
    : undefined;

  log.info("forward", { method: upstreamMethod, upstream });
  const upstreamRes = await fetch(upstream, {
    method: upstreamMethod,
    headers: upstreamHeaders,
    body,
  });

  const respBody = await upstreamRes.text();
  log.info("forwarded", { status: upstreamRes.status, bytes: respBody.length });

  return new NextResponse(respBody, {
    status: upstreamRes.status,
    headers: {
      "content-type":
        upstreamRes.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; agentId: string; toolName: string }> },
) {
  return handle(req, await params);
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; agentId: string; toolName: string }> },
) {
  return handle(req, await params);
}
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; agentId: string; toolName: string }> },
) {
  return handle(req, await params);
}
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; agentId: string; toolName: string }> },
) {
  return handle(req, await params);
}
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; agentId: string; toolName: string }> },
) {
  return handle(req, await params);
}
