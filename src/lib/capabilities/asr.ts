import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type { Capability } from "./types";
import { runToolStep } from "./types";

/**
 * ASR (automatic speech recognition) settings.
 * Maps to `conversation_config.asr`.
 */
export const asrCapability: Capability = {
  id: "asr",
  label: "Transcription (ASR)",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "update_transcription_settings",
      "Tune speech recognition. quality: 'high' (most accurate) or 'low' (faster + cheaper). provider: 'elevenlabs' (default) or 'deepgram'. keywords: list of product names / proper nouns the model should boost (e.g. brand names, technical terms the model otherwise mishears).",
      {
        quality: z.enum(["high", "low"]).optional(),
        provider: z.enum(["elevenlabs", "deepgram"]).optional(),
        keywords: z.array(z.string()).max(50).optional(),
      },
      async ({ quality, provider, keywords }) =>
        runToolStep(ctx, "asr", "update_transcription_settings", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            asr_quality: quality,
            asr_provider: provider,
            asr_keywords: keywords,
          });
          const parts: string[] = [];
          if (quality) parts.push(`quality=${quality}`);
          if (provider) parts.push(`provider=${provider}`);
          if (keywords) parts.push(`keywords=[${keywords.slice(0, 5).join(",")}…]`);
          return {
            patch: {},
            summary: `Transcription settings updated${parts.length ? ` (${parts.join(", ")})` : ""}.`,
          };
        }),
    ),
  ],
};
