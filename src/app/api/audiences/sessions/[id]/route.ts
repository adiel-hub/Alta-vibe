/**
 * Single audience-builder chat session — fetch its messages or delete it
 * entirely (the session row plus its scoped chat_messages). DELETE is what
 * the sidebar's overflow "Remove chat" hits.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import {
  audienceChatSessionsCol,
  messagesCol,
  widgetActionsCol,
} from "@/lib/mongodb";
import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";
import type { ChatMessageDTO } from "@/types/agent";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("api", {
    route: "GET /api/audiences/sessions/[id]",
    req_id: newRequestId(),
  });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const sessionId = new ObjectId(id);

  const session = await (await audienceChatSessionsCol()).findOne({
    _id: sessionId,
  });
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const messages = await (await messagesCol())
    .find({ chat_session_id: sessionId })
    .sort({ created_at: 1 })
    .toArray();
  const dtos: ChatMessageDTO[] = messages
    .filter((m) => !m.panel_action)
    .map((m) => ({
      id: m._id.toHexString(),
      role: m.role,
      content: m.content,
      turn_job_id: m.turn_job_id?.toHexString(),
      revision_before: m.revision_before,
      revision_after: m.revision_after,
      created_at: m.created_at.toISOString(),
    }));

  return NextResponse.json({
    session: {
      id: session._id.toHexString(),
      agent_id: session.agent_id.toHexString(),
      title: session.title,
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
      last_message_at: session.last_message_at.toISOString(),
    },
    messages: dtos,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const log = createLogger("api", {
    route: "DELETE /api/audiences/sessions/[id]",
    req_id: newRequestId(),
  });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const sessionId = new ObjectId(id);
  const agent = await getOrCreateAudienceBuilderAgent();

  await Promise.all([
    (await messagesCol()).deleteMany({
      agent_id: agent._id,
      chat_session_id: sessionId,
    }),
    (await widgetActionsCol()).deleteMany({
      agent_id: agent._id,
      chat_session_id: sessionId,
    } as Record<string, unknown>),
    (await audienceChatSessionsCol()).deleteOne({ _id: sessionId }),
  ]);
  log.info("session deleted", { session_id: id });
  return NextResponse.json({ ok: true });
}
