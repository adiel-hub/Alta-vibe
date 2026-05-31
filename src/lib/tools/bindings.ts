/**
 * Tool bindings — the workflow's tool inventory.
 *
 * The workflow document is the single source of truth for which tools an
 * agent has. `config_cache.tools` is derived from `workflow.bindings` by
 * `deriveConfigTools` and re-computed on every mutation. Nothing else
 * writes to `config_cache.tools` directly — install / uninstall / custom
 * tool create / remove all funnel through the helpers in this module.
 *
 * Why this exists: the prior model had four independent writers stamping
 * `config.tools` in parallel, which let it drift from the workflow that
 * referenced its ids. The drift surfaced to users as "orphan" tools that
 * couldn't be removed because the local id no longer matched anything in
 * the DB. With bindings as the input and `config.tools` as the output,
 * the orphan class is structurally impossible.
 */
import { randomBytes } from "node:crypto";
import { ObjectId, type Filter } from "mongodb";
import { agentsCol, customToolsCol } from "@/lib/mongodb";
import {
  createRuntimeTool,
  deleteRuntimeTool,
} from "@/lib/elevenlabs/client";
import { patchAgent } from "@/lib/elevenlabs/client";
import { externalToolIds, isLocalToolId } from "@/lib/elevenlabs/lifecycle/toolIds";
import { normalizeElevenlabsSchema } from "@/lib/integrations/schemaUtils";
import {
  PROVIDERS,
  findProviderTool,
  findSpecByToolName,
  getProvider,
  scopedToolName,
} from "@/lib/integrations/providers";
import type {
  IntegrationProvider,
  ProviderRuntimeToolSpec,
} from "@/lib/integrations/providers/types";
import type { AgentPatch } from "@/lib/elevenlabs/agents/types";
import type {
  AgentDocument,
  CustomToolDocument,
  RuntimePhase,
  RuntimeTool,
  ToolBinding,
  WorkflowState,
} from "@/types/agent";
import { createLogger } from "@/lib/logger";

const log = createLogger("tool-bindings");

