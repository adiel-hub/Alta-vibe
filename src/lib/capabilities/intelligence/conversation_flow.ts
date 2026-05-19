import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { patchAgent } from "@/lib/elevenlabs/client";
import type { Capability } from "../types";
import { runToolStep } from "../types";

/**
 * Conversation-level switches: text-only mode (no audio), source attribution
 * for RAG cites, dynamic variables, timezone for time-aware responses,
 * first-message interruption guard, and the goodbye message used when a
 * call hits max_duration.
 */
export const conversationFlowCapability: Capability = {
  id: "flow",
  label: "Conversation flow",
  defaultSlice: () => ({}),
  tools: (ctx) => [
    tool(
      "set_dynamic_variables",
      "Define `{{placeholder}}` variables that callers/clients can override at conversation start (e.g. {{caller_name}}, {{order_id}}). Map of placeholder name → default value.",
      {
        variables: z.record(z.string(), z.string()),
      },
      async ({ variables }) =>
        runToolStep(ctx, "flow", "set_dynamic_variables", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            dynamic_variables: variables,
          });
          return {
            patch: {},
            summary: `Set ${Object.keys(variables).length} dynamic variable${Object.keys(variables).length === 1 ? "" : "s"}.`,
          };
        }),
    ),

    tool(
      "set_agent_timezone",
      "Set the timezone the agent uses when reasoning about the current time (e.g. 'America/New_York', 'Europe/London', 'UTC'). Required for accurate time-aware responses — without it the agent has no notion of the current date/time and may hallucinate.",
      { timezone: z.string().min(2).max(64) },
      async ({ timezone }) =>
        runToolStep(ctx, "flow", "set_agent_timezone", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { timezone });
          return { patch: {}, summary: `Timezone set to ${timezone}.` };
        }),
    ),

    tool(
      "set_max_conversation_duration_message",
      "The line the agent says when a call hits max_duration_seconds and is about to disconnect. Keep it short and warm.",
      { message: z.string().min(1).max(500) },
      async ({ message }) =>
        runToolStep(ctx, "flow", "set_max_duration_message", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            max_conversation_duration_message: message,
          });
          return { patch: {}, summary: "Updated max-duration goodbye message." };
        }),
    ),

    tool(
      "set_first_message_interruption_lock",
      "When true, the user cannot interrupt the agent while the first message is being delivered. Useful for legal disclosures.",
      { lock: z.boolean() },
      async ({ lock }) =>
        runToolStep(ctx, "flow", "set_interruption_lock", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, {
            disable_first_message_interruptions: lock,
          });
          return {
            patch: {},
            summary: lock
              ? "First-message interruptions locked."
              : "First-message interruptions allowed.",
          };
        }),
    ),

    tool(
      "set_text_only_mode",
      "When true, the agent uses text-only conversations (no audio). Avoids audio pricing for chat-style use cases (web widget, WhatsApp, etc.).",
      { text_only: z.boolean() },
      async ({ text_only }) =>
        runToolStep(ctx, "flow", "set_text_only", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { text_only });
          return {
            patch: {},
            summary: text_only ? "Text-only mode enabled." : "Voice mode enabled.",
          };
        }),
    ),

    tool(
      "set_source_attribution",
      "When true, the agent reports which knowledge-base documents and chunks contributed to each response. Enables citations in transcripts.",
      { source_attribution: z.boolean() },
      async ({ source_attribution }) =>
        runToolStep(ctx, "flow", "set_source_attribution", async () => {
          await patchAgent(ctx.elevenlabs_agent_id, { source_attribution });
          return {
            patch: {},
            summary: source_attribution
              ? "Source attribution enabled — agent will cite KB sources."
              : "Source attribution disabled.",
          };
        }),
    ),
  ],
};
