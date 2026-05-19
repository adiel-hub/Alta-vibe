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
 * registerProviderForAgent helper auto-installs each provider tool marked
 * `default_install: true`.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { agentsCol, integrationsCol } from "@/lib/mongodb";
import { PROVIDERS, getProvider, scopedToolName } from "@/lib/integrations/providers";
import {
  installProviderTool,
  uninstallProviderTool,
} from "@/lib/integrations/registerProviderTools";
import { patchAgent } from "@/lib/elevenlabs/client";
import { stripCallerContextBlock } from "@/lib/integrations/promptContext";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const integrationsCapability: Capability = {
  id: "integrations",
  label: "Integrations",
  defaultSlice: () => ({ integrations: [] }),
  tools: (ctx) => [
    tool(
      "list_connected_integrations",
      "List third-party integrations currently connected to this agent.",
      {},
      async () => {
        return {
          content: [
            { type: "text", text: JSON.stringify(ctx.config.integrations) },
          ],
        };
      },
    ),

    tool(
      "list_workspace_integrations",
      "List third-party integrations the user has already connected on OTHER agents in this workspace. Use this during the resource-recommendation step of the first turn to spot CRMs / messaging / calendar providers the user has previously set up, so you can offer one-click reuse here. Returns [{ provider, display_name, agent_count, sample_agent_names, already_connected_here }]. `already_connected_here` is true if THIS agent already has the provider — skip those when recommending.",
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
          const here = new Set(ctx.config.integrations.map((i) => i.provider));
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
            already_connected_here: here.has(provider),
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
            default_install: !!t.default_install,
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
      "Install one curated tool from a connected provider (e.g. HubSpot create_deal, log_note). Pass the provider id and the tool's stable `key` (NOT the wire name). The provider must already be connected; use list_provider_catalog to discover available keys.",
      {
        provider: z.string().min(1),
        tool_key: z.string().min(1),
      },
      async ({ provider, tool_key }) =>
        runToolStep(ctx, "integrations", "install_provider_tool", async () => {
          const entry = await installProviderTool(
            ctx.agentMongoId,
            provider,
            tool_key,
          );
          const nextTools = [...ctx.config.tools, entry];
          return {
            patch: { tools: nextTools },
            summary: `Installed ${entry.name} on this agent.`,
          };
        }),
    ),

    tool(
      "uninstall_provider_tool",
      "Remove a single installed provider tool by name or id. Leaves the rest of the provider's tools — and the connection — intact.",
      {
        tool_id: z.string().min(1).optional(),
        tool_name: z.string().min(1).optional(),
      },
      async ({ tool_id, tool_name }) =>
        runToolStep(ctx, "integrations", "uninstall_provider_tool", async () => {
          if (!tool_id && !tool_name) {
            throw new Error("Pass either tool_id or tool_name.");
          }
          const { remaining } = await uninstallProviderTool(ctx.agentMongoId, {
            id: tool_id,
            name: tool_name,
          });
          return {
            patch: { tools: remaining },
            summary: `Uninstalled ${tool_name ?? tool_id}.`,
          };
        }),
    ),

    tool(
      "disconnect_integration",
      "Disconnect a provider and remove ALL of its runtime tools from the agent.",
      { provider: z.string().min(1) },
      async ({ provider }) =>
        runToolStep(ctx, "integrations", "disconnect_integration", async () => {
          const ints = await integrationsCol();
          await ints.updateOne(
            { agent_id: new ObjectId(ctx.agentMongoId), provider },
            { $set: { status: "disconnected", updated_at: new Date() } },
          );
          const remainingIntegrations = ctx.config.integrations.filter(
            (i) => i.provider !== provider,
          );
          const providerDef = getProvider(provider);
          const toolNamesToRemove = new Set(
            providerDef?.runtime_tools.map((t) => scopedToolName(t)) ?? [],
          );
          const remainingTools = ctx.config.tools.filter(
            (t) => !toolNamesToRemove.has(t.name) && t.provider !== provider,
          );

          // If we're disconnecting a CRM that injected the caller-context
          // block (currently only HubSpot), strip it back out of the
          // system prompt and clear the dynamic-variable defaults.
          const isCrm = provider === "hubspot";
          const nextSystemPrompt = isCrm
            ? stripCallerContextBlock(ctx.config.system_prompt)
            : ctx.config.system_prompt;

          await patchAgent(ctx.elevenlabs_agent_id, {
            tool_ids: remainingTools.map((t) => t.id),
            ...(isCrm
              ? {
                  system_prompt: nextSystemPrompt,
                  dynamic_variables: {},
                }
              : {}),
          });
          return {
            patch: {
              integrations: remainingIntegrations,
              tools: remainingTools,
              ...(isCrm ? { system_prompt: nextSystemPrompt } : {}),
            },
            summary: `Disconnected ${providerDef?.name ?? provider}.`,
          };
        }),
    ),
  ],
};
