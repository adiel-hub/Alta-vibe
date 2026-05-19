/**
 * Provider connection + tool installation helpers.
 *
 *   - registerProviderForAgent: called from the widget-resolve route when
 *     the user pastes credentials. Stores the integration, then installs
 *     each tool spec marked `default_install: true` on the provider.
 *   - installProviderTool: installs a single named tool on an
 *     already-connected provider. Used by the `install_provider_tool`
 *     capability and the Tools-tab UI to expand coverage beyond the
 *     defaults.
 *   - uninstallProviderTool: removes a single tool from the agent.
 *
 * All registered tools point at our proxy
 * (`/api/integrations/<provider>/proxy/<agentId>/<scoped-name>`), not
 * directly at the upstream API. The proxy verifies a per-integration
 * `proxy_secret` bearer (stored on the integration doc + sent by the
 * runtime tool's `request_headers`) and attaches the real token before
 * forwarding upstream — so a leak of ElevenLabs' tool config never leaks
 * the client's real CRM token.
 */
import { randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { agentsCol, integrationsCol } from "@/lib/mongodb";
import {
  createRuntimeTool,
  deleteRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import {
  getProvider,
  findProviderTool,
  scopedToolName,
  type ProviderRuntimeToolSpec,
} from "./providers";
import { normalizeElevenlabsSchema } from "./schemaUtils";
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

type RegisterContext = {
  agentMongoId: string;
  providerId: string;
  proxySecret: string;
  agent: { config_cache: { tools: RuntimeTool[] } };
};

/**
 * Register a single ProviderRuntimeToolSpec on ElevenLabs, pointing at
 * our proxy. Returns the new RuntimeTool entry on success, or null if
 * already installed.
 */
async function registerOne(
  spec: ProviderRuntimeToolSpec,
  ctx: RegisterContext,
): Promise<RuntimeTool | null> {
  const scopedName = scopedToolName(spec);
  if (ctx.agent.config_cache.tools.some((t) => t.name === scopedName)) {
    return null;
  }
  const url = `${getAppBaseUrl()}/api/integrations/${ctx.providerId}/proxy/${ctx.agentMongoId}/${scopedName}`;
  // ElevenLabs uses different schema-shape requirements for body vs query;
  // route the spec's shapes into whichever side the LLM will be asked to
  // produce values for. Methods without bodies (GET/DELETE) get the
  // body_schema content promoted into query_params_schema if no explicit
  // query_schema was provided — that way `contactId` etc. show up in the
  // tool signature the LLM sees.
  const requestBodySchema =
    spec.method === "GET" || spec.method === "DELETE"
      ? undefined
      : normalizeElevenlabsSchema(spec.body_schema, "body");
  const queryParamsSchema =
    spec.query_schema !== undefined
      ? normalizeElevenlabsSchema(spec.query_schema, "query")
      : spec.method === "GET" || spec.method === "DELETE"
        ? normalizeElevenlabsSchema(
            // Use the body_schema's `properties` block as a fallback,
            // since GET/DELETE can't carry a body.
            spec.body_schema
              ? (() => {
                  const p = (spec.body_schema as { properties?: unknown }).properties;
                  return p && typeof p === "object"
                    ? { properties: p, ...(((spec.body_schema as { required?: unknown }).required) ? { required: (spec.body_schema as { required?: string[] }).required } : {}) }
                    : undefined;
                })()
              : undefined,
            "query",
          )
        : undefined;

  const created = await createRuntimeTool({
    name: scopedName,
    description: spec.description,
    type: "webhook",
    phase: spec.phase,
    api_schema: {
      url,
      // ElevenLabs' api_schema.method enum doesn't include PATCH; the
      // proxy itself accepts PATCH from any method. Send POST upstream
      // for PATCH-flavored mutations and let our handler re-issue with
      // the correct verb — but actually ElevenLabs DOES support PATCH
      // as of the 2026-03 release, so try the spec method first and
      // fall back if it 422s.
      method: spec.method === "PATCH" ? ("POST" as const) : spec.method,
      request_headers: {
        Authorization: `Bearer ${ctx.proxySecret}`,
      },
      ...(requestBodySchema ? { request_body_schema: requestBodySchema } : {}),
      ...(queryParamsSchema ? { query_params_schema: queryParamsSchema } : {}),
    },
  });
  return {
    id: created.id,
    name: scopedName,
    type: "webhook",
    description: spec.description,
    phase: spec.phase,
    method: spec.method,
    url,
    provider: ctx.providerId,
  };
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

  // Reuse an existing proxy_secret if this provider was previously
  // connected — that way already-installed tools (and their
  // ElevenLabs-side Authorization bearers) keep working across reconnects.
  const ints = await integrationsCol();
  const existing = await ints.findOne({
    agent_id: _id,
    provider: providerId,
  });
  const proxySecret =
    (existing?.metadata as { proxy_secret?: unknown } | undefined)
      ?.proxy_secret &&
    typeof (existing?.metadata as { proxy_secret?: unknown })?.proxy_secret ===
      "string"
      ? ((existing?.metadata as { proxy_secret: string }).proxy_secret as string)
      : randomBytes(32).toString("hex");

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

  const ctx: RegisterContext = {
    agentMongoId,
    providerId,
    proxySecret,
    agent: { config_cache: { tools: agent.config_cache.tools } },
  };

  const newTools: RuntimeTool[] = [];
  for (const spec of provider.runtime_tools) {
    if (!spec.default_install) continue;
    const entry = await registerOne(spec, ctx).catch(() => null);
    if (entry) newTools.push(entry);
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

/**
 * Install a single provider tool by key onto an already-connected agent.
 * Returns the new RuntimeTool entry, or throws if the provider isn't
 * connected, the tool key is unknown, or the tool is already installed.
 */
export async function installProviderTool(
  agentMongoId: string,
  providerId: string,
  toolKey: string,
): Promise<RuntimeTool> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);
  const spec = findProviderTool(providerId, toolKey);
  if (!spec) {
    throw new Error(
      `Provider "${providerId}" has no tool with key/name "${toolKey}".`,
    );
  }

  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) throw new Error("Agent not found.");

  const ints = await integrationsCol();
  const integration = await ints.findOne({
    agent_id: _id,
    provider: providerId,
    status: "connected",
  });
  if (!integration) {
    throw new Error(
      `${provider.name} is not connected to this agent. Connect it first to provide an API token.`,
    );
  }
  const proxySecret = (integration.metadata as { proxy_secret?: unknown })
    .proxy_secret;
  if (typeof proxySecret !== "string") {
    throw new Error(
      `${provider.name} integration is missing a proxy_secret. Reconnect to repair.`,
    );
  }

  const scopedName = scopedToolName(spec);
  if (agent.config_cache.tools.some((t) => t.name === scopedName)) {
    throw new Error(
      `Tool "${scopedName}" is already installed on this agent.`,
    );
  }

  const entry = await registerOne(spec, {
    agentMongoId,
    providerId,
    proxySecret,
    agent: { config_cache: { tools: agent.config_cache.tools } },
  });
  if (!entry) {
    throw new Error(
      `Failed to register "${scopedName}" with the voice platform.`,
    );
  }

  const nextTools = [...agent.config_cache.tools, entry];
  await patchAgent(agent.elevenlabs_agent_id, {
    tool_ids: nextTools.map((t) => t.id),
  });
  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": nextTools,
        revision: agent.revision + 1,
        updated_at: new Date(),
      },
    },
  );
  return entry;
}

/**
 * Remove a provider-sourced tool from the agent by its installed name or
 * id. Deletes the ElevenLabs runtime-tool record too.
 */
export async function uninstallProviderTool(
  agentMongoId: string,
  identifier: { id?: string; name?: string },
): Promise<{ removed_id: string; remaining: RuntimeTool[] }> {
  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) throw new Error("Agent not found.");

  const target = agent.config_cache.tools.find(
    (t) => (identifier.id && t.id === identifier.id) || (identifier.name && t.name === identifier.name),
  );
  if (!target) {
    throw new Error(
      `No tool matching ${JSON.stringify(identifier)} is installed.`,
    );
  }

  const nextTools = agent.config_cache.tools.filter((t) => t.id !== target.id);
  await patchAgent(agent.elevenlabs_agent_id, {
    tool_ids: nextTools.map((t) => t.id),
  });
  await deleteRuntimeTool(target.id).catch(() => {});
  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": nextTools,
        revision: agent.revision + 1,
        updated_at: new Date(),
      },
    },
  );
  return { removed_id: target.id, remaining: nextTools };
}
