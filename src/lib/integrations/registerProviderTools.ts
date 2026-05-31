/**
 * Provider connection + tool installation helpers.
 *
 *   - registerProviderForAgent: called from the widget-resolve route when
 *     the user pastes credentials. Stores the workspace integration row
 *     (proxy_secret + encrypted token). Does NOT install any tools — every
 *     tool is opt-in via the Tools tab or the `install_provider_tool`
 *     capability.
 *   - installProviderTool: installs a single named tool on an
 *     already-connected provider.
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
import type { AgentPatch } from "@/lib/elevenlabs/agents/types";
import { externalToolIds, isLocalToolId } from "@/lib/elevenlabs/lifecycle/toolIds";
import { getProvider } from "./providers";
import type { RuntimeTool } from "@/types/agent";

/**
 * Persist the workspace-shared integration credentials (proxy_secret +
 * encrypted access_token). No tools are installed here — every tool is
 * opt-in via the Tools tab or the `install_provider_tool` capability.
 */
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

  return { added_tools: 0 };
}

/**
 * Install a single provider tool by key onto an already-connected agent.
 * Returns the new RuntimeTool entry, or throws if the provider isn't
 * connected, the tool key is unknown, or the tool is already installed.
 */
/**
 * Install a single provider tool. Returns the entry + the upstream PATCH
 * payload (caller must apply it — either inline for REST flows, or via the
 * turn-scoped `deferredPatch` accumulator when called from a capability).
 */
export type InstallProviderToolResult = {
  entry: RuntimeTool;
  upstreamPatch: AgentPatch;
};

export async function installProviderTool(
  agentMongoId: string,
  providerId: string,
  toolKey: string,
): Promise<InstallProviderToolResult> {
  // Delegate to the bindings-based path. Provider validation, spec lookup,
  // workspace-integration check, and upstream registration all happen
  // inside `installProviderBinding`. We translate its return shape back
  // into the legacy `{entry, upstreamPatch}` envelope so the chat-driven
  // and REST callers don't have to change.
  //
  // Note: `setBindings` (called inside) already issued the upstream
  // `tool_ids` PATCH. We still return a no-op upstreamPatch for
  // callers that want to fold it into a deferred buffer — patching
  // twice with the same `tool_ids` array is harmless.
  const { installProviderBinding } = await import("@/lib/tools/bindings");
  const { tool } = await installProviderBinding(agentMongoId, providerId, toolKey);

  const agents = await agentsCol();
  const agent = await agents.findOne({ _id: new ObjectId(agentMongoId) });
  if (!agent) throw new Error("Agent not found.");
  return {
    entry: tool,
    upstreamPatch: { tool_ids: externalToolIds(agent.config_cache.tools) },
  };
}

/**
 * Remove a provider-sourced tool from the agent by its installed name or
 * id. Deletes the ElevenLabs runtime-tool record too.
 */
export type UninstallProviderToolResult = {
  removed_id: string;
  remaining: RuntimeTool[];
  /**
   * Upstream PATCH payload — `undefined` when the removed tool was a
   * local-only lifecycle tool (no ElevenLabs `tool_ids` change needed).
   */
  upstreamPatch?: AgentPatch;
};

export async function uninstallProviderTool(
  agentMongoId: string,
  identifier: { id?: string; name?: string },
): Promise<UninstallProviderToolResult> {
  // Delegate to the bindings-based path. `uninstallBinding` tolerates any
  // of (id, name) and silently no-ops on missing rather than throwing —
  // the "No tool matching … is installed" error in the legacy path was
  // the surface of the orphan bug.
  const { uninstallBinding } = await import("@/lib/tools/bindings");
  const { removed, tools } = await uninstallBinding(agentMongoId, identifier);

  if (!removed) {
    return { removed_id: identifier.id ?? identifier.name ?? "", remaining: tools };
  }
  const isLocal = isLocalToolId(removed.elevenlabs_tool_id);
  return {
    removed_id: removed.elevenlabs_tool_id,
    remaining: tools,
    ...(isLocal ? {} : { upstreamPatch: { tool_ids: externalToolIds(tools) } }),
  };
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
export type DisconnectProviderResult = {
  revision: number;
  tools: RuntimeTool[];
  upstreamPatch: AgentPatch;
};

export async function disconnectProviderForAgent(
  agentMongoId: string,
  providerId: string,
): Promise<DisconnectProviderResult> {
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

  // Drop every binding for this provider in one shot. setBindings derives
  // a fresh `config_cache.tools` (omitting all of this provider's tools)
  // and pushes the resulting `tool_ids` patch to ElevenLabs.
  const { setBindings } = await import("@/lib/tools/bindings");
  const currentBindings = agent.config_cache.workflow.bindings ?? [];
  const nextBindings = currentBindings.filter(
    (b) => !(b.kind === "provider" && b.provider === providerId),
  );
  const result = await setBindings(agentMongoId, nextBindings);

  return {
    revision: result.revision,
    tools: result.tools,
    upstreamPatch: { tool_ids: externalToolIds(result.tools) },
  };
}
