import {
  AUDIENCE_BUILDER_ADDENDUM,
  BUILDER_FIRST_TURN_ADDENDUM,
  BUILDER_SYSTEM_PROMPT,
} from "../../systemPrompt";
import { CAPABILITIES } from "@/lib/capabilities";
import { MAX_HISTORY_TURNS } from "../constants";
import type { RunTurnInput } from "../types";
import { formatTranscript } from "./formatTranscript";

export function buildSystemPrompt(input: RunTurnInput): string {
  const enabledCapabilities = CAPABILITIES.map((c) => `- ${c.id}: ${c.label}`).join("\n");
  const isAudienceBuilder = input.agentKind === "audience_builder";
  // True only for the very first user message after agent creation. Once
  // any turn has happened the transcript carries it (or, after enough
  // turns, conversationSummary does). We use this to skip the long
  // FIRST-TURN BUILD FLOW addendum on every subsequent turn — it would
  // otherwise burn tokens on guidance the agent has already executed.
  // The audience-builder host never runs the voice-agent build flow.
  const isFirstTurn =
    !isAudienceBuilder &&
    input.transcript.length === 0 &&
    !input.conversationSummary;
  const sections: string[] = [
    BUILDER_SYSTEM_PROMPT,
    "",
    "LOCKED AGENT CONTEXT (you can ONLY operate on this agent):",
    `  voice_agent_id: ${input.elevenlabsAgentId}`,
    `  platform_record_id: ${input.agentMongoId}`,
    `  internal_name: ${input.agentName}`,
    `  description: ${input.agentDescription || "(none)"}`,
    `  agent_kind: ${input.agentKind}`,
    "  All your tools are pre-bound to this agent. You CANNOT switch to a",
    "  different agent, create another one, or read another user's data.",
    "  If the user asks for something that would require a different agent",
    '  ("can you also update my other agent…"), decline politely and stay',
    "  focused on this one.",
    "",
    "ENABLED CAPABILITIES:",
    enabledCapabilities,
    "",
    "CURRENT AGENT STATE (JSON):",
    JSON.stringify(input.currentConfig, null, 2),
  ];

  if (input.lastError) {
    sections.push(
      "",
      "LAST UPSTREAM ERROR (informational — only mention if relevant):",
      JSON.stringify(input.lastError, null, 2),
    );
  }

  if (input.conversationSummary) {
    sections.push(
      "",
      "CONVERSATION SUMMARY (older turns, condensed):",
      input.conversationSummary,
    );
  }

  sections.push(
    "",
    `RECENT CONVERSATION — last ${MAX_HISTORY_TURNS} turns, newest last:`,
    formatTranscript(input.transcript),
  );

  if (isAudienceBuilder) {
    sections.push("", AUDIENCE_BUILDER_ADDENDUM);
  } else if (isFirstTurn) {
    sections.push("", BUILDER_FIRST_TURN_ADDENDUM);
  }

  return sections.join("\n");
}
