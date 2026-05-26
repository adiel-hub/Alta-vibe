import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { ContentBlock, SSEEvent } from "@/types/agent";
import type { TurnStats } from "../types";
import {
  handleStreamEvent,
  type PartialInputs,
} from "./streamEvent";
import { handleAssistantMessage } from "./assistant";
import { handleUserMessage } from "./user";
import { handleSystemMessage } from "./system";
import { handleResultMessage } from "./result";

export type { PartialInputs } from "./streamEvent";

export function forwardMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
  partials: PartialInputs,
): void {
  stats.sdk_messages++;

  // ── stream_event: partial deltas (text + thinking + tool_input) ───────
  if (message.type === "stream_event") {
    handleStreamEvent(message, emit, log, stats, partials);
    return;
  }

  // ── assistant: full content array for a completed model turn ─────────
  if (message.type === "assistant") {
    handleAssistantMessage(message, emit, assistantContent, log, stats);
    return;
  }

  // ── user: tool results coming back from the SDK ──────────────────────
  if (message.type === "user") {
    handleUserMessage(message, emit, assistantContent, log, stats);
    return;
  }

  // ── system: lifecycle / housekeeping events from the SDK ─────────────
  if (message.type === "system") {
    handleSystemMessage(message, log);
    return;
  }

  // ── result: final session result with usage + cost ────────────────────
  if (message.type === "result") {
    handleResultMessage(message, log, stats);
    return;
  }

  // Everything else (auth_status, rate_limit_event, plugin_install, …).
  log.info("sdk message (other)", {
    type: (message as { type?: string }).type,
  });
}
