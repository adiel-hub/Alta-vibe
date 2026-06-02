import { getOrCreateAudienceBuilderAgent } from "@/lib/audiences/builderAgent";
import { AudienceBuilderEntry } from "@/components/audiences/AudienceBuilderEntry";
import { BuilderHydrator } from "@/components/builder/BuilderHydrator";
import type { AgentDTO } from "@/types/agent";

export const dynamic = "force-dynamic";

/**
 * Hero entry for "Build a list" — no session bound yet. Submitting the hero
 * form creates a chat_session row and routes to /audiences/build/[id], where
 * the actual chat lives. Keeping the hero on its own route means past chats
 * stay untouched while the user composes a new one.
 *
 * We still hydrate the store with the agent dto + empty turns so the
 * embedded ChatPanel doesn't crash if the user types fast enough to race
 * the session-creation roundtrip.
 */
export default async function AudienceBuilderChatPage() {
  const agent = await getOrCreateAudienceBuilderAgent();
  const agentMongoId = agent._id.toHexString();

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
      <BuilderHydrator agent={dto} turns={[]} widgets={[]} />
      <AudienceBuilderEntry agentId={agentMongoId} />
    </div>
  );
}
