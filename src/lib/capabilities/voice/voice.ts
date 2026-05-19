import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { listTtsModels, listVoices, patchAgent } from "@/lib/elevenlabs/client";
import { DEFAULT_VOICE_SETTINGS } from "@/types/agent";
import type { Capability } from "../types";
import { runToolStep } from "../types";

/** The only TTS model Alta agents are allowed to run on. v3 covers every
 *  language we care about and supports expressive audio tags; older
 *  flash/turbo models are kept off because they 422 on most non-English
 *  languages (Hebrew, Arabic, etc.). */
const LOCKED_TTS_MODEL = "eleven_v3_conversational";

export const voiceCapability: Capability = {
  id: "voice",
  label: "Voice",
  defaultSlice: () => ({
    voice_id: "",
    voice_settings: { ...DEFAULT_VOICE_SETTINGS },
    tts_model: LOCKED_TTS_MODEL,
    language: "en",
  }),
  tools: (ctx) => [
    tool(
      "update_voice",
      "Browse the voice catalogue and (optionally) set the agent's voice in a single tool. Call without voice_id to get the catalogue back — entries have { voice_id, name, category, labels } so you can pick one that matches the brand and the agent's language. Call with voice_id (must be an id from a prior listing — never invent one) to set the voice.",
      { voice_id: z.string().min(1).optional() },
      async ({ voice_id }) => {
        const voices = await listVoices();
        const trimmed = voices.slice(0, 80).map((v) => ({
          voice_id: v.voice_id,
          name: v.name,
          category: v.category,
          labels: v.labels,
        }));
        if (voice_id === undefined) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  mode: "browse",
                  hint: "Pick a voice_id from this list and call update_voice again with it.",
                  voices: trimmed,
                }),
              },
            ],
          };
        }
        const match = voices.find((v) => v.voice_id === voice_id);
        if (!match) {
          // Hand the catalogue back in the error so the model can self-correct
          // without a second browse round-trip.
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `voice_id "${voice_id}" is not in the catalogue. Pick one from the list below.`,
                  voices: trimmed,
                }),
              },
            ],
            isError: true,
          };
        }
        return runToolStep(ctx, "voice", "update_voice", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { voice_id });
          return {
            patch: { voice_id },
            summary: `Voice set to ${match.name}.`,
          };
        });
      },
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
      "The TTS model is permanently locked to eleven_v3_conversational. This tool exists for legacy migration: calling it forces the model back to v3 regardless of the value you pass. Do not call it to switch models — it cannot switch.",
      { tts_model: z.string().min(1) },
      async () =>
        runToolStep(ctx, "voice", "update_tts_model", async () => {
          const tts_model = LOCKED_TTS_MODEL;
          await patchAgent(ctx.elevenlabs_agent_id, { tts_model });
          return {
            patch: { tts_model },
            summary: `TTS model is locked to ${tts_model} (v3). Any other value is ignored.`,
          };
        }),
    ),

    tool(
      "update_language",
      "Set the conversation language using an ISO code (e.g. 'en', 'es', 'he'). Self-heals: also re-pins the TTS model to eleven_v3_conversational so legacy agents born on eleven_flash_v2 (which doesn't cover most languages) can switch language without 422-ing.",
      { language: z.string().min(2).max(8) },
      async ({ language }) =>
        runToolStep(ctx, "voice", "update_language", async () => {
          // Send tts_model alongside language so legacy agents whose
          // ElevenLabs record still has eleven_flash_v2 don't get a 422
          // when the requested language isn't supported by v2. v3
          // covers every language we care about.
          await patchAgent(ctx.elevenlabs_agent_id, {
            language,
            tts_model: LOCKED_TTS_MODEL,
          });
          return {
            patch: { language, tts_model: LOCKED_TTS_MODEL },
            summary: `Language set to ${language}.`,
          };
        }),
    ),

    // --- v3 expressive features ----------------------------------------
    tool(
      "set_expressive_mode",
      "Enable audio tags for eleven_v3_conversational — boosts emotional range using inline cues like [whispers], [excited], [pause].",
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
      "List of audio tags (e.g. ['whispers', 'excited', 'sighs', 'laughs', 'pause']) the agent should consider using. Applies with eleven_v3_conversational. Agent can still use tags outside this list.",
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
