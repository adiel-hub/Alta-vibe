import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { createRuntimeTool } from "@/lib/elevenlabs/client";
import { customToolsCol } from "@/lib/mongodb";
import {
  extractSecretRefs,
  scopeToolName,
} from "@/lib/integrations/schemaUtils";
import { attachCustomBinding, uninstallBinding } from "@/lib/tools/bindings";
import type { CustomToolDocument, RuntimePhase } from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";

export const runtimeToolsCapability: Capability = {
  id: "tools",
  label: "Runtime tools",
  defaultSlice: () => ({ tools: [] }),
  tools: (ctx) => [
    tool(
      "create_custom_runtime_tool",
      "Attach a fresh runtime tool to this agent's workflow. Creates a `custom_tools` row + adds a binding to `workflow.bindings` — the tool becomes available to the agent during the call and can be referenced by `tool_call` workflow nodes. Use this when the user wants behaviour not covered by built-ins. Phase: 'pre_call' runs before greeting, 'in_call' during conversation, 'post_call' after hangup. Provide api_schema for webhook tools.",
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
          const runtimePhase = phase as RuntimePhase;
          const isLifecycle = runtimePhase !== "in_call";

          // Persist a custom_tools row so bindings can resolve back to a
          // shape with description/url/method. The proxy_secret is a
          // placeholder for this path — `create_custom_runtime_tool`
          // doesn't synthesize an upstream service through our proxy
          // (the agent passes api_schema verbatim), so the row exists
          // mainly to give the binding a stable handle for cleanup.
          const customTools = await customToolsCol();
          const customDoc: CustomToolDocument = {
            _id: new ObjectId(),
            agent_id: new ObjectId(ctx.agentMongoId),
            name: scopedName,
            description,
            phase: runtimePhase,
            proxy_secret: randomBytes(32).toString("hex"),
            elevenlabs_tool_id: "",
            upstream: {
              url: api_schema?.url ?? "",
              method: (api_schema?.method ?? "POST") as
                | "GET"
                | "POST"
                | "PUT"
                | "DELETE",
              headers: api_schema?.request_headers ?? {},
            },
            secret_refs: api_schema
              ? extractSecretRefs([
                  api_schema.url,
                  ...Object.values(api_schema.request_headers ?? {}),
                ])
              : [],
            created_at: new Date(),
            updated_at: new Date(),
          };

          const elevenlabs_tool_id = isLifecycle
            ? `local_${randomBytes(8).toString("hex")}`
            : (
                await createRuntimeTool({
                  name: scopedName,
                  description,
                  type,
                  phase: runtimePhase,
                  api_schema,
                })
              ).id;
          customDoc.elevenlabs_tool_id = elevenlabs_tool_id;
          await customTools.insertOne(customDoc);

          const { tool: derived, revision } = await attachCustomBinding(
            ctx.agentMongoId,
            customDoc._id.toHexString(),
            elevenlabs_tool_id,
            runtimePhase,
          );

          const refSuffix =
            customDoc.secret_refs.length > 0
              ? ` Secrets referenced: ${customDoc.secret_refs.join(", ")}.`
              : "";

          // `attachCustomBinding` already persisted config.tools and
          // patched ElevenLabs. We surface the new tools list as the
          // state_patch so the panel reflects it, and skip the upstream
          // merge.
          const agents = await import("@/lib/mongodb").then((m) =>
            m.agentsCol(),
          );
          const fresh = await agents.findOne({
            _id: new ObjectId(ctx.agentMongoId),
          });
          ctx.bumpRevision(); // align local revision tracker with persisted one
          return {
            patch: {
              tools: fresh?.config_cache.tools ?? [],
              workflow: fresh?.config_cache.workflow ?? ctx.config.workflow,
            },
            skipUpstream: true,
            summary: `Created ${phase} tool "${name}" (revision ${revision}, tool ${derived.id}).${refSuffix}`,
          };
        }),
    ),

    tool(
      "remove_runtime_tool",
      "Remove a runtime tool binding from the workflow by id. Drops the binding, deletes the upstream ElevenLabs record, and removes the `custom_tools` row if it was a custom tool. Any `tool_call` workflow node referencing the removed id becomes stale — adjust the workflow afterward.",
      { tool_id: z.string().min(1) },
      async ({ tool_id }) =>
        runToolStep(ctx, "tools", "remove_runtime_tool", async () => {
          // Delegate to the bindings module — it handles the cascade
          // (binding drop, upstream DELETE, custom_tools cleanup, fresh
          // tool_ids patch) atomically.
          const { tools, removed } = await uninstallBinding(ctx.agentMongoId, {
            id: tool_id,
          });
          if (!removed) {
            throw new Error(`No tool with id "${tool_id}".`);
          }
          const agents = await import("@/lib/mongodb").then((m) =>
            m.agentsCol(),
          );
          const fresh = await agents.findOne({
            _id: new ObjectId(ctx.agentMongoId),
          });
          ctx.bumpRevision();
          return {
            patch: {
              tools,
              workflow: fresh?.config_cache.workflow ?? ctx.config.workflow,
            },
            skipUpstream: true,
            summary: `Removed runtime tool.`,
          };
        }),
    ),
  ],
};
