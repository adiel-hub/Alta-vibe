import { ObjectId } from "mongodb";
import { notFound } from "next/navigation";
import {
  audienceChatSessionsCol,
  messagesCol,
  widgetActionsCol,
} from "@/lib/mongodb";
import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";
import { AudienceBuilderEntry } from "@/components/audiences/AudienceBuilderEntry";
import { BuilderHydrator } from "@/components/builder/BuilderHydrator";
import type { AgentDTO } from "@/types/agent";
import type { ChatTurn, WidgetEntry } from "@/store/agentStore";

export const dynamic = "force-dynamic";

/**
 * Resume a specific audience-builder chat. The page hydrates the store from
 * the session's persisted messages and widgets, then mounts the embedded
 * ChatPanel scoped to this session_id so new turns continue to land in the
 * same thread.
 */
export default async function AudienceBuilderSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) return notFound();
  const sessionOid = new ObjectId(sessionId);

  const session = await (await audienceChatSessionsCol()).findOne({
    _id: sessionOid,
  });
  if (!session) return notFound();

  const agent = await getOrCreateAudienceBuilderAgent();
  const agentMongoId = agent._id.toHexString();

  const messages = await (await messagesCol())
    .find({ chat_session_id: sessionOid })
    .sort({ created_at: 1 })
    .toArray();
  const turns: ChatTurn[] = messages
    .filter((m) => !m.panel_action)
    .map((m) => ({
      id: m._id.toHexString(),
      role: m.role,
      content: m.content,
    }));

  const widgetDocs = await (await widgetActionsCol())
    .find({
      agent_id: agent._id,
      chat_session_id: sessionOid,
    } as Record<string, unknown>)
    .sort({ created_at: 1 })
    .limit(50)
    .toArray();
  const widgets: WidgetEntry[] = widgetDocs.map((w) => ({
    action_id: w._id.toHexString(),
    kind: w.kind,
    payload: w.payload,
    status: w.status,
    result: w.result,
    tool_use_id: w.tool_use_id ?? undefined,
  }));

  const dto: AgentDTO = {
    id: agentMongoId,
    elevenlabs_agent_id: agent.elevenlabs_agent_id,
    name: agent.name,
    description: agent.description,
    revision: agent.revision,
    config_cache: agent.config_cache,
    last_error: agent.last_error,
    created_at: agent.created_at.toISOString(),
    updated_at: agent.updated_at.toISOString(),
  };

  return (
    <div className="flex h-full flex-col">
      <BuilderHydrator agent={dto} turns={turns} widgets={widgets} />
      <AudienceBuilderEntry agentId={agentMongoId} sessionId={sessionId} />
    </div>
  );
}
