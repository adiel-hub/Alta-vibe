/**
 * OAuth2 route-handler factories. Turn the Google-Calendar-specific
 * /oauth/start and /oauth/callback handlers into reusable builders so each
 * new OAuth2 provider's route files are a few lines:
 *
 *   // app/api/integrations/salesforce/oauth/start/route.ts
 *   export const { POST } = createOAuthStartRoute(SALESFORCE_OAUTH_CONFIG);
 *
 *   // app/api/integrations/salesforce/oauth/callback/route.ts
 *   export const { GET } = createOAuthCallbackRoute(SALESFORCE_OAUTH_CONFIG, {
 *     toolSummary: "lookup_contact, create_contact, …",
 *     buildEffectMessage: ({ addedTools, email }) => "…",
 *   });
 *
 * Behaviour matches the Google routes exactly: shared-secret gate on start,
 * HMAC-signed state binding the redirect to an agent + pending widget action,
 * code exchange, encrypted credential persistence via registerProviderForAgent,
 * a system turn so the chat agent acknowledges the connection, and a popup
 * page that postMessages the opener and closes. The postMessage `type` is
 * `<providerId>_oauth_<success|error>` — the connect widget matches on the
 * provider prefix.
 */
import { NextResponse, type NextRequest, after } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { widgetActionsCol } from "@/lib/mongodb";
import { registerProviderForAgent } from "@/lib/integrations/registerProviderTools";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { createLogger, newRequestId } from "@/lib/logger";
import {
  type OAuth2ProviderConfig,
  signOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  buildOAuthCredentials,
} from "./oauth2";

// ── /oauth/start ─────────────────────────────────────────────────────────

