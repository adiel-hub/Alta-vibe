import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfigCache } from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";

export const llmCapability: Capability = {
  id: "llm",
  label: "LLM",
  defaultSlice: () => ({
    llm: "gemini-2.0-flash",
    temperature: 0.5,
    max_duration_seconds: 600,
  }),
  tools: (ctx) => [
    tool(
      "update_llm_settings",
      "Set the LLM model (e.g. 'gemini-2.0-flash', 'gpt-4o-mini', 'claude-sonnet-4-6') and/or temperature (0-1).",
      {
        llm: z.string().optional(),
        temperature: z.number().min(0).max(1).optional(),
      },
      async ({ llm, temperature }) =>
        runToolStep(ctx, "llm", "update_llm_settings", async () => {
          const patch: Partial<AgentConfigCache> = {};
          if (llm !== undefined) patch.llm = llm;
          if (temperature !== undefined) patch.temperature = temperature;
          return {
            patch,
            upstreamPatch: { llm, temperature },
            summary: "LLM settings updated.",
          };
        }),
    ),
    tool(
      "update_max_call_duration",
      "Maximum duration (seconds) before the agent hangs up. Common: 300-1800.",
      { max_duration_seconds: z.number().int().min(30).max(7200) },
      async ({ max_duration_seconds }) =>
        runToolStep(ctx, "limits", "update_max_call_duration", async () => ({
          patch: { max_duration_seconds },
          upstreamPatch: { max_duration_seconds },
          summary: `Max call duration set to ${max_duration_seconds}s.`,
        })),
    ),

    tool(
      "set_max_tokens",
      "Hard cap on the number of tokens the LLM may generate per turn. Use 0/unset for no cap. Lower values keep responses brief.",
      { max_tokens: z.number().int().min(0).max(8_000) },
      async ({ max_tokens }) =>
        runToolStep(ctx, "llm", "set_max_tokens", async () => ({
          patch: {},
          upstreamPatch: { max_tokens },
          summary:
            max_tokens === 0
              ? "Removed max-tokens cap."
              : `Max tokens set to ${max_tokens}.`,
        })),
    ),

    tool(
      "set_reasoning_effort",
      "For reasoning-capable models (e.g. Claude thinking models, o-series), how much effort to spend on reasoning. Only takes effect on models that support it.",
      { effort: z.enum(["low", "medium", "high"]) },
      async ({ effort }) =>
        runToolStep(ctx, "llm", "set_reasoning_effort", async () => ({
          patch: {},
          upstreamPatch: { reasoning_effort: effort },
          summary: `Reasoning effort set to ${effort}.`,
        })),
    ),
  ],
};
