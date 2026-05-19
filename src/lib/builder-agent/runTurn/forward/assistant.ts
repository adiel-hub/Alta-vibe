import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { ContentBlock, SSEEvent } from "@/types/agent";
import { summariseInput, truncate } from "../utils/log";
import type { TurnStats } from "../types";

export function handleAssistantMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
): void {
  stats.model_turns++;
  const am = message as unknown as {
    message: {
      content: Array<{ type: string; [k: string]: unknown }>;
      stop_reason?: string;
      usage?: Record<string, unknown>;
    };
    parent_tool_use_id?: string | null;
    uuid?: string;
    subagent_type?: string;
  };
  const blocks = am.message.content;
  log.info("assistant message", {
    blocks: blocks.length,
    types: blocks.map((b) => b.type),
    stop_reason: am.message.stop_reason,
    subagent: am.subagent_type,
    parent_tool_use_id: am.parent_tool_use_id ?? undefined,
  });
  if (am.message.stop_reason) stats.last_stop_reason = am.message.stop_reason;

  for (const block of blocks) {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      // Log the FULL thinking text once the block is complete. This
      // is the most useful form for debugging — you see the entire
      // chain-of-thought without scrolling through individual deltas.
      log.info("model thinking (complete)", {
        chars: (block.thinking as string).length,
        text: truncate(block.thinking as string, 2000),
      });
    } else if (block.type === "redacted_thinking") {
      log.info("model thinking (redacted)", {
        note: "Anthropic redacted this thinking block for safety reasons.",
      });
    } else if (block.type === "text" && typeof block.text === "string") {
      const text = block.text as string;
      log.info("model text", { chars: text.length, text: truncate(text, 500) });
      assistantContent.push({ type: "text", text });
    } else if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      stats.tool_calls++;
      log.info("model tool_use", {
        name: block.name,
        tool_use_id: block.id,
        input: summariseInput(block.input),
      });
      assistantContent.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
      emit({
        type: "tool_call_start",
        tool_use_id: block.id,
        name: block.name,
        input: block.input,
      });
    } else {
      log.warn("assistant block (unhandled)", { block_type: block.type });
    }
  }
}
