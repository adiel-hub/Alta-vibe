import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type {
  DataCollectionField,
  EvaluationCriterion,
} from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const postCallAnalysisCapability: Capability = {
  id: "post_call_analysis",
  label: "Post-call analysis",
  defaultSlice: () => ({ data_collection: [], evaluation_criteria: [] }),
  tools: (ctx) => [
    tool(
      "add_data_collection_field",
      "Define a structured field to extract from each conversation (e.g. 'order_number', 'callback_time').",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "snake_case ascii"),
        type: z.enum(["string", "number", "boolean"]),
        description: z.string().min(1).max(500),
      },
      async ({ name, type, description }) =>
        runToolStep(ctx, "data", "add_data_field", async () => {
          if (ctx.config.data_collection.some((d) => d.name === name)) {
            throw new Error(`Data field "${name}" already exists.`);
          }
          const entry: DataCollectionField = { id: name, name, type, description };
          const next = [...ctx.config.data_collection, entry];
          await patchAgent(ctx.elevenlabs_agent_id, {
            data_collection: Object.fromEntries(
              next.map((d) => [d.name, { type: d.type, description: d.description }]),
            ),
          });
          return {
            patch: { data_collection: next },
            summary: `Added data field "${name}".`,
          };
        }),
    ),

    tool(
      "remove_data_collection_field",
      "Remove a data collection field by name.",
      { name: z.string().min(1) },
      async ({ name }) =>
        runToolStep(ctx, "data", "remove_data_field", async () => {
          const next = ctx.config.data_collection.filter((d) => d.name !== name);
          await patchAgent(ctx.elevenlabs_agent_id, {
            data_collection: Object.fromEntries(
              next.map((d) => [d.name, { type: d.type, description: d.description }]),
            ),
          });
          return {
            patch: { data_collection: next },
            summary: `Removed data field "${name}".`,
          };
        }),
    ),

    tool(
      "add_evaluation_criterion",
      "Define a yes/no quality criterion scored after each call (e.g. 'agent verified caller identity').",
      {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_]+$/, "snake_case ascii"),
        prompt: z.string().min(10).max(800),
      },
      async ({ name, prompt }) =>
        runToolStep(ctx, "evaluation", "add_evaluation", async () => {
          if (ctx.config.evaluation_criteria.some((c) => c.name === name)) {
            throw new Error(`Evaluation criterion "${name}" already exists.`);
          }
          const entry: EvaluationCriterion = { id: name, name, prompt };
          const next = [...ctx.config.evaluation_criteria, entry];
          await patchAgent(ctx.elevenlabs_agent_id, { evaluation_criteria: next });
          return {
            patch: { evaluation_criteria: next },
            summary: `Added evaluation criterion "${name}".`,
          };
        }),
    ),

    tool(
      "remove_evaluation_criterion",
      "Remove an evaluation criterion by name.",
      { name: z.string().min(1) },
      async ({ name }) =>
        runToolStep(ctx, "evaluation", "remove_evaluation", async () => {
          const next = ctx.config.evaluation_criteria.filter((c) => c.name !== name);
          await patchAgent(ctx.elevenlabs_agent_id, { evaluation_criteria: next });
          return {
            patch: { evaluation_criteria: next },
            summary: `Removed evaluation criterion "${name}".`,
          };
        }),
    ),
  ],
};
