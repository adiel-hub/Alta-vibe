/**
 * Integrations capability — read-only side. The actual "connect a provider"
 * flow happens through the widgets capability (request_user_action with
 * kind='connect_integration'). After OAuth resolves we automatically register
 * that provider's runtime tools on the agent.
 *
 * This file exposes simple introspection tools: list available providers and
 * list currently-connected integrations.
 */
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { integrationsCol } from "@/lib/mongodb";
import { PROVIDERS } from "@/lib/integrations/providers";
import { patchAgent } from "@/lib/elevenlabs/client";
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
      "disconnect_integration",
      "Disconnect a provider and remove its runtime tools from the agent.",
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
          const providerDef = PROVIDERS.find((p) => p.id === provider);
          const toolNamesToRemove = new Set(
            providerDef?.runtime_tools.map((t) => {
              return t.phase === "in_call" ? t.name : `${t.phase}__${t.name}`;
            }) ?? [],
          );
          const remainingTools = ctx.config.tools.filter(
            (t) => !toolNamesToRemove.has(t.name) && t.provider !== provider,
          );
          await patchAgent(ctx.elevenlabs_agent_id, {
            tools: remainingTools.map((t) => ({
              id: t.id,
              name: t.name,
              type: t.type,
              description: t.description,
            })),
          });
          return {
            patch: {
              integrations: remainingIntegrations,
              tools: remainingTools,
            },
            summary: `Disconnected ${providerDef?.name ?? provider}.`,
          };
        }),
    ),
  ],
};
