/**
 * Side-effect helper: after the user pastes their provider credentials in
 * the chat widget, register that provider's runtime tools on the agent
 * and add a ConnectedIntegration entry to its config_cache.
 *
 * Tool URLs all point at our proxy (`/api/integrations/.../proxy/...`),
 * not directly at the upstream API. The proxy verifies a per-integration
 * `proxy_secret` bearer (stored on the integration doc + sent by the
 * runtime tool's `request_headers`) and attaches the real token before
 * forwarding upstream. Storing only `proxy_secret` on ElevenLabs means
 * a leak of their tool config never leaks the client's real CRM token.
 */
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { agentsCol, integrationsCol } from "@/lib/mongodb";
import {
  createRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import { getProvider } from "./providers";
import { injectCallerContextBlock, CALLER_CONTEXT_VARS } from "./promptContext";
import type {
  ConnectedIntegration,
  RuntimeTool,
} from "@/types/agent";

function getAppBaseUrl(): string {
  const url =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

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

  const proxySecret = randomBytes(32).toString("hex");

  const ints = await integrationsCol();
  await ints.updateOne(
    { agent_id: _id, provider: providerId },
    {
      $set: {
        status: "connected",
        credentials,
        metadata: { proxy_secret: proxySecret },
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

  const baseUrl = getAppBaseUrl();
  const existingNames = new Set(agent.config_cache.tools.map((t) => t.name));
  const newTools: RuntimeTool[] = [];
  for (const spec of provider.runtime_tools) {
    const scopedName = spec.phase === "in_call" ? spec.name : `${spec.phase}__${spec.name}`;
    if (existingNames.has(scopedName)) continue;
    const url = `${baseUrl}/api/integrations/${providerId}/proxy/${agentMongoId}/${scopedName}`;
    const created = await createRuntimeTool({
      name: scopedName,
      description: spec.description,
      type: "webhook",
      phase: spec.phase,
      api_schema: {
        url,
        method: spec.method,
        request_headers: {
          Authorization: `Bearer ${proxySecret}`,
        },
      },
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

  // For HubSpot (the only provider with pre-call enrichment in v1), inject
  // a delimited caller-context block into the system prompt and seed empty
  // placeholders for the dynamic variables we'll populate per-call.
  const nextSystemPrompt =
    providerId === "hubspot"
      ? injectCallerContextBlock(agent.config_cache.system_prompt)
      : agent.config_cache.system_prompt;
  const nextDynamicVarPlaceholders: Record<string, string> | undefined =
    providerId === "hubspot"
      ? Object.fromEntries(CALLER_CONTEXT_VARS.map((v) => [v, ""]))
      : undefined;

  await patchAgent(agent.elevenlabs_agent_id, {
    tool_ids: nextTools.map((t) => t.id),
    ...(providerId === "hubspot"
      ? {
          system_prompt: nextSystemPrompt,
          dynamic_variables: nextDynamicVarPlaceholders,
        }
      : {}),
  });

  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": nextTools,
        "config_cache.integrations": nextIntegrations,
        ...(providerId === "hubspot"
          ? { "config_cache.system_prompt": nextSystemPrompt }
          : {}),
        revision: agent.revision + 1,
        updated_at: new Date(),
      },
    },
  );

  return { added_tools: newTools.length };
}
