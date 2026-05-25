/**
 * Provider connection + tool installation helpers.
 *
 *   - registerProviderForAgent: called from the widget-resolve route when
 *     the user pastes credentials. Stores the workspace integration, then
 *     installs each provider tool marked `default_install: true` on EVERY
 *     voice agent in the workspace (connect-time cascade).
 *   - backfillProviderToolsForAgent: ensures a single agent has all default
 *     tools from every workspace-connected integration. Called on agent
 *     load and on new-agent create so the cascade heals retroactively.
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
import { agentsCol, customToolsCol, integrationsCol } from "@/lib/mongodb";
import { findWorkspaceIntegration } from "./store";
import {
  createRuntimeTool,
  deleteRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import { externalToolIds, isLocalToolId } from "@/lib/elevenlabs/lifecycle/toolIds";
import {
  getProvider,
  findProviderTool,
  scopedToolName,
  type ProviderRuntimeToolSpec,
} from "./providers";
import { normalizeElevenlabsSchema } from "./schemaUtils";
import {
  injectCallerContextBlock,
  stripCallerContextBlock,
  CALLER_CONTEXT_VARS,
} from "./promptContext";
import type {
  AgentDocument,
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
/**
 * Build a deterministic, ElevenLabs-shaped id for tools whose phase is
 * pre_call / post_call. These tools are NOT registered upstream — they
 * run server-side from our lifecycle webhooks — so they need a synthetic
 * id that downstream code can recognise (anywhere that filters
 * `tool_ids` going to ElevenLabs strips entries starting with `local_`).
 */
function localToolId(): string {
  return `local_${randomBytes(8).toString("hex")}`;
}

/** Pre/post-call tools live entirely on our side; in_call still goes upstream. */
function isLifecycleTool(spec: ProviderRuntimeToolSpec): boolean {
  return spec.phase !== "in_call";
}