function getAppBaseUrl(): string {
  const url =
    process.env.APP_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

function localToolId(): string {
  return `local_${randomBytes(8).toString("hex")}`;
}

function isLifecycle(phase: RuntimePhase): boolean {
  return phase !== "in_call";
}

// ── Resolution: binding → RuntimeTool ──────────────────────────────────

/**
 * Resolve one binding into a RuntimeTool. Provider bindings reconstruct
 * their entry from the catalog spec + the workspace proxy_secret URL
 * shape; custom bindings read the `custom_tools` row. Returns null when
 * the binding is unresolvable (e.g. the custom_tools row was deleted, or
 * the provider/spec went away in a code update) — the caller drops it.
 */
async function resolveBinding(
  binding: ToolBinding,
  agentMongoId: string,
  customToolsCache: Map<string, CustomToolDocument>,
): Promise<RuntimeTool | null> {
  if (binding.kind === "provider") {
    const spec = findProviderTool(binding.provider, binding.tool_key);
    if (!spec) {
      log.warn("dropping binding: provider spec missing", {
        provider: binding.provider,
        tool_key: binding.tool_key,
      });
      return null;
    }
    const scoped = scopedToolName(spec);
    const url = `${getAppBaseUrl()}/api/integrations/${binding.provider}/proxy/${agentMongoId}/${scoped}`;
    return {
      id: binding.elevenlabs_tool_id,
      name: scoped,
      type: "webhook",
      description: spec.description,
      phase: spec.phase,
      method: spec.method,
      url,
      provider: binding.provider,
    };
  }
  const doc = customToolsCache.get(binding.custom_tool_id);
  if (!doc) {
    log.warn("dropping binding: custom_tools row missing", {
      custom_tool_id: binding.custom_tool_id,
    });
    return null;
  }
  return {
    id: binding.elevenlabs_tool_id,
    name: doc.name,
    type: "webhook",
    description: doc.description,
    phase: doc.phase,
    method: doc.upstream.method,
    url: `${getAppBaseUrl()}/api/custom-tools/proxy/${agentMongoId}/${doc._id.toHexString()}`,
  };
}

async function loadCustomToolsCache(
  agentMongoId: string,
): Promise<Map<string, CustomToolDocument>> {
  const docs = await (await customToolsCol())
    .find({ agent_id: new ObjectId(agentMongoId) })
    .toArray();
  return new Map(docs.map((d) => [d._id.toHexString(), d]));
}

/**
 * Derive `config_cache.tools` from a workflow's bindings. Drops any
 * binding that can't be resolved (cleaning up orphans automatically).
 * Returns both the derived tools and the surviving bindings — the caller
 * persists both atomically.
 */
export async function deriveFromBindings(
  bindings: ToolBinding[],
  agentMongoId: string,
): Promise<{ tools: RuntimeTool[]; bindings: ToolBinding[] }> {
  const cache = await loadCustomToolsCache(agentMongoId);
  const tools: RuntimeTool[] = [];
  const survivors: ToolBinding[] = [];
  for (const b of bindings) {
    const t = await resolveBinding(b, agentMongoId, cache);
    if (!t) continue;
    tools.push(t);
    survivors.push(b);
  }
  return { tools, bindings: survivors };
}

// ── Registration: get / create the ElevenLabs runtime-tool ────────────

/**
 * Register a provider spec with ElevenLabs and return its tool id. For
 * lifecycle (pre/post-call) tools, mints a synthetic `local_…` id —
 * ElevenLabs never sees those.
 */
async function registerProviderSpec(
  spec: ProviderRuntimeToolSpec,
  providerId: string,
  agentMongoId: string,
  proxySecret: string,
): Promise<string> {
  if (isLifecycle(spec.phase)) return localToolId();

  const scoped = scopedToolName(spec);
  const url = `${getAppBaseUrl()}/api/integrations/${providerId}/proxy/${agentMongoId}/${scoped}`;

  const requestBodySchema =
    spec.method === "GET" || spec.method === "DELETE"
      ? undefined
      : normalizeElevenlabsSchema(spec.body_schema, "body");
  const queryParamsSchema =
    spec.query_schema !== undefined
      ? normalizeElevenlabsSchema(spec.query_schema, "query")
      : spec.method === "GET" || spec.method === "DELETE"
        ? normalizeElevenlabsSchema(
            spec.body_schema
              ? (() => {
                  const p = (spec.body_schema as { properties?: unknown })
                    .properties;
                  return p && typeof p === "object"
                    ? {
                        properties: p,
                        ...(((spec.body_schema as { required?: unknown })
                          .required)
                          ? {
                              required: (
                                spec.body_schema as { required?: string[] }
                              ).required,
                            }
                          : {}),
                      }
                    : undefined;
                })()
              : undefined,
            "query",
          )
        : undefined;

  const created = await createRuntimeTool({
    name: scoped,
    description: spec.description,
    type: "webhook",
    phase: spec.phase,
    api_schema: {
      url,
      method: spec.method === "PATCH" ? ("POST" as const) : spec.method,
      request_headers: { Authorization: `Bearer ${proxySecret}` },
      ...(requestBodySchema ? { request_body_schema: requestBodySchema } : {}),
      ...(queryParamsSchema ? { query_params_schema: queryParamsSchema } : {}),
    },
  });
  return created.id;
}

// ── Migration: legacy config.tools → bindings ──────────────────────────

/**
 * Reverse-engineer bindings from a legacy `config_cache.tools` array.
 * Used on first read of an agent that pre-dates the bindings refactor.
 *
 * Strategy:
 *   - `provider` field set → look up the matching ProviderRuntimeToolSpec
 *     by name. Skip if the spec isn't in PROVIDERS anymore.
 *   - No `provider` → match against any provider spec by name (legacy
 *     entries from before `provider` was stamped). Fall through to
 *     `custom_tools` lookup if no spec matches.
 *
 * Anything that resolves becomes a binding; everything else gets dropped
 * (those were the orphans).
 */
export async function bindingsFromLegacyTools(
  legacyTools: RuntimeTool[],
  agentMongoId: string,
): Promise<{ bindings: ToolBinding[]; dropped: string[] }> {
  const customDocs = await loadCustomToolsCache(agentMongoId);
  const byElevenId = new Map<string, CustomToolDocument>();
  for (const doc of customDocs.values()) {
    byElevenId.set(doc.elevenlabs_tool_id, doc);
  }

  const bindings: ToolBinding[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const t of legacyTools) {
    const dedup = `${t.provider ?? ""}::${t.name}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    let spec: ProviderRuntimeToolSpec | undefined;
    let providerId: string | undefined;
    if (t.provider) {
      spec = findProviderTool(t.provider, t.name);
      providerId = t.provider;
    } else {
      spec = findSpecByToolName(t.name);
      providerId = spec
        ? PROVIDERS.find((p: IntegrationProvider) => p.runtime_tools.includes(spec!))?.id
        : undefined;
    }

    if (spec && providerId) {
      bindings.push({
        kind: "provider",
        provider: providerId,
        tool_key: spec.key,
        phase: spec.phase,
        elevenlabs_tool_id: t.id,
      });
      continue;
    }

    // Try custom_tools — match by ElevenLabs tool id (most reliable) or
    // by name as a fallback for older custom tools.
    const customByEl = byElevenId.get(t.id);
    const customByName = customByEl
      ? null
      : Array.from(customDocs.values()).find((d) => d.name === t.name) ?? null;
    const custom = customByEl ?? customByName;
    if (custom) {
      bindings.push({
        kind: "custom",
        custom_tool_id: custom._id.toHexString(),
        phase: custom.phase,
        elevenlabs_tool_id: custom.elevenlabs_tool_id,
      });
      continue;
    }

    dropped.push(t.name);
  }

  return { bindings, dropped };
}

// ── Atomic update: bindings → derived tools → upstream patch ──────────

/**
 * Persist a new set of bindings on the agent. Derives the new
 * `config_cache.tools`, writes both atomically, bumps revision, and
 * sends the resulting `tool_ids` patch to ElevenLabs.
 *
 * Returns the new derived `tools` so callers (HTTP routes, capability
 * handlers) can hand it back to the UI / chat-state-patch.
 */
export async function setBindings(
  agentMongoId: string,
  nextBindings: ToolBinding[],
  options: { skipUpstream?: boolean } = {},
): Promise<{ tools: RuntimeTool[]; bindings: ToolBinding[]; revision: number }> {
  const _id = new ObjectId(agentMongoId);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) throw new Error("Agent not found.");

  const { tools, bindings } = await deriveFromBindings(nextBindings, agentMongoId);

  const nextRevision = agent.revision + 1;
  await agents.updateOne(
    { _id },
    {
      $set: {
        "config_cache.tools": tools,
        "config_cache.workflow.bindings": bindings,
        revision: nextRevision,
        updated_at: new Date(),
      },
    },
  );

  if (!options.skipUpstream) {
    const patch: AgentPatch = { tool_ids: externalToolIds(tools) };
    try {
      await patchAgent(agent.elevenlabs_agent_id, patch);
    } catch (err) {
      log.warn("upstream tool_ids patch failed (continuing)", {
        agent_id: agentMongoId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tools, bindings, revision: nextRevision };
}

// ── High-level helpers used by routes + capabilities ──────────────────

/**
 * Install a provider tool. Idempotent: if a binding for
 * (provider, tool_key) already exists, returns the existing tool entry.
 *
 * Registers the upstream ElevenLabs runtime-tool record only on first
 * install — re-installing a previously-uninstalled binding picks up a
 * fresh id, since the upstream record was deleted on uninstall.
 */
export async function installProviderBinding(
  agentMongoId: string,
  providerId: string,
  toolKey: string,
): Promise<{ tool: RuntimeTool; revision: number }> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);
  const spec = findProviderTool(providerId, toolKey);
  if (!spec) {
    throw new Error(
      `Provider "${providerId}" has no tool with key/name "${toolKey}".`,
    );
  }

  let proxySecret: string;
  if (provider.always_connected) {
    // Built-in providers (e.g. Alta) read internal data via each spec's
    // `execute` function — no outbound HTTP, no proxy, no OAuth row to
    // look up. We still pass a non-empty placeholder so downstream code
    // that expects a string doesn't blow up, but it's never used.
    proxySecret = `builtin:${providerId}`;
  } else {
    // Lazily import to avoid a cycle — registerProviderTools.ts imports us.
    const { findWorkspaceIntegration } = await import(
      "@/lib/integrations/store"
    );
    const integration = await findWorkspaceIntegration(providerId);
    if (!integration) {
      throw new Error(
        `${provider.name} is not connected in this workspace. Connect it on any agent first to provide an API token.`,
      );
    }
    const secret = (integration.metadata as { proxy_secret?: unknown })
      .proxy_secret;
    if (typeof secret !== "string") {
      throw new Error(
        `${provider.name} integration is missing a proxy_secret. Reconnect to repair.`,
      );
    }
    proxySecret = secret;
  }

  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(agentMongoId) });
  if (!agent) throw new Error("Agent not found.");

  const current = agent.config_cache.workflow.bindings ?? [];
  const existing = current.find(
    (b) =>
      b.kind === "provider" &&
      b.provider === providerId &&
      b.tool_key === toolKey,
  );
  if (existing) {
    const cache = await loadCustomToolsCache(agentMongoId);
    const resolved = await resolveBinding(existing, agentMongoId, cache);
    if (!resolved) {
      // Resolution failed for an existing binding (shouldn't happen, but
      // possible if PROVIDERS list shifted between calls). Drop it and
      // re-register fresh.
      const filtered = current.filter((b) => b !== existing);
      const elevenlabs_tool_id = await registerProviderSpec(
        spec,
        providerId,
        agentMongoId,
        proxySecret,
      );
      const nextBindings: ToolBinding[] = [
        ...filtered,
        {
          kind: "provider",
          provider: providerId,
          tool_key: toolKey,
          phase: spec.phase,
          elevenlabs_tool_id,
        },
      ];
      const result = await setBindings(agentMongoId, nextBindings);
      const t = result.tools.find(
        (x) => x.provider === providerId && x.name === scopedToolName(spec),
      );
      if (!t) throw new Error("Install failed: derived tool missing.");
      return { tool: t, revision: result.revision };
    }
    return { tool: resolved, revision: agent.revision };
  }

  const elevenlabs_tool_id = await registerProviderSpec(
    spec,
    providerId,
    agentMongoId,
    proxySecret,
  );
  const nextBindings: ToolBinding[] = [
    ...current,
    {
      kind: "provider",
      provider: providerId,
      tool_key: toolKey,
      phase: spec.phase,
      elevenlabs_tool_id,
    },
  ];
  const result = await setBindings(agentMongoId, nextBindings);
  const t = result.tools.find(
    (x) => x.provider === providerId && x.name === scopedToolName(spec),
  );
  if (!t) throw new Error("Install failed: derived tool missing.");
  return { tool: t, revision: result.revision };
}

/**
 * Uninstall a provider tool by any of: binding tuple, ElevenLabs tool id,
 * or scoped name. Removes the binding, deletes the upstream record (if
 * in-call), persists the recomputed `config_cache.tools`, patches
 * ElevenLabs with the new `tool_ids` list, and (when this binding was a
 * custom tool) drops the `custom_tools` row too.
 *
 * No-op (returns the current state) if no matching binding exists —
 * uninstall is idempotent. This is the path that fixed the orphan bug:
 * the old code threw "No tool matching …" when the legacy id didn't
 * match. Now lookup walks bindings + the live `config_cache.tools` and
 * tolerates whichever handle the caller supplied.
 */
export async function uninstallBinding(
  agentMongoId: string,
  identifier: {
    id?: string;
    name?: string;
    provider?: string;
    tool_key?: string;
  },
): Promise<{
  removed: ToolBinding | null;
  tools: RuntimeTool[];
  revision: number;
}> {
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(agentMongoId) });
  if (!agent) throw new Error("Agent not found.");

  const current = agent.config_cache.workflow.bindings ?? [];
  const currentTools = agent.config_cache.tools;

  // Resolve identifier → binding. Try the explicit tuple first, then
  // EL tool id, then scoped name (looking up the tool first to find its
  // binding tuple).
  let target: ToolBinding | undefined;
  if (identifier.provider && identifier.tool_key) {
    target = current.find(
      (b) =>
        b.kind === "provider" &&
        b.provider === identifier.provider &&
        b.tool_key === identifier.tool_key,
    );
  }
  if (!target && identifier.id) {
    target = current.find((b) => b.elevenlabs_tool_id === identifier.id);
  }
  if (!target && identifier.name) {
    const tool = currentTools.find((t) => t.name === identifier.name);
    if (tool) {
      target = current.find((b) => b.elevenlabs_tool_id === tool.id);
    }
  }
  if (!target && identifier.id) {
    // Last-ditch: legacy callers may pass the tool name as `id` (which
    // is exactly the orphan bug we're fixing — the local config.tools
    // had `id === name`). Fall through to name-match.
    const tool = currentTools.find((t) => t.name === identifier.id);
    if (tool) {
      target = current.find((b) => b.elevenlabs_tool_id === tool.id);
    }
  }

  if (!target) {
    return { removed: null, tools: currentTools, revision: agent.revision };
  }

  const nextBindings = current.filter((b) => b !== target);

  // Tear down upstream / DB side effects before recomputing — that way
  // the recompute is fed a clean slate.
  if (!isLocalToolId(target.elevenlabs_tool_id)) {
    await deleteRuntimeTool(target.elevenlabs_tool_id).catch(() => {});
  }
  if (target.kind === "custom") {
    await (await customToolsCol())
      .deleteOne({ _id: new ObjectId(target.custom_tool_id) })
      .catch(() => {});
  }

  const result = await setBindings(agentMongoId, nextBindings);
  return { removed: target, tools: result.tools, revision: result.revision };
}

/**
 * Attach a custom-tool binding for an existing `custom_tools` row. Used
 * by the `write_tool` and `create_custom_runtime_tool` capabilities.
 */
export async function attachCustomBinding(
  agentMongoId: string,
  customToolId: string,
  elevenlabs_tool_id: string,
  phase: RuntimePhase,
): Promise<{ tool: RuntimeTool; revision: number }> {
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(agentMongoId) });
  if (!agent) throw new Error("Agent not found.");

  const current = agent.config_cache.workflow.bindings ?? [];
  if (current.some((b) => b.kind === "custom" && b.custom_tool_id === customToolId)) {
    throw new Error(`Custom tool ${customToolId} is already bound to this agent.`);
  }
  const nextBindings: ToolBinding[] = [
    ...current,
    {
      kind: "custom",
      custom_tool_id: customToolId,
      phase,
      elevenlabs_tool_id,
    },
  ];
  const result = await setBindings(agentMongoId, nextBindings);
  const t = result.tools.find((x) => x.id === elevenlabs_tool_id);
  if (!t) throw new Error("Attach failed: derived tool missing.");
  return { tool: t, revision: result.revision };
}

// ── Lazy migration on agent read ──────────────────────────────────────

/**
 * Ensure `workflow.bindings` is populated. Called from the agent GET
 * handler so the first time anyone opens an agent that pre-dates this
 * refactor, its tools get lifted into bindings and `config_cache.tools`
 * is recomputed (dropping any orphan that can't be resolved).
 *
 * Returns the patched config (or null if no migration was needed).
 */
export async function ensureBindingsMigrated(
  agent: AgentDocument,
): Promise<{
  tools: RuntimeTool[];
  bindings: ToolBinding[];
  dropped: string[];
} | null> {
  if (agent.config_cache.workflow.bindings !== undefined) return null;

  const agentMongoId = agent._id.toHexString();
  const { bindings, dropped } = await bindingsFromLegacyTools(
    agent.config_cache.tools,
    agentMongoId,
  );
  const { tools, bindings: surviving } = await deriveFromBindings(
    bindings,
    agentMongoId,
  );

  const agents = await agentsCol();
  await agents.updateOne(
    { _id: agent._id } as Filter<AgentDocument>,
    {
      $set: {
        "config_cache.tools": tools,
        "config_cache.workflow.bindings": surviving,
        updated_at: new Date(),
      },
    },
  );

  if (dropped.length > 0) {
    log.info("migrated agent bindings; dropped orphans", {
      agent_id: agentMongoId,
      dropped,
      surviving: surviving.length,
    });
  }

  return { tools, bindings: surviving, dropped };
}
