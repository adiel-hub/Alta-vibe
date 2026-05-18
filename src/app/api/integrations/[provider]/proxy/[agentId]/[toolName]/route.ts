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
import { integrationsCol } from "@/lib/mongodb";
import { decryptToken } from "@/lib/integrations/tokens";
import { getProvider } from "@/lib/integrations/providers";
import { createLogger, newRequestId } from "@/lib/logger";

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

  // Tool spec lookup — the scoped tool name in our DB is either
  // "<name>" (in_call) or "<phase>__<name>" (pre/post). Match by both.
  const spec = providerDef.runtime_tools.find(
    (t) =>
      t.name === params.toolName ||
      `${t.phase}__${t.name}` === params.toolName,
  );
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

  const ints = await integrationsCol();
  const doc = await ints.findOne({
    agent_id: new ObjectId(params.agentId),
    provider: params.provider,
    status: "connected",
  });
  if (!doc) {
    log.warn("no integration");
    return NextResponse.json({ error: "Not connected" }, { status: 401 });
  }

  const storedSecret = (doc.metadata as { proxy_secret?: unknown }).proxy_secret;
  if (typeof storedSecret !== "string" || storedSecret !== bearer) {
    log.warn("bearer mismatch");
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const encrypted = (doc.credentials as { access_token?: unknown }).access_token;
  if (typeof encrypted !== "string") {
    log.error("no encrypted token");
    return NextResponse.json({ error: "Missing credentials" }, { status: 500 });
  }
  let token: string;
  try {
    token = decryptToken(encrypted);
  } catch (err) {
    log.error("decrypt failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Decryption failed" }, { status: 500 });
  }

  // Build upstream URL: provider.base_api_url + spec.path + original query
  const url = new URL(req.url);
  const upstream = providerDef.base_api_url + spec.path + (url.search || "");

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const ct = req.headers.get("content-type");
  if (ct) upstreamHeaders["content-type"] = ct;

  const hasBody = !["GET", "HEAD"].includes(req.method);
  const body = hasBody ? await req.text() : undefined;

  log.info("forward", { method: req.method, upstream });
  const upstreamRes = await fetch(upstream, {
    method: req.method,
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
