import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
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
        runToolStep(ctx, "flow", "set_dynamic_variables", async () => ({
          patch: {},
          upstreamPatch: { dynamic_variables: variables },
          summary: `Set ${Object.keys(variables).length} dynamic variable${Object.keys(variables).length === 1 ? "" : "s"}.`,
        })),
    ),

    tool(
      "set_agent_timezone",
      "Set the timezone the agent uses when reasoning about the current time (e.g. 'America/New_York', 'Europe/London', 'UTC'). Required for accurate time-aware responses — without it the agent has no notion of the current date/time and may hallucinate.",
      { timezone: z.string().min(2).max(64) },
      async ({ timezone }) =>
        runToolStep(ctx, "flow", "set_agent_timezone", async () => ({
          patch: {},
          upstreamPatch: { timezone },
          summary: `Timezone set to ${timezone}.`,
        })),
    ),

    tool(
      "set_max_conversation_duration_message",
      "The line the agent says when a call hits max_duration_seconds and is about to disconnect. Keep it short and warm.",
      { message: z.string().min(1).max(500) },
      async ({ message }) =>
        runToolStep(ctx, "flow", "set_max_duration_message", async () => ({
          patch: {},
          upstreamPatch: { max_conversation_duration_message: message },
          summary: "Updated max-duration goodbye message.",
        })),
    ),

    tool(
      "set_first_message_interruption_lock",
      "When true, the user cannot interrupt the agent while the first message is being delivered. Useful for legal disclosures.",
      { lock: z.boolean() },
      async ({ lock }) =>
        runToolStep(ctx, "flow", "set_interruption_lock", async () => ({
          patch: {},
          upstreamPatch: { disable_first_message_interruptions: lock },
          summary: lock
            ? "First-message interruptions locked."
            : "First-message interruptions allowed.",
        })),
    ),

    tool(
      "set_text_only_mode",
      "When true, the agent uses text-only conversations (no audio). Avoids audio pricing for chat-style use cases (web widget, WhatsApp, etc.).",
      { text_only: z.boolean() },
      async ({ text_only }) =>
        runToolStep(ctx, "flow", "set_text_only", async () => ({
          patch: {},
          upstreamPatch: { text_only },
          summary: text_only ? "Text-only mode enabled." : "Voice mode enabled.",
        })),
    ),

    tool(
      "set_source_attribution",
      "When true, the agent reports which knowledge-base documents and chunks contributed to each response. Enables citations in transcripts.",
      { source_attribution: z.boolean() },
      async ({ source_attribution }) =>
        runToolStep(ctx, "flow", "set_source_attribution", async () => ({
          patch: {},
          upstreamPatch: { source_attribution },
          summary: source_attribution
            ? "Source attribution enabled — agent will cite KB sources."
            : "Source attribution disabled.",
        })),
    ),
  ],
};
