import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { agentsCol, messagesCol, widgetActionsCol } from "@/lib/mongodb";
import {
  getAgent,
  projectAgentConfig,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import { ChatPanel } from "@/components/builder/ChatPanel";
import { VisualPanel } from "@/components/builder/VisualPanel";
import { BuilderHydrator } from "@/components/builder/BuilderHydrator";
import type { AgentDTO } from "@/types/agent";
import type { ChatTurn, WidgetEntry } from "@/store/agentStore";

export const dynamic = "force-dynamic";

export default async function AgentBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();

  const col = await agentsCol();
  const doc = await col.findOne({ _id: new ObjectId(id) });
  if (!doc) notFound();

  let configCache = doc.config_cache;
  try {
    const el = await getAgent(doc.elevenlabs_agent_id);
    configCache = projectAgentConfig(el, doc.config_cache);
  } catch (err) {
    if (!(err instanceof ElevenLabsError)) throw err;
  }

  const messages = await (await messagesCol())
    .find({ agent_id: doc._id })
    .sort({ created_at: 1 })
    .toArray();

  const turns: ChatTurn[] = messages.map((m) => ({
    id: m._id.toHexString(),
    role: m.role,
    content: m.content,
  }));

  const widgetDocs = await (await widgetActionsCol())
    .find({ agent_id: doc._id })
    .sort({ created_at: 1 })
    .limit(50)
    .toArray();
  const widgets: WidgetEntry[] = widgetDocs.map((w) => ({
    action_id: w._id.toHexString(),
    kind: w.kind,
    payload: w.payload,
    status: w.status,
    result: w.result,
  }));

  const dto: AgentDTO = {
    id: doc._id.toHexString(),
    elevenlabs_agent_id: doc.elevenlabs_agent_id,
    name: doc.name,
    description: doc.description,
    revision: doc.revision,
    config_cache: configCache,
    last_error: doc.last_error,
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at.toISOString(),
  };

  return (
    <div className="builder-shell">
      <BuilderHydrator agent={dto} turns={turns} widgets={widgets} />
      <div className="builder-split">
        <section className="builder-chat">
          <ChatPanel agentId={dto.id} />
        </section>
        <section className="builder-canvas">
          <VisualPanel agentId={dto.id} />
        </section>
      </div>
    </div>
  );
}

