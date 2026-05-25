/**
 * Google OAuth redirect target. This is the URL configured as the
 * `redirect_uri` in the GCP console; the user lands here in a popup window
 * after granting (or denying) calendar access.
 *
 * Public endpoint — Google can't carry our shared-secret header, so we
 * authenticate the agent + widget action via the signed `state` token we
 * minted in /oauth/start.
 *
 * On success:
 *   - Exchange the auth code for access + refresh tokens
 *   - Persist them (encrypted) and install the default Calendar tools via
 *     registerProviderForAgent
 *   - Mark the connect_integration widget action `done`
 *   - Enqueue a system turn so the chat agent acknowledges the connection
 *   - Render a small page that messages the opener and closes the popup
 */
import { type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import { widgetActionsCol } from "@/lib/mongodb";
import {
  verifyOAuthState,
  exchangeCodeForTokens,
  buildCredentialsFromTokens,
} from "@/lib/integrations/google/auth";
import { registerProviderForAgent } from "@/lib/integrations/registerProviderTools";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function renderResult(opts: {
  ok: boolean;
  title: string;
  detail: string;
  /** Extra fields appended to the postMessage payload (action_id, resumed_job_id, email, …). */
  payload?: Record<string, unknown>;
}): Response {
  const safeTitle = opts.title.replace(/[<>&]/g, "");
  const safeDetail = opts.detail.replace(/[<>&]/g, "");
  const status = opts.ok ? "success" : "error";
  const payload = JSON.stringify({
    type: `google_calendar_oauth_${status}`,
    ...(opts.payload ?? {}),
  });
  // payload is JSON.stringify of plain fields — safe to inline. We still
  // escape `</` so a stray string can't terminate the <script> tag.
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

export async function GET(req: NextRequest): Promise<Response> {
  const log = createLogger("integration", {
    route: "GET /integrations/google_calendar/oauth/callback",
    req_id: newRequestId(),
  });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    log.warn("oauth declined", { error: oauthError });
    return renderResult({
      ok: false,
      title: "Connection cancelled",
      detail: `Google returned: ${oauthError}. You can close this window and try again.`,
    });
  }
  if (!code || !stateParam) {
    return renderResult({
      ok: false,
      title: "Missing OAuth parameters",
      detail: "Google did not return a code. Close this window and retry.",
    });
  }

  const state = verifyOAuthState(stateParam);
  if (!state) {
    log.warn("oauth state invalid or expired");
    return renderResult({
      ok: false,
      title: "Connection link expired",
      detail: "Close this window and click Connect again from the chat.",
    });
  }
  const { agent_id, action_id } = state;
  if (!ObjectId.isValid(agent_id) || !ObjectId.isValid(action_id)) {
    return renderResult({
      ok: false,
      title: "Invalid state",
      detail: "Malformed identifiers in the OAuth state.",
    });
  }
  const agentObjectId = new ObjectId(agent_id);
  const actionObjectId = new ObjectId(action_id);

  // Confirm the widget action is still pending — protects against replays
  // after the user already finished a previous attempt.
  const widgets = await widgetActionsCol();
  const action = await widgets.findOne({
    _id: actionObjectId,
    agent_id: agentObjectId,
    kind: "connect_integration",
  });
  if (!action) {
    return renderResult({
      ok: false,
      title: "Connection request not found",
      detail: "The chat request may have been cancelled. Try again from the chat.",
    });
  }
  if (action.status !== "pending") {
    return renderResult({
      ok: true,
      title: "Already connected",
      detail: "Google Calendar is already set up. You can close this window.",
    });
  }

  let credentials;
  try {
    const tokens = await exchangeCodeForTokens(code);
    credentials = buildCredentialsFromTokens(tokens);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    log.error("token exchange failed", { message });
    return renderResult({
      ok: false,
      title: "Could not complete sign-in",
      detail: message,
    });
  }

  try {
    const { added_tools } = await registerProviderForAgent(
      agent_id,
      "google_calendar",
      credentials as unknown as Record<string, unknown>,
    );
    log.info("google_calendar registered", { agent_id, added_tools });

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

    const emailLine = credentials.email
      ? ` Connected as ${credentials.email}.`
      : "";
    const effectMessage =
      `User connected Google Calendar.${emailLine} ${added_tools} runtime tool${added_tools === 1 ? "" : "s"} ` +
      `(check_availability, book_meeting) are now available on the agent. ` +
      `Ask the user — in one short message — whether they want to wire calendar checks into the workflow now ` +
      `(e.g., add a tool_call node that checks availability before quoting a time, or books the meeting at the end of the call). ` +
      `If they say yes, propose a concrete spot in the current workflow and use edit_workflow to add the node(s); if they say no or "later", acknowledge briefly and move on. ` +
      `Do NOT modify the workflow before they answer.`;
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
    return renderResult({
      ok: true,
      title: "Connected!",
      detail:
        "Google Calendar is now linked to this agent. This window will close.",
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
    return renderResult({
      ok: false,
      title: "Could not install Calendar tools",
      detail: message,
    });
  }
}
