/**
 * Custom-tool webhook proxy. ElevenLabs fires agent-generated runtime tools
 * here mid-call / post-call. Mirrors the per-provider integration proxy
 * (src/app/api/integrations/[provider]/proxy/...) but reads the upstream
 * spec from `custom_tools` and substitutes secrets from `agent_secrets`.
 *
 * URL shape: /api/custom-tools/proxy/<agentMongoId>/<customToolId>
 *
 * Auth model:
 *   ElevenLabs presents `Authorization: Bearer <proxy_secret>` (the
 *   per-tool secret stored on the custom_tools doc). The proxy verifies,
 *   then substitutes any `{{secret:<name>}}` template values in the
 *   stored upstream headers using decrypted values from agent_secrets.
 *   ElevenLabs never sees the user's third-party credentials.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { customToolsCol } from "@/lib/mongodb";
import { getAgentSecret } from "@/lib/integrations/agentSecrets";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_PLACEHOLDER = /\{\{secret:([a-z0-9_]+)\}\}/g;

async function resolveSecretPlaceholders(
  template: string,
  agentMongoId: string,
  cache: Map<string, string>,
): Promise<{ value: string; missing: string[] }> {
  const missing: string[] = [];
  // Build the resolved string in one pass. Collect missing names so the
  // proxy can return a clear 401 with the offender — saves the user
  // wondering why "the agent stopped working" weeks after publish.
  let resolved = "";
  let lastIndex = 0;
  for (const match of template.matchAll(SECRET_PLACEHOLDER)) {
    const name = match[1];
    const start = match.index ?? 0;
    resolved += template.slice(lastIndex, start);
    let value = cache.get(name);
    if (value === undefined) {
      const fetched = await getAgentSecret(agentMongoId, name);
      if (fetched === null) {
        missing.push(name);
        value = "";
      } else {
        value = fetched;
        cache.set(name, value);
      }
    }
    resolved += value;
    lastIndex = start + match[0].length;
  }
  resolved += template.slice(lastIndex);
  return { value: resolved, missing };
}

async function handle(
  req: NextRequest,
  params: { agentId: string; customToolId: string },
): Promise<NextResponse> {
  const log = createLogger("custom-tool-proxy", {
    agent_id: params.agentId,
    custom_tool_id: params.customToolId,
    req_id: newRequestId(),
  });

  if (
    !ObjectId.isValid(params.agentId) ||
    !ObjectId.isValid(params.customToolId)
  ) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!bearer) {
    return NextResponse.json({ error: "Missing bearer" }, { status: 401 });
  }

  const tools = await customToolsCol();
  const doc = await tools.findOne({
    _id: new ObjectId(params.customToolId),
    agent_id: new ObjectId(params.agentId),
  });
  if (!doc) {
    log.warn("tool not found");
    return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  }
  if (doc.proxy_secret !== bearer) {
    log.warn("bearer mismatch");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Method must match what the synthesizer published. We don't accept
  // method overrides from the caller — that's an entire class of footgun
  // (the agent registered a GET tool, ElevenLabs fires GET, but someone
  // crafted a POST request to delete data).
  if (req.method !== doc.upstream.method && req.method !== "POST") {
    // ElevenLabs always uses the registered method, but we also allow POST
    // as a generic invocation method for non-ElevenLabs callers (testing,
    // future durable workflows). Reject other mismatches.
    return NextResponse.json(
      { error: "Method not allowed" },
      { status: 405 },
    );
  }

  // Substitute {{secret:name}} placeholders in the headers using the
  // agent's encrypted secret store.
  const cache = new Map<string, string>();
  const headers: Record<string, string> = {};
  const allMissing = new Set<string>();
  for (const [k, v] of Object.entries(doc.upstream.headers)) {
    const { value, missing } = await resolveSecretPlaceholders(
      v,
      params.agentId,
      cache,
    );
    headers[k] = value;
    for (const m of missing) allMissing.add(m);
  }

  // Also allow templating in the URL itself (useful for path params that
  // reference an account id or workspace id stored as a secret).
  const { value: upstreamUrl, missing: urlMissing } =
    await resolveSecretPlaceholders(doc.upstream.url, params.agentId, cache);
  for (const m of urlMissing) allMissing.add(m);

  if (allMissing.size > 0) {
    log.warn("missing secrets", { missing: Array.from(allMissing) });
    return NextResponse.json(
      {
        error: "Missing secrets",
        missing: Array.from(allMissing),
        hint: "The agent owner removed or never collected one of the credentials this tool needs.",
      },
      { status: 401 },
    );
  }

  const search = new URL(req.url).search;
  const upstream = upstreamUrl + (search || "");
  const hasBody = !["GET", "HEAD"].includes(doc.upstream.method);
  const body = hasBody ? await req.text() : undefined;
  if (hasBody && !headers["content-type"]) {
    headers["content-type"] = req.headers.get("content-type") ?? "application/json";
  }
  if (!headers["accept"]) headers["accept"] = "application/json";

  log.info("forward", { method: doc.upstream.method, upstream });
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method: doc.upstream.method,
      headers,
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "fetch failed";
    log.error("upstream fetch failed", { message });
    return NextResponse.json(
      { error: "Upstream unreachable", message },
      { status: 502 },
    );
  }

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
  { params }: { params: Promise<{ agentId: string; customToolId: string }> },
) {
  return handle(req, await params);
}
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; customToolId: string }> },
) {
  return handle(req, await params);
}
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; customToolId: string }> },
) {
  return handle(req, await params);
}
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; customToolId: string }> },
) {
  return handle(req, await params);
}
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; customToolId: string }> },
) {
  return handle(req, await params);
}
