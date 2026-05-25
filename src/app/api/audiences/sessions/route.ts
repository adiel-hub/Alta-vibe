/**
 * Audience-builder chat sessions: create + list. Each session slices the
 * singleton audience_builder agent's chat_message log so the user can hold
 * multiple parallel audience-build conversations and resume any of them
 * from the sidebar.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireSharedSecret } from "@/lib/auth";
import {
  audienceChatSessionsCol,
  messagesCol,
} from "@/lib/mongodb";
import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TITLE = "New audience chat";

export async function GET(req: NextRequest) {
  const log = createLogger("api", {
    route: "GET /api/audiences/sessions",
    req_id: newRequestId(),
  });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const agent = await getOrCreateAudienceBuilderAgent();
  const sessions = await (await audienceChatSessionsCol())
    .find({ agent_id: agent._id })
    .sort({ last_message_at: -1 })
    .limit(200)
    .toArray();
  const messages = await messagesCol();

  // Cheap count per session for the sidebar.
  const items = await Promise.all(
    sessions.map(async (s) => ({
      id: s._id.toHexString(),
      title: s.title,
      created_at: s.created_at.toISOString(),
      updated_at: s.updated_at.toISOString(),
      last_message_at: s.last_message_at.toISOString(),
      message_count: await messages.countDocuments({ chat_session_id: s._id }),
    })),
  );
  return NextResponse.json({ sessions: items });
}

export async function POST(req: NextRequest) {
  const log = createLogger("api", {
    route: "POST /api/audiences/sessions",
    req_id: newRequestId(),
  });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const agent = await getOrCreateAudienceBuilderAgent();
  const now = new Date();
  const insert = await (await audienceChatSessionsCol()).insertOne({
    agent_id: agent._id,
    title: DEFAULT_TITLE,
    created_at: now,
    updated_at: now,
    last_message_at: now,
  } as never);
  const id = insert.insertedId.toHexString();
  log.info("session created", { session_id: id });
  return NextResponse.json({
    id,
    agent_id: agent._id.toHexString(),
    title: DEFAULT_TITLE,
  });
}