export function createOAuthStartRoute(cfg: OAuth2ProviderConfig) {
  const Body = z.object({
    agent_id: z.string().min(1),
    action_id: z.string().min(1),
    instance_url: z.string().url().optional(),
  });

  async function POST(req: NextRequest): Promise<NextResponse> {
    const log = createLogger("integration", {
      route: `POST /integrations/${cfg.providerId}/oauth/start`,
      req_id: newRequestId(),
    });
    const guard = requireSharedSecret(req);
    if (guard) return guard;

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    const { agent_id, action_id, instance_url } = parsed.data;
    if (!ObjectId.isValid(agent_id) || !ObjectId.isValid(action_id)) {
      return NextResponse.json({ error: "Invalid id" }, { status: 400 });
    }
    if (cfg.requiresInstanceUrlAtConnect && !instance_url) {
      return NextResponse.json(
        { error: `${cfg.providerId} requires your instance/org URL to connect.` },
        { status: 400 },
      );
    }

    // Confirm the pending widget action exists and belongs to this agent —
    // prevents minting state tokens for arbitrary action ids.
    const widgets = await widgetActionsCol();
    const action = await widgets.findOne({
      _id: new ObjectId(action_id),
      agent_id: new ObjectId(agent_id),
      kind: "connect_integration",
      status: "pending",
    });
    if (!action) {
      log.warn("no pending connect_integration action", { agent_id, action_id });
      return NextResponse.json(
        { error: `No pending connect action for this agent.` },
        { status: 404 },
      );
    }

    try {
      const normalizedInstance = instance_url?.replace(/\/$/, "");
      const state = signOAuthState({
        agent_id,
        action_id,
        ...(normalizedInstance ? { instance_url: normalizedInstance } : {}),
      });
      const url = buildAuthorizeUrl(cfg, {
        state,
        instanceUrl: normalizedInstance,
      });
      log.info("authorize url issued", { agent_id, action_id });
      return NextResponse.json({ url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth start failed";
      log.error("authorize url failed", { message });
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  return { POST };
}

// ── /oauth/callback ──────────────────────────────────────────────────────

export type CallbackOptions = {
  /** Builds the system-turn message the chat agent acts on after connecting. */
  buildEffectMessage: (opts: {
    addedTools: number;
    email: string | null;
  }) => string;
};

function renderResult(
  providerId: string,
  opts: {
    ok: boolean;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
  },
): Response {
  const safeTitle = opts.title.replace(/[<>&]/g, "");
  const safeDetail = opts.detail.replace(/[<>&]/g, "");
  const status = opts.ok ? "success" : "error";
  const payload = JSON.stringify({
    type: `${providerId}_oauth_${status}`,
    ...(opts.payload ?? {}),
  });
  const safePayload = payload.replace(/<\//g, "<\\/");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<style>
  body { font: 14px -apple-system, system-ui, sans-serif; padding: 32px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 0; color: #555; }
  .ok { color: #0a7d2c; }
  .err { color: #b42323; }
</style>
</head>
<body>
<h1 class="${opts.ok ? "ok" : "err"}">${safeTitle}</h1>
<p>${safeDetail}</p>
<script>
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(${safePayload}, "*");
    }
  } catch (_) {}
  setTimeout(function () { window.close(); }, 800);
</script>
</body>
</html>`;
  return new Response(html, {
    status: opts.ok ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function createOAuthCallbackRoute(
  cfg: OAuth2ProviderConfig,
  options: CallbackOptions,
) {
  async function GET(req: NextRequest): Promise<Response> {
    const log = createLogger("integration", {
      route: `GET /integrations/${cfg.providerId}/oauth/callback`,
      req_id: newRequestId(),
    });
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (oauthError) {
      log.warn("oauth declined", { error: oauthError });
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Connection cancelled",
        detail: `The provider returned: ${oauthError}. Close this window and try again.`,
      });
    }
    if (!code || !stateParam) {
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Missing OAuth parameters",
        detail: "No authorization code was returned. Close this window and retry.",
      });
    }

    const state = verifyOAuthState(stateParam);
    if (!state) {
      log.warn("oauth state invalid or expired");
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Connection link expired",
        detail: "Close this window and click Connect again from the chat.",
      });
    }
    const { agent_id, action_id, instance_url } = state;
    if (!ObjectId.isValid(agent_id) || !ObjectId.isValid(action_id)) {
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Invalid state",
        detail: "Malformed identifiers in the OAuth state.",
      });
    }
    const actionObjectId = new ObjectId(action_id);
    const agentObjectId = new ObjectId(agent_id);

    const widgets = await widgetActionsCol();
    const action = await widgets.findOne({
      _id: actionObjectId,
      agent_id: agentObjectId,
      kind: "connect_integration",
    });
    if (!action) {
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Connection request not found",
        detail: "The chat request may have been cancelled. Try again from the chat.",
      });
    }
    if (action.status !== "pending") {
      return renderResult(cfg.providerId, {
        ok: true,
        title: "Already connected",
        detail: "This integration is already set up. You can close this window.",
      });
    }

    let credentials;
    try {
      const tokens = await exchangeCodeForTokens(cfg, {
        code,
        instanceUrl: instance_url,
      });
      credentials = buildOAuthCredentials(cfg, tokens, { instanceUrl: instance_url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Token exchange failed";
      log.error("token exchange failed", { message });
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Could not complete sign-in",
        detail: message,
      });
    }

    try {
      const { added_tools } = await registerProviderForAgent(
        agent_id,
        cfg.providerId,
        credentials as unknown as Record<string, unknown>,
      );
      log.info("provider registered", { provider: cfg.providerId, agent_id, added_tools });

      await widgets.updateOne(
        { _id: actionObjectId },
        {
          $set: {
            status: "done",
            result: { connected: true, email: credentials.email ?? null },
            resolved_at: new Date(),
          },
        },
      );

      const effectMessage = options.buildEffectMessage({
        addedTools: added_tools,
        email: credentials.email ?? null,
      });
      const jobId = await enqueueTurnJob(agentObjectId, effectMessage, "system");
      if (!process.env.USE_RAILWAY_WORKER) {
        after(async () => {
          try {
            await processTurnJob(jobId);
          } catch {
            // job runner handles its own failures
          }
        });
      }
      return renderResult(cfg.providerId, {
        ok: true,
        title: "Connected!",
        detail: "This integration is now linked to your agent. This window will close.",
        payload: {
          agent_id,
          action_id,
          resumed_job_id: jobId.toHexString(),
          email: credentials.email ?? null,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Registration failed";
      log.error("registration failed", { message });
      await widgets.updateOne(
        { _id: actionObjectId },
        {
          $set: {
            status: "failed",
            result: { error: message },
            resolved_at: new Date(),
          },
        },
      );
      return renderResult(cfg.providerId, {
        ok: false,
        title: "Could not finish connecting",
        detail: message,
      });
    }
  }

  return { GET };
}