async function registerOne(
  spec: ProviderRuntimeToolSpec,
  ctx: RegisterContext,
): Promise<RuntimeTool | null> {
  const scopedName = scopedToolName(spec);
  if (ctx.agent.config_cache.tools.some((t) => t.name === scopedName)) {
    return null;
  }
  const url = `${getAppBaseUrl()}/api/integrations/${ctx.providerId}/proxy/${ctx.agentMongoId}/${scopedName}`;

  // Lifecycle tools (pre/post) skip ElevenLabs entirely. We persist the
  // spec in config_cache.tools so the lifecycle dispatcher can find it
  // when the workspace webhook fires, but EL never sees the tool — there's
  // no upstream tool_id, no tool_ids patch, no possibility of the LLM
  // accidentally invoking it mid-conversation.
  if (isLifecycleTool(spec)) {
    return {
      id: localToolId(),
      name: scopedName,
      type: "webhook",
      description: spec.description,
      phase: spec.phase,
      method: spec.method,
      url,
      provider: ctx.providerId,
    };
  }
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

/**
 * Install the provider's `default_install: true` tools on a single agent,
 * and inject the HubSpot caller-context prompt block if applicable.
 *
 * Idempotent: tools already present are skipped, the prompt block is only
 * re-injected when missing, and a no-op call returns 0 without touching
 * the DB. Errors registering an individual tool upstream are swallowed so
 * one bad spec doesn't poison the whole cascade — backfill on next agent
 * load retries.
 *
 * Integration connection state itself lives in the workspace-shared
 * `integrations` collection, not on the agent — there is nothing per-agent
 * to mark "connected" here.
 */
async function installProviderDefaultsForAgent(
  agent: AgentDocument,
  providerId: string,
  proxySecret: string,
): Promise<number> {
  const provider = getProvider(providerId);
  if (!provider) return 0;

  const ctx: RegisterContext = {
    agentMongoId: agent._id.toHexString(),
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

  // HubSpot is currently the only provider with caller-context prompt
  // injection. Re-inject only when the block isn't already present, so
  // we don't bump revisions for agents that already have it.
  const needsPromptInject =
    providerId === "hubspot" &&
    !agent.config_cache.system_prompt.includes("alta:caller_context:start");

  if (newTools.length === 0 && !needsPromptInject) {
    return 0;
  }

  const nextTools =
    newTools.length > 0
      ? [...agent.config_cache.tools, ...newTools]
      : agent.config_cache.tools;

  const nextSystemPrompt = needsPromptInject
    ? injectCallerContextBlock(agent.config_cache.system_prompt)
    : agent.config_cache.system_prompt;
  const nextDynamicVarPlaceholders: Record<string, string> | undefined =
    needsPromptInject
      ? Object.fromEntries(CALLER_CONTEXT_VARS.map((v) => [v, ""]))
      : undefined;

  // Only PATCH upstream when fields actually change — avoids gratuitous
  // ElevenLabs revisions for already-synced agents during backfill.
  const upstreamPatch: Record<string, unknown> = {};
  if (newTools.length > 0) {
    upstreamPatch.tool_ids = externalToolIds(nextTools);
  }
  if (needsPromptInject) {
    upstreamPatch.system_prompt = nextSystemPrompt;
    upstreamPatch.dynamic_variables = nextDynamicVarPlaceholders;
  }
  if (Object.keys(upstreamPatch).length > 0) {
    await patchAgent(agent.elevenlabs_agent_id, upstreamPatch);
  }

  const localPatch: Record<string, unknown> = {
    revision: agent.revision + 1,
    updated_at: new Date(),
  };
  if (newTools.length > 0) {
    localPatch["config_cache.tools"] = nextTools;
  }
  if (needsPromptInject) {
    localPatch["config_cache.system_prompt"] = nextSystemPrompt;
  }

  const agents = await agentsCol();
  await agents.updateOne({ _id: agent._id }, { $set: localPatch });

  return newTools.length;
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

  // Integrations are workspace-shared (any agent reuses the same OAuth
  // token + proxy_secret). Look up by provider alone — if HubSpot was
  // already connected by another agent in the workspace, reuse its row;
  // otherwise insert a new one stamped with this agent as the connector.
  const ints = await integrationsCol();
  const existing = await ints.findOne({ provider: providerId });
  const proxySecret =
    (existing?.metadata as { proxy_secret?: unknown } | undefined)
      ?.proxy_secret &&
    typeof (existing?.metadata as { proxy_secret?: unknown })?.proxy_secret ===
      "string"
      ? ((existing?.metadata as { proxy_secret: string }).proxy_secret as string)
      : randomBytes(32).toString("hex");

  await ints.updateOne(
    { provider: providerId },
    {
      $set: {
        status: "connected",
        credentials,
        metadata: { proxy_secret: proxySecret },
        connected_at: new Date(),
        updated_at: new Date(),
      },
      $setOnInsert: {
        // `agent_id` is informational here — names the agent that first
        // connected the provider in this workspace. Reads ignore it.
        agent_id: _id,
        provider: providerId,
        created_at: new Date(),
      },
    },
    { upsert: true },
  );

  // Workspace cascade: install the provider's default tools on every
  // voice agent. Each agent gets its own RuntimeTool rows (tool URLs
  // embed the agent id), so this is N parallel single-agent installs
  // sharing one workspace proxy_secret. Failures are isolated per-agent
  // — a transient ElevenLabs error on one agent doesn't break the rest;
  // backfill on next agent load retries. Skip the audience_builder
  // singleton ({$ne} also matches docs with no `kind` field — legacy
  // voice agents).
  const allAgents = await agents
    .find({ kind: { $ne: "audience_builder" } })
    .toArray();

  let primaryAddedTools = 0;
  for (const a of allAgents) {
    let added = 0;
    try {
      added = await installProviderDefaultsForAgent(a, providerId, proxySecret);
    } catch (err) {
      // Swallow per-agent failure — surfacing one bad cascade would make
      // the connecting user think the whole connect failed, when most of
      // the cascade likely succeeded.
      // eslint-disable-next-line no-console
      console.error(
        `[registerProviderForAgent] cascade install failed for agent ${a._id.toHexString()} provider=${providerId}:`,
        err,
      );
    }
    if (a._id.equals(_id)) primaryAddedTools = added;
  }

  return { added_tools: primaryAddedTools };
}

/**
 * Ensure a single agent has every default-install tool from every
 * workspace-connected integration. Called on agent load (heals agents
 * that pre-date workspace cascade or missed a cascade because EL was
 * flaky) and on new-agent create (new agents inherit the workspace's
 * connected providers immediately). Idempotent — already-installed
 * tools are skipped, so frequent calls are cheap.
 */
export async function backfillProviderToolsForAgent(
  agentMongoId: string,
): Promise<{ added_tools: number }> {
  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  let agent = await agents.findOne({ _id });
  if (!agent) return { added_tools: 0 };
  // Audience-builder is a workspace-internal chat host, not a voice
  // agent that needs provider tools.
  if (agent.kind === "audience_builder") return { added_tools: 0 };

  const ints = await integrationsCol();
  const rows = await ints.find({ status: "connected" }).toArray();

  let total = 0;
  for (const row of rows) {
    const proxySecret = (row.metadata as { proxy_secret?: unknown })
      ?.proxy_secret;
    if (typeof proxySecret !== "string") continue;
    let added = 0;
    try {
      added = await installProviderDefaultsForAgent(
        agent,
        row.provider,
        proxySecret,
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[backfillProviderToolsForAgent] failed for agent=${agentMongoId} provider=${row.provider}:`,
        err,
      );
      continue;
    }
    if (added > 0) {
      // Re-read so the next iteration sees the updated tools/prompt and
      // its own idempotency checks compare against fresh state.
      const refetched = await agents.findOne({ _id });
      if (refetched) agent = refetched;
      total += added;
    }
  }

  return { added_tools: total };
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

  // Workspace-shared lookup — any agent in the workspace can install a
  // tool against the shared integration once one has been connected.
  const integration = await findWorkspaceIntegration(providerId);
  if (!integration) {
    throw new Error(
      `${provider.name} is not connected in this workspace. Connect it on any agent first to provide an API token.`,
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
    tool_ids: externalToolIds(nextTools),
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
  // Lifecycle tools live entirely on our side — there's nothing upstream
  // for ElevenLabs to update or delete. Skip both the patch (the tool_ids
  // list wasn't going to change anyway) and the DELETE round-trip.
  if (!isLocalToolId(target.id)) {
    await patchAgent(agent.elevenlabs_agent_id, {
      tool_ids: externalToolIds(nextTools),
    });
    await deleteRuntimeTool(target.id).catch(() => {});
  }
  // Cascade: if this was a write_tool / create_custom_runtime_tool tool,
  // drop the backing custom_tools row so its proxy_secret + upstream spec
  // don't orphan when the UI/route-driven uninstall runs (the chat-driven
  // remove_runtime_tool already does the same cleanup).
  const customTools = await customToolsCol();
  await customTools
    .deleteOne({ agent_id: _id, elevenlabs_tool_id: target.id })
    .catch(() => {});
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

/**
 * Disconnect a workspace-shared provider and tear down its tools on a
 * specific agent. Marks the workspace `integrations` row as disconnected
 * (affects every agent's ability to use the token), strips the provider's
 * runtime tools off this agent's config, and removes the HubSpot
 * caller-context block from the system prompt when applicable. Other
 * agents in the workspace keep their provider-tool rows until their own
 * disconnect/cleanup runs — by design, since this is the per-agent
 * teardown side of a workspace-level state change.
 *
 * Returns the new state so the caller can return it to the client (HTTP
 * route) or fold it into a chat state_patch (capability).
 */
export async function disconnectProviderForAgent(
  agentMongoId: string,
  providerId: string,
): Promise<{
  revision: number;
  tools: RuntimeTool[];
  system_prompt?: string;
}> {
  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) throw new Error("Agent not found.");

  // Workspace-shared: mark the single workspace integration row as
  // disconnected (no agent_id filter — there's only one row per provider).
  const ints = await integrationsCol();
  await ints.updateOne(
    { provider: providerId },
    { $set: { status: "disconnected", updated_at: new Date() } },
  );

  const providerDef = getProvider(providerId);
  const toolNamesToRemove = new Set(
    providerDef?.runtime_tools.map((t) => scopedToolName(t)) ?? [],
  );
  const remainingTools = agent.config_cache.tools.filter(
    (t) => !toolNamesToRemove.has(t.name) && t.provider !== providerId,
  );

  // HubSpot is currently the only provider that injects a caller-context
  // block into the system prompt at connect time. Strip it on disconnect
  // so the agent doesn't keep referencing dynamic vars it can no longer
  // resolve.
  const isCrm = providerId === "hubspot";
  const nextSystemPrompt = isCrm
    ? stripCallerContextBlock(agent.config_cache.system_prompt)
    : agent.config_cache.system_prompt;

  await patchAgent(agent.elevenlabs_agent_id, {
    tool_ids: externalToolIds(remainingTools),
    ...(isCrm
      ? {
          system_prompt: nextSystemPrompt,
          dynamic_variables: {},
        }
      : {}),
  });

  const nextRevision = agent.revision + 1;
  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": remainingTools,
        ...(isCrm ? { "config_cache.system_prompt": nextSystemPrompt } : {}),
        revision: nextRevision,
        updated_at: new Date(),
      },
    },
  );

  return {
    revision: nextRevision,
    tools: remainingTools,
    ...(isCrm ? { system_prompt: nextSystemPrompt } : {}),
  };
}
