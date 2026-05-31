/**
 * Integrations capability. Exposes:
 *   - list_connected_integrations / list_provider_catalog — introspection.
 *   - install_provider_tool / uninstall_provider_tool — add or remove one
 *     curated provider tool (e.g. HubSpot create_deal) at a time, beyond
 *     the default set wired up at connect time.
 *   - disconnect_integration — fully detach a provider and tear down all
 *     of its tools.
 *
 * The connect flow itself (paste-a-PAT) happens via widgets
 * (request_user_action with kind='connect_integration'); on resolve, the
 * registerProviderForAgent helper stores the workspace integration
 * credentials. Tools are then opt-in — install via the Tools tab or the
 * `install_provider_tool` capability.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { agentsCol, integrationsCol } from "@/lib/mongodb";
import { PROVIDERS, getProvider, scopedToolName } from "@/lib/integrations/providers";
import {
  installProviderTool,
  uninstallProviderTool,
  disconnectProviderForAgent,
} from "@/lib/integrations/registerProviderTools";
import type { Capability } from "../types";
import { runToolStep } from "../types";

export const integrationsCapability: Capability = {
  id: "integrations",
  label: "Integrations",
  // Integrations are workspace-shared and live in the `integrations`
  // collection — there is no per-agent slice in `config_cache`.
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "list_connected_integrations",
      "List third-party integrations currently connected in this workspace. Integrations are workspace-shared, so anything connected on any agent is usable here. Returns [{ provider, display_name, status, connected_at, has_installed_tools_here }]. `has_installed_tools_here` is true when THIS agent has at least one tool from the provider already installed.",
      {},
      async () => {
        try {
          const ints = await integrationsCol();
          const rows = await ints
            .find({ status: "connected" })
            .toArray();
          const installedProviders = new Set(
            ctx.config.tools
              .map((t) => t.provider)
              .filter((p): p is string => !!p),
          );
          const result = rows.map((r) => {
            const def = getProvider(r.provider);
            return {
              provider: r.provider,
              display_name: def?.name ?? r.provider,
              status: r.status,
              connected_at: r.connected_at?.toISOString() ?? null,
              has_installed_tools_here: installedProviders.has(r.provider),
            };
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `list_connected_integrations failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_workspace_integrations",
      "List third-party integrations connected anywhere in this workspace, with usage stats so you can surface reuse opportunities during the resource-recommendation step of the first turn. Integrations are workspace-shared, so any of these are usable on this agent without re-connecting. Returns [{ provider, display_name, agent_count, sample_agent_names, has_installed_tools_here }].",
      {},
      async () => {
        try {
          const [ints, agents] = await Promise.all([
            integrationsCol().then((c) =>
              c.find({ status: "connected" }).toArray(),
            ),
            agentsCol().then((c) =>
              c
                .find({}, { projection: { _id: 1, name: 1 } })
                .toArray(),
            ),
          ]);
          const agentNameById = new Map(
            agents.map((a) => [a._id.toHexString(), a.name]),
          );
          const installedProviders = new Set(
            ctx.config.tools
              .map((t) => t.provider)
              .filter((p): p is string => !!p),
          );
          const byProvider = new Map<
            string,
            { display_name: string; agent_ids: Set<string> }
          >();
          for (const i of ints) {
            const def = getProvider(i.provider);
            const display_name = def?.name ?? i.provider;
            const entry = byProvider.get(i.provider) ?? {
              display_name,
              agent_ids: new Set<string>(),
            };
            entry.agent_ids.add(i.agent_id.toHexString());
            byProvider.set(i.provider, entry);
          }
          const rows = [...byProvider.entries()].map(([provider, entry]) => ({
            provider,
            display_name: entry.display_name,
            agent_count: entry.agent_ids.size,
            sample_agent_names: [...entry.agent_ids]
              .map((id) => agentNameById.get(id))
              .filter((n): n is string => !!n)
              .slice(0, 3),
            has_installed_tools_here: installedProviders.has(provider),
          }));
          return {
            content: [{ type: "text", text: JSON.stringify(rows) }],
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: `list_workspace_integrations failed: ${message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "list_provider_catalog",
      "Return the full catalog of installable provider tools. Use this to discover what HubSpot/Slack/etc. tools the agent can offer beyond the defaults that auto-install on connect. Each entry has { provider, key, name, description, phase, category, installed }.",
      { provider: z.string().min(1).optional() },
      async ({ provider }) => {
        const installedNames = new Set(ctx.config.tools.map((t) => t.name));
        const providers = provider
          ? PROVIDERS.filter((p) => p.id === provider)
          : PROVIDERS;
        const rows = providers.flatMap((p) =>
          p.runtime_tools.map((t) => ({
            provider: p.id,
            provider_name: p.name,
            key: t.key,
            name: scopedToolName(t),
            description: t.description,
            phase: t.phase,
            category: t.category ?? "Other",
            installed: installedNames.has(scopedToolName(t)),
          })),
        );
        return {
          content: [{ type: "text", text: JSON.stringify(rows) }],
        };
      },
    ),

    tool(
      "install_provider_tool",
      "Attach one curated tool from a connected provider (e.g. HubSpot create_deal, log_note) to this agent's workflow. The tool becomes a binding on `workflow.bindings` — it is available to the agent during the call and can be referenced by `tool_call` workflow nodes. Pass the provider id and the tool's stable `key` (NOT the wire name). The provider must already be connected; use list_provider_catalog to discover available keys.",
      {
        provider: z.string().min(1),
        tool_key: z.string().min(1),
      },
      async ({ provider, tool_key }) =>
        runToolStep(ctx, "integrations", "install_provider_tool", async () => {
          const { entry } = await installProviderTool(
            ctx.agentMongoId,
            provider,
            tool_key,
          );
          // The bindings module already persisted config.tools + workflow.bindings
          // and pushed the upstream tool_ids patch. Re-read so our local
          // patch reflects the authoritative derived list.
          const { agentsCol } = await import("@/lib/mongodb");
          const fresh = await (await agentsCol()).findOne({
            _id: new ObjectId(ctx.agentMongoId),
          });
          return {
            patch: {
              tools: fresh?.config_cache.tools ?? ctx.config.tools,
              workflow: fresh?.config_cache.workflow ?? ctx.config.workflow,
            },
            skipUpstream: true,
            summary: `Attached ${entry.name} to the workflow.`,
          };
        }),
    ),

    tool(
      "uninstall_provider_tool",
      "Remove a tool binding from the workflow by name or id. Drops the binding from `workflow.bindings`, deletes the upstream ElevenLabs runtime-tool record (for in-call tools), and recomputes `config.tools`. Any workflow `tool_call` node that referenced the removed tool will become stale — check the workflow afterward and either repoint the node or remove it. Leaves the rest of the provider's tools — and the connection — intact.",
      {
        tool_id: z.string().min(1).optional(),
        tool_name: z.string().min(1).optional(),
      },
      async ({ tool_id, tool_name }) =>
        runToolStep(ctx, "integrations", "uninstall_provider_tool", async () => {
          if (!tool_id && !tool_name) {
            throw new Error("Pass either tool_id or tool_name.");
          }
          await uninstallProviderTool(
            ctx.agentMongoId,
            { id: tool_id, name: tool_name },
          );
          const { agentsCol } = await import("@/lib/mongodb");
          const fresh = await (await agentsCol()).findOne({
            _id: new ObjectId(ctx.agentMongoId),
          });
          return {
            patch: {
              tools: fresh?.config_cache.tools ?? ctx.config.tools,
              workflow: fresh?.config_cache.workflow ?? ctx.config.workflow,
            },
            skipUpstream: true,
            summary: `Removed binding for ${tool_name ?? tool_id}.`,
          };
        }),
    ),

    tool(
      "disconnect_integration",
      "Disconnect a provider from the WORKSPACE and remove its runtime tools from THIS agent. Because integrations are workspace-shared, the OAuth token is marked disconnected for every agent — any other agent that had its tools installed will also stop being able to fire them until the provider is reconnected. The runtime-tool rows on those other agents are NOT removed here; only this agent's tools are dropped.",
      { provider: z.string().min(1) },
      async ({ provider }) =>
        runToolStep(ctx, "integrations", "disconnect_integration", async () => {
          const { tools, upstreamPatch } = await disconnectProviderForAgent(
            ctx.agentMongoId,
            provider,
          );
          const providerDef = getProvider(provider);
          return {
            patch: { tools },
            upstreamPatch,
            summary: `Disconnected ${providerDef?.name ?? provider}.`,
          };
        }),
    ),
  ],
};
