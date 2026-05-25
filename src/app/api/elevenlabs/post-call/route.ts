/**
 * Post-call webhook target. Configure this URL on ElevenLabs at the
 * workspace level as the "Post-Call Webhook" — it fires after every
 * conversation ends with the full transcript, the extracted
 * `data_collection` fields, and the evaluation results.
 *
 * Flow:
 *   1. Verify HMAC signature (ELEVENLABS_WEBHOOK_SECRET) if configured.
 *   2. Resolve the ElevenLabs agent_id to our Mongo agent.
 *   3. Build the dispatch context from `data_collection` field values
 *      (this is the v1 substitution source — see ../pre-call for the
 *      caller-context flavour).
 *   4. Run every `post_call` tool on the agent in declaration order.
 *      Failures are logged but never block the rest.
 *
 * Returns 200 with a per-tool result manifest for debugging. ElevenLabs
 * doesn't act on the response body — it just expects a 2xx.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { agentsCol } from "@/lib/mongodb";
import { dispatchLifecycle, type DispatchContext } from "@/lib/elevenlabs/lifecycle/dispatch";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type PostCallPayload = {
  agent_id?: string;
  conversation_id?: string;
  /** ElevenLabs' extracted typed fields per `data_collection` definition. */
  data_collection?: Record<
    string,
    { value?: unknown; rationale?: string } | unknown
  >;
  /** Pass-through from the conversation start. */
  dynamic_variables?: Record<string, string>;
};

function verifySignature(
  body: string,
  header: string | null,
): { ok: boolean; reason?: string } {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return { ok: true };
  if (!header) return { ok: false, reason: "missing signature header" };
  const v0 = header.split(",").map((p) => p.trim()).find((p) => p.startsWith("v0="));
  const sent = v0 ? v0.slice(3) : header.trim();
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (sent.length !== expected.length) {
    return { ok: false, reason: "signature length mismatch" };
  }
  const ok = timingSafeEqual(Buffer.from(sent, "hex"), Buffer.from(expected, "hex"));
  return ok ? { ok } : { ok: false, reason: "signature mismatch" };
}

/**
 * Flatten ElevenLabs' `data_collection` payload into a flat
 * { field_name: value } map. The upstream shape is either the bare scalar
 * or `{ value, rationale }` — accept both.
 */
function flattenDataCollection(
  raw: PostCallPayload["data_collection"],
): DispatchContext {
  const out: DispatchContext = {};
  if (!raw) return out;
  for (const [k, entry] of Object.entries(raw)) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "object" && "value" in (entry as object)) {
      const v = (entry as { value?: unknown }).value;
      if (v === null) out[k] = null;
      else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = v;
      }
      continue;
    }
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      out[k] = entry;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const log = createLogger("api", {
    route: "POST /api/elevenlabs/post-call",
    req_id: newRequestId(),
  });

  const raw = await req.text();
  const sig = verifySignature(raw, req.headers.get("elevenlabs-signature"));
  if (!sig.ok) {
    log.warn("signature rejected", { reason: sig.reason });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: PostCallPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.agent_id) {
    return NextResponse.json({ error: "Missing agent_id" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({
    elevenlabs_agent_id: payload.agent_id,
  });
  if (!agent) {
    log.warn("agent not found", { elevenlabs_agent_id: payload.agent_id });
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  log.info("post-call", {
    agent_id: agent._id.toHexString(),
    conversation_id: payload.conversation_id,
    data_field_count: Object.keys(payload.data_collection ?? {}).length,
  });

  const ctx: DispatchContext = {
    conversation_id: payload.conversation_id ?? "",
    ...(payload.dynamic_variables ?? {}),
    ...flattenDataCollection(payload.data_collection),
  };

  const results = await dispatchLifecycle(agent._id, "post_call", ctx);
  log.info("post-call done", {
    agent_id: agent._id.toHexString(),
    fired: results.length,
    failed: results.filter((r) => !r.ok).length,
  });

  return NextResponse.json({ results });
}
