/**
 * Side-effect helper: after a user finishes connecting a provider via the
 * widget flow, register that provider's runtime_tools on the agent and add
 * a ConnectedIntegration entry to its config_cache.
 *
 * This is the only place that needs to know "what does connecting hubspot
 * actually do." Adding a provider is one entry in providers.ts.
 */
import { ObjectId } from "mongodb";
import { agentsCol, integrationsCol } from "@/lib/mongodb";
import {
  createRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import { getProvider } from "./providers";
import type {
  ConnectedIntegration,
  RuntimeTool,
} from "@/types/agent";

export async function registerProviderForAgent(
  agentMongoId: string,
  providerId: string,
  credentials: Record<string, unknown>,
): Promise<{ added_tools: number }> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}"`);

  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) throw new Error("Agent not found");

  const ints = await integrationsCol();
  await ints.updateOne(
    { agent_id: _id, provider: providerId },
    {
      $set: {
        status: "connected",
        credentials,
        metadata: {},
        connected_at: new Date(),
        updated_at: new Date(),
      },
      $setOnInsert: {
        agent_id: _id,
        provider: providerId,
        created_at: new Date(),
      },
    },
    { upsert: true },
  );

  const existingNames = new Set(agent.config_cache.tools.map((t) => t.name));
  const newTools: RuntimeTool[] = [];
  for (const spec of provider.runtime_tools) {
    const scopedName = spec.phase === "in_call" ? spec.name : `${spec.phase}__${spec.name}`;
    if (existingNames.has(scopedName)) continue;
    const url = provider.base_api_url + spec.path;
    const created = await createRuntimeTool({
      name: scopedName,
      description: spec.description,
      type: "webhook",
      phase: spec.phase,
      api_schema: { url, method: spec.method },
    }).catch(() => null);
    if (!created) continue;
    newTools.push({
      id: created.id,
      name: scopedName,
      type: "webhook",
      description: spec.description,
      phase: spec.phase,
      method: spec.method,
      url,
      provider: providerId,
    });
  }

  const nextTools = [...agent.config_cache.tools, ...newTools];
  const integration: ConnectedIntegration = {
    id: providerId,
    provider: providerId,
    display_name: provider.name,
    status: "connected",
    connected_at: new Date().toISOString(),
  };
  const nextIntegrations = [
    ...agent.config_cache.integrations.filter((i) => i.provider !== providerId),
    integration,
  ];

  await patchAgent(agent.elevenlabs_agent_id, {
    tools: nextTools.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      description: t.description,
    })),
  });

  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": nextTools,
        "config_cache.integrations": nextIntegrations,
        revision: agent.revision + 1,
        updated_at: new Date(),
      },
    },
  );

  return { added_tools: newTools.length };
}
