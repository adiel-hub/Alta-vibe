import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { listTtsModels, listVoices, patchAgent } from "@/lib/elevenlabs/client";
import { DEFAULT_VOICE_SETTINGS } from "@/types/agent";
import type { Capability } from "./types";
import { runToolStep } from "./types";

export const voiceCapability: Capability = {
  id: "voice",
  label: "Voice",
  defaultSlice: () => ({
    voice_id: "",
    voice_settings: { ...DEFAULT_VOICE_SETTINGS },
    tts_model: "eleven_turbo_v2_5",
    language: "en",
  }),
  tools: (ctx) => [
    tool(
      "list_available_voices",
      "Return the voice catalogue. Call this before update_voice so you pick a real voice_id; never invent one.",
      {},
      async () => {
        const voices = await listVoices();
        const trimmed = voices.slice(0, 80).map((v) => ({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category,
          labels: v.labels,
        }));
        return { content: [{ type: "text", text: JSON.stringify(trimmed) }] };
      },
    ),

    tool(
      "update_voice",
      "Set the agent's voice. Use a voice_id returned by list_available_voices.",
      { voice_id: z.string().min(1) },
      async ({ voice_id }) =>
        runToolStep(ctx, "voice", "update_voice", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { voice_id });
          return { patch: { voice_id }, summary: "Voice updated." };
        }),
    ),

    tool(
      "update_voice_settings",
      "Tune voice expression. stability 0-1 (robotic↔dramatic), similarity_boost 0-1, style 0-1 (v3 expressiveness), use_speaker_boost (bool), speed 0.7-1.2. Pass only fields to change.",
      {
        stability: z.number().min(0).max(1).optional(),
        similarity_boost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        use_speaker_boost: z.boolean().optional(),
        speed: z.number().min(0.5).max(2).optional(),
      },
      async (input) =>
        runToolStep(ctx, "voice", "update_voice_settings", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { voice_settings: input });
          const partial = Object.fromEntries(
            Object.entries(input).filter(([, v]) => v !== undefined),
          );
          const next = { ...ctx.config.voice_settings, ...partial };
          return { patch: { voice_settings: next }, summary: "Voice settings updated." };
        }),
    ),

    tool(
      "list_tts_models",
      "List available TTS models. Call before update_tts_model.",
      {},
      async () => {
        const models = await listTtsModels();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                models.map((m) => ({
                  model_id: m.model_id,
                  name: m.name,
                  languages: (m.languages ?? []).slice(0, 30),
                })),
              ),
            },
          ],
        };
      },
    ),

    tool(
      "update_tts_model",
      "Select the TTS model. Use one of: eleven_v3 (most expressive), eleven_multilingual_v2, eleven_turbo_v2_5, eleven_flash_v2_5 (fastest).",
      { tts_model: z.string().min(1) },
      async ({ tts_model }) =>
        runToolStep(ctx, "voice", "update_tts_model", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { tts_model });
          return { patch: { tts_model }, summary: `TTS model set to ${tts_model}.` };
        }),
    ),

    tool(
      "update_language",
      "Set the conversation language using an ISO code (e.g. 'en', 'es'). For multilingual, also set tts_model to eleven_multilingual_v2 or eleven_v3.",
      { language: z.string().min(2).max(8) },
      async ({ language }) =>
        runToolStep(ctx, "voice", "update_language", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { language });
          return { patch: { language }, summary: `Language set to ${language}.` };
        }),
    ),

    // --- v3 expressive features ----------------------------------------
    tool(
      "set_expressive_mode",
      "Enable audio tags for the eleven_v3 model — boosts emotional range using inline cues like [whispers], [excited], [pause]. Automatically disabled for non-v3 models.",
      { enabled: z.boolean() },
      async ({ enabled }) =>
        runToolStep(ctx, "voice", "set_expressive_mode", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { expressive_mode: enabled });
          return {
            patch: {},
            summary: enabled ? "Expressive mode enabled." : "Expressive mode disabled.",
          };
        }),
    ),

    tool(
      "set_suggested_audio_tags",
      "List of audio tags (e.g. ['whispers', 'excited', 'sighs', 'laughs', 'pause']) the agent should consider using. Only applies with the eleven_v3 model. Agent can still use tags outside this list.",
      { tags: z.array(z.string()).max(20) },
      async ({ tags }) =>
        runToolStep(ctx, "voice", "set_suggested_audio_tags", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { suggested_audio_tags: tags });
          return {
            patch: {},
            summary: `Suggested ${tags.length} audio tag${tags.length === 1 ? "" : "s"}.`,
          };
        }),
    ),

    tool(
      "set_output_audio_format",
      "Audio format the agent produces. Common: 'pcm_16000' (default), 'pcm_22050', 'pcm_44100', 'mp3_22050_32', 'mp3_44100_64', 'ulaw_8000' (telephony).",
      { format: z.string() },
      async ({ format }) =>
        runToolStep(ctx, "voice", "set_output_audio_format", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            agent_output_audio_format: format,
          });
          return { patch: {}, summary: `Output audio format set to ${format}.` };
        }),
    ),

    tool(
      "set_optimize_streaming_latency",
      "Latency optimisation level. 0 = best quality, 4 = lowest latency. Default 2.",
      { level: z.number().int().min(0).max(4) },
      async ({ level }) =>
        runToolStep(ctx, "voice", "set_optimize_streaming_latency", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            optimize_streaming_latency: level,
          });
          return {
            patch: {},
            summary: `Latency optimisation set to level ${level}.`,
          };
        }),
    ),

    tool(
      "set_text_normalisation",
      "How numbers/dates are turned into spoken words. 'system_prompt' = LLM does it (free, more flexible). 'elevenlabs' = post-process (small latency, deterministic). 'off' = no normalisation.",
      { mode: z.enum(["system_prompt", "elevenlabs", "off"]) },
      async ({ mode }) =>
        runToolStep(ctx, "voice", "set_text_normalisation", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            text_normalisation_type: mode,
          });
          return { patch: {}, summary: `Text normalisation set to ${mode}.` };
        }),
    ),
  ],
};
