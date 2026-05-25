/**
 * Initiates Google OAuth for the Calendar integration.
 *
 * The browser POSTs `{ agent_id, action_id }`; we sign those into a
 * short-lived state token and return Google's authorize URL. The widget
 * opens it in a popup; Google redirects back to /oauth/callback with the
 * same state, which we verify before exchanging the auth code.
 *
 * Authenticated with the same shared-secret gate as the other API routes.
 * The state token itself binds the redirect to a specific agent + pending
 * widget action, so an attacker who somehow obtains the authorize URL
 * still can't redirect the connection at a different agent.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { widgetActionsCol } from "@/lib/mongodb";
import { buildAuthorizeUrl, signOAuthState } from "@/lib/integrations/google/auth";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  agent_id: z.string().min(1),
  action_id: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const log = createLogger("integration", {
    route: "POST /integrations/google_calendar/oauth/start",
    req_id: newRequestId(),
  });
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { agent_id, action_id } = parsed.data;
  if (!ObjectId.isValid(agent_id) || !ObjectId.isValid(action_id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
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
      { error: "No pending Google connect action for this agent." },
      { status: 404 },
    );
  }

  try {
    const state = signOAuthState({ agent_id, action_id });
    const url = buildAuthorizeUrl(state);
    log.info("authorize url issued", { agent_id, action_id });
    return NextResponse.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth start failed";
    log.error("authorize url failed", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
