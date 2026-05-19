import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type {
  DataCollectionField,
  EvaluationCriterion,
} from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

/**
 * Build the wire-shape Record ElevenLabs expects under
 * platform_settings.data_collection. enum fields are emitted alongside
 * the type AND folded into the description so the LLM extractor honours
 * the constraint even if upstream silently ignores the enum keyword
 * (it's not officially documented at time of writing). Single source of
 * truth — matches the same helper in the REST routes.
 */
function toUpstreamDataCollection(fields: DataCollectionField[]) {
  return Object.fromEntries(
    fields.map((f) => {
      const descriptionWithEnum =
        f.enum && f.enum.length > 0
          ? `${f.description}\n\nMust be exactly one of: ${f.enum.join(", ")}.`
          : f.description;
      return [
        f.name,
        {
          type: f.type,
          description: descriptionWithEnum,
          ...(f.enum && f.enum.length > 0 ? { enum: f.enum } : {}),
        },
      ];
    }),
  );
}

export const postCallAnalysisCapability: Capability = {
  id: "post_call_analysis",
  label: "Post-call analysis",
  defaultSlice: () => ({ data_collection: [], evaluation_criteria: [] }),
  tools: (ctx) => [
    tool(
      "add_data_collection_field",
      "Define a structured field to extract from each conversation (e.g. 'order_number', 'callback_minutes', 'wants_callback', 'plan_tier'). Supported types: string | number | integer | boolean. Pass `enum` (array of allowed values) when the answer must be one of a fixed set — typically used with type='string' (e.g. plan_tier ∈ ['basic','pro','enterprise']); the constraint is sent to the extractor AND folded into the description so the LLM honours it.",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "snake_case ascii"),
        type: z.enum(["string", "number", "integer", "boolean"]),
        description: z.string().min(1).max(500),
        enum: z.array(z.string().min(1)).min(1).max(50).optional(),
      },
      async ({ name, type, description, enum: enumValues }) =>
        runToolStep(ctx, "data", "add_data_field", async () => {
          if (ctx.config.data_collection.some((d) => d.name === name)) {
            throw new Error(`Data field "${name}" already exists.`);
          }
          const entry: DataCollectionField = {
            id: name,
            name,
            type,
            description,
            ...(enumValues && enumValues.length > 0
              ? { enum: enumValues }
              : {}),
          };
          const next = [...ctx.config.data_collection, entry];
          await patchAgent(ctx.elevenlabs_agent_id, {
            data_collection: toUpstreamDataCollection(next),
          });
          return {
            patch: { data_collection: next },
            summary: enumValues
              ? `Added data field "${name}" (enum: ${enumValues.join(", ")}).`
              : `Added data field "${name}".`,
          };
        }),
    ),

    tool(
      "update_data_collection_field",
      "Edit an EXISTING data collection field in place — type, description, and/or enum. The field name is IMMUTABLE because it's the id call-log consumers reference; if the user wants a different name, remove + add. Omitted args leave that property unchanged. For `enum`: pass an array of values to replace the constraint, OR pass an empty array `[]` to explicitly clear it (free-form again). Use this instead of remove + add whenever the user wants to tighten a description, switch a type, or grow/shrink the allowed-values list.",
      {
        name: z.string().min(1).describe("Name of the field to edit (immutable)."),
        type: z.enum(["string", "number", "integer", "boolean"]).optional(),
        description: z.string().min(1).max(500).optional(),
        enum: z
          .array(z.string().min(1))
          .max(50)
          .optional()
          .describe(
            "Replace the allowed-values list. Empty array clears the constraint; omit to leave it as-is.",
          ),
      },
      async ({ name, type, description, enum: enumValues }) =>
        runToolStep(ctx, "data", "update_data_field", async () => {
          const idx = ctx.config.data_collection.findIndex((d) => d.name === name);
          if (idx === -1) {
            throw new Error(`No data field named "${name}". Call read_agent_config({ section: "data_collection" }) to see what exists.`);
          }
          const current = ctx.config.data_collection[idx];
          // Same merge semantics as the REST PATCH route:
          //   enum === undefined → leave as-is
          //   enum === []        → clear
          //   enum === [...]     → replace
          const merged: DataCollectionField = {
            ...current,
            ...(type !== undefined ? { type } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(enumValues === undefined
              ? {}
              : enumValues.length === 0
                ? { enum: undefined }
                : { enum: enumValues }),
          };
          // Strip the enum key when it's been cleared so subsequent wire
          // serializations don't carry `enum: undefined` forward.
          if (merged.enum === undefined) {
            delete (merged as { enum?: string[] }).enum;
          }
          const next = [...ctx.config.data_collection];
          next[idx] = merged;
          await patchAgent(ctx.elevenlabs_agent_id, {
            data_collection: toUpstreamDataCollection(next),
          });
          // Build a precise summary so the chat pill tells the user exactly
          // what changed instead of a generic "updated".
          const changes: string[] = [];
          if (type !== undefined && type !== current.type) {
            changes.push(`type → ${type}`);
          }
          if (description !== undefined && description !== current.description) {
            changes.push("description");
          }
          if (enumValues !== undefined) {
            if (enumValues.length === 0) changes.push("cleared enum");
            else changes.push(`enum (${enumValues.length} values)`);
          }
          return {
            patch: { data_collection: next },
            summary:
              changes.length === 0
                ? `Field "${name}" had nothing to change.`
                : `Updated "${name}": ${changes.join(", ")}.`,
          };
        }),
    ),

    tool(
      "remove_data_collection_field",
      "Remove a data collection field by name. Wipes the field from the agent AND any future call-log extraction results for it. For edits to type/description/enum, use update_data_collection_field instead — removing + recreating churns extraction history.",
      { name: z.string().min(1) },
      async ({ name }) =>
        runToolStep(ctx, "data", "remove_data_field", async () => {
          const next = ctx.config.data_collection.filter((d) => d.name !== name);
          await patchAgent(ctx.elevenlabs_agent_id, {
            data_collection: toUpstreamDataCollection(next),
          });
          return {
            patch: { data_collection: next },
            summary: `Removed data field "${name}".`,
          };
        }),
    ),

    tool(
      "add_call_outcome",
      "Define a call outcome (a.k.a. evaluation criterion / success criterion) — a yes/no goal the LLM scores against the transcript after every call. Examples: 'caller_identity_verified', 'meeting_booked', 'issue_resolved'. The prompt should be a clear yes/no question; the scorer returns success/failure/unknown. Use during the mandatory agent-creation sequence right after the knowledge base.",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "snake_case ascii"),
        prompt: z
          .string()
          .min(10)
          .max(2000)
          .describe(
            "The yes/no question the scorer answers against the transcript. Be specific.",
          ),
        use_knowledge_base: z
          .boolean()
          .optional()
          .describe("Let the scorer consult the agent's knowledge base."),
        scope: z
          .enum(["conversation", "agent"])
          .optional()
          .describe(
            "'conversation' (default) scores against the whole transcript; 'agent' only against this agent's turns.",
          ),
      },
      async ({ name, prompt, use_knowledge_base, scope }) =>
        runToolStep(ctx, "evaluation", "add_call_outcome", async () => {
          if (ctx.config.evaluation_criteria.some((c) => c.name === name)) {
            throw new Error(`Call outcome "${name}" already exists.`);
          }
          const entry: EvaluationCriterion = {
            id: name,
            name,
            prompt,
            use_knowledge_base,
            scope,
          };
          const next = [...ctx.config.evaluation_criteria, entry];
          await patchAgent(ctx.elevenlabs_agent_id, { evaluation_criteria: next });
          return {
            patch: { evaluation_criteria: next },
            summary: `Added call outcome "${name}".`,
          };
        }),
    ),

    tool(
      "update_call_outcome",
      "Update an existing call outcome's name, prompt, knowledge-base flag, or scope. Identify the outcome by its current name.",
      {
        name: z.string().min(1).describe("Current name of the outcome to edit."),
        new_name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "snake_case ascii")
          .optional(),
        prompt: z.string().min(10).max(2000).optional(),
        use_knowledge_base: z.boolean().optional(),
        scope: z.enum(["conversation", "agent"]).optional(),
      },
      async ({ name, new_name, prompt, use_knowledge_base, scope }) =>
        runToolStep(ctx, "evaluation", "update_call_outcome", async () => {
          const idx = ctx.config.evaluation_criteria.findIndex(
            (c) => c.name === name,
          );
          if (idx === -1) {
            throw new Error(`Call outcome "${name}" does not exist.`);
          }
          const next = [...ctx.config.evaluation_criteria];
          const current = next[idx];
          next[idx] = {
            ...current,
            ...(new_name !== undefined ? { name: new_name } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
            ...(use_knowledge_base !== undefined ? { use_knowledge_base } : {}),
            ...(scope !== undefined ? { scope } : {}),
          };
          await patchAgent(ctx.elevenlabs_agent_id, { evaluation_criteria: next });
          return {
            patch: { evaluation_criteria: next },
            summary: `Updated call outcome "${name}".`,
          };
        }),
    ),

    tool(
      "remove_call_outcome",
      "Remove a call outcome by name (a.k.a. evaluation criterion).",
      { name: z.string().min(1) },
      async ({ name }) =>
        runToolStep(ctx, "evaluation", "remove_call_outcome", async () => {
          const next = ctx.config.evaluation_criteria.filter((c) => c.name !== name);
          await patchAgent(ctx.elevenlabs_agent_id, { evaluation_criteria: next });
          return {
            patch: { evaluation_criteria: next },
            summary: `Removed call outcome "${name}".`,
          };
        }),
    ),
  ],
};
