import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import {
  createRuntimeTool,
  deleteRuntimeTool,
  patchAgent,
} from "@/lib/elevenlabs/client";
import { customToolsCol } from "@/lib/mongodb";
import {
  extractSecretRefs,
  scopeToolName,
} from "@/lib/integrations/schemaUtils";
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
          const scopedName = scopeToolName(name, phase as RuntimePhase);
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
            tool_ids: next.map((t) => t.id),
          });
          // Surface any {{secret:<name>}} references the caller embedded in
          // the api_schema so the user sees which secrets this tool depends
          // on. We don't persist them (runtime_tools has no custom_tools
          // row); the refs are informational only.
          const secretRefs = api_schema
            ? extractSecretRefs([
                api_schema.url,
                ...Object.values(api_schema.request_headers ?? {}),
              ])
            : [];
          const refSuffix =
            secretRefs.length > 0
              ? ` Secrets referenced: ${secretRefs.join(", ")}.`
              : "";
          return {
            patch: { tools: next },
            summary: `Created ${phase} tool "${name}".${refSuffix}`,
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
            tool_ids: next.map((t) => t.id),
          });
          await deleteRuntimeTool(tool_id).catch(() => {});
          // Cascade: if this tool was synthesized via write_tool, drop the
          // backing custom_tools row so its proxy_secret + upstream spec
          // don't become an orphan.
          const customTools = await customToolsCol();
          await customTools
            .deleteOne({
              agent_id: new ObjectId(ctx.agentMongoId),
              elevenlabs_tool_id: tool_id,
            })
            .catch(() => {});
          return { patch: { tools: next }, summary: `Removed runtime tool.` };
        }),
    ),
  ],
};
