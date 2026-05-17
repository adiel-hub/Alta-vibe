import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type { AgentConfigCache } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

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
          await patchAgent(ctx.elevenlabs_agent_id, { llm, temperature });
          const patch: Partial<AgentConfigCache> = {};
          if (llm !== undefined) patch.llm = llm;
          if (temperature !== undefined) patch.temperature = temperature;
          return { patch, summary: "LLM settings updated." };
        }),
    ),
    tool(
      "update_max_call_duration",
      "Maximum duration (seconds) before the agent hangs up. Common: 300-1800.",
      { max_duration_seconds: z.number().int().min(30).max(7200) },
      async ({ max_duration_seconds }) =>
        runToolStep(ctx, "limits", "update_max_call_duration", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { max_duration_seconds });
          return {
            patch: { max_duration_seconds },
            summary: `Max call duration set to ${max_duration_seconds}s.`,
          };
        }),
    ),
  ],
};
