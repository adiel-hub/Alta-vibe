/**
 * Personalization webhook target for INBOUND calls. ElevenLabs hits this
 * URL BEFORE connecting the caller to the agent — we respond with the
 * `dynamic_variables` we want substituted into the agent's prompt and
 * first message.
 *
 * Flow:
 *   1. Verify HMAC signature (ELEVENLABS_WEBHOOK_SECRET) if configured.
 *      Same scheme as the post-call webhook.
 *   2. Resolve the ElevenLabs agent_id → our Mongo agent.
 *   3. Run the same `enrichCallContext` we use for outbound — but with
 *      ONLY the caller's phone number. No prospect_id, no campaign
 *      context. Pre-call tools that can identify the caller from phone
 *      (HubSpot lookup, alta_local_time) still produce variables; tools
 *      that need richer input return null gracefully.
 *   4. Respond with `{ dynamic_variables }` in ElevenLabs' expected shape.
 *
 * If a pre-call tool with `abort_on_failure: true` blocks the call, we
 * return 412 — ElevenLabs treats this as "don't connect" and the caller
 * hears whatever fallback the workspace has configured.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { agentsCol } from "@/lib/mongodb";
import { enrichCallContext } from "@/lib/integrations/enrichment";
import { isPreCallAbortError } from "@/lib/calls/preCallAbortError";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type PersonalizationPayload = {
  agent_id?: string;
  /** Caller's phone number in E.164. */
  caller_id?: string;
  /** Whatever else ElevenLabs decides to send; we ignore unknown keys. */
  [k: string]: unknown;
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

export async function POST(req: NextRequest) {
  const log = createLogger("personalization", {
    route: "POST /elevenlabs/personalization",
    req_id: newRequestId(),
  });
  const raw = await req.text();
  const sig = verifySignature(
    raw,
    req.headers.get("authorization") ?? req.headers.get("elevenlabs-signature"),
  );
  if (!sig.ok) {
    log.warn("signature rejected", { reason: sig.reason });
    return NextResponse.json(
      { error: "Invalid signature" },
      { status: 401 },
    );
  }

  let payload: PersonalizationPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!payload.agent_id) {
    return NextResponse.json({ error: "Missing agent_id" }, { status: 400 });
  }
  if (!payload.caller_id) {
    return NextResponse.json({ error: "Missing caller_id" }, { status: 400 });
  }

  const agent = await (await agentsCol()).findOne({
    elevenlabs_agent_id: payload.agent_id,
  });
  if (!agent) {
    log.warn("agent not found", { elevenlabs_agent_id: payload.agent_id });
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  log.info("personalization start", {
    agent_id: agent._id.toHexString(),
    caller_id: payload.caller_id,
  });

  try {
    const dynamicVariables = await enrichCallContext({
      agentMongoId: agent._id.toHexString(),
      to_number: payload.caller_id,
      // No prospect_id / audience_id / campaign_id — inbound caller is
      // identified at most by phone. Tools that need richer input return
      // null gracefully and don't contribute variables.
    });
    log.info("personalization ok", {
      agent_id: agent._id.toHexString(),
      vars: Object.keys(dynamicVariables).length,
    });
    return NextResponse.json({ dynamic_variables: dynamicVariables });
  } catch (err) {
    if (isPreCallAbortError(err)) {
      log.warn("personalization aborted", {
        tool: err.tool_name,
        reason: err.reason,
      });
      return NextResponse.json(
        {
          error: err.message,
          abort_reason: err.reason,
          tool_name: err.tool_name,
        },
        { status: 412 },
      );
    }
    const message = err instanceof Error ? err.message : "unknown error";
    log.error("personalization threw", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
