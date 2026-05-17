import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type { McpIntegration } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const mcpCapability: Capability = {
  id: "mcp",
  label: "MCP integrations",
  defaultSlice: () => ({ mcp_servers: [] }),
  tools: (ctx) => [
    tool(
      "add_mcp_integration",
      "Attach an MCP server so the deployed agent can use its tools at runtime.",
      {
        server_id: z.string().min(1),
        name: z.string().optional(),
        url: z.string().url().optional(),
      },
      async ({ server_id, name, url }) =>
        runToolStep(ctx, "mcp", "add_mcp", async () => {
          const entry: McpIntegration = {
            id: server_id,
            name: name ?? server_id,
            url: url ?? "",
          };
          const next = [...ctx.config.mcp_servers, entry];
          await patchAgent(ctx.elevenlabs_agent_id, {
            mcp_server_ids: next.map((m) => m.id),
          });
          return {
            patch: { mcp_servers: next },
            summary: `Connected MCP server "${entry.name}".`,
          };
        }),
    ),
    tool(
      "remove_mcp_integration",
      "Detach an MCP server.",
      { server_id: z.string().min(1) },
      async ({ server_id }) =>
        runToolStep(ctx, "mcp", "remove_mcp", async () => {
          const next = ctx.config.mcp_servers.filter((m) => m.id !== server_id);
          await patchAgent(ctx.elevenlabs_agent_id, {
            mcp_server_ids: next.map((m) => m.id),
          });
          return {
            patch: { mcp_servers: next },
            summary: `Disconnected MCP server ${server_id}.`,
          };
        }),
    ),
  ],
};
