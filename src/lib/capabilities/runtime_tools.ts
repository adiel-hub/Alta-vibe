import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import {
  createRuntimeTool,
  deleteRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const runtimeToolsCapability: Capability = {
  id: "tools",
  label: "Runtime tools",
  defaultSlice: () => ({ tools: [] }),
  tools: (ctx) => [
    tool(
      "create_custom_runtime_tool",
      "Create ANY tool the deployed agent can call during a conversation. Use this when the user wants behaviour not covered by built-ins. Phase: 'pre_call' runs before greeting, 'in_call' during conversation, 'post_call' after hangup. Provide api_schema for webhook tools.",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "name must be snake_case ascii"),
        description: z.string().min(1).max(500),
        phase: z.enum(["pre_call", "in_call", "post_call"]),
        type: z.enum(["webhook", "client", "system"]).default("webhook"),
        api_schema: z
          .object({
            url: z.string().url(),
            method: z.enum(["GET", "POST", "PUT", "DELETE"]),
            request_headers: z.record(z.string(), z.string()).optional(),
            request_body_schema: z.unknown().optional(),
            query_params_schema: z.unknown().optional(),
          })
          .optional(),
      },
      async ({ name, description, phase, type, api_schema }) =>
        runToolStep(ctx, "tools", "create_runtime_tool", async () => {
          if (type === "webhook" && !api_schema) {
            throw new Error("Webhook tools require api_schema (url + method).");
          }
          if (ctx.config.tools.some((t) => t.name === name)) {
            throw new Error(`A tool named "${name}" already exists. Pick another name.`);
          }
          const scopedName = phase === "in_call" ? name : `${phase}__${name}`;
          const created = await createRuntimeTool({
            name: scopedName,
            description,
            type,
            phase: phase as RuntimePhase,
            api_schema,
          });
          const entry: RuntimeTool = {
            id: created.id,
            name: scopedName,
            type,
            description,
            phase: phase as RuntimePhase,
            method: api_schema?.method,
            url: api_schema?.url,
          };
          const next = [...ctx.config.tools, entry];
          await patchAgent(ctx.elevenlabs_agent_id, {
            tools: next.map((t) => ({
              id: t.id,
              name: t.name,
              type: t.type,
              description: t.description,
            })),
          });
          return {
            patch: { tools: next },
            summary: `Created ${phase} tool "${name}".`,
          };
        }),
    ),

    tool(
      "remove_runtime_tool",
      "Remove a runtime tool by id.",
      { tool_id: z.string().min(1) },
      async ({ tool_id }) =>
        runToolStep(ctx, "tools", "remove_runtime_tool", async () => {
          if (!ctx.config.tools.some((t) => t.id === tool_id)) {
            throw new Error(`No tool with id "${tool_id}".`);
          }
          const next = ctx.config.tools.filter((t) => t.id !== tool_id);
          await patchAgent(ctx.elevenlabs_agent_id, {
            tools: next.map((t) => ({
              id: t.id,
              name: t.name,
              type: t.type,
              description: t.description,
            })),
          });
          await deleteRuntimeTool(tool_id).catch(() => {});
          return { patch: { tools: next }, summary: `Removed runtime tool.` };
        }),
    ),
  ],
};
