import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { ContentBlock, SSEEvent } from "@/types/agent";
import { summariseInput } from "../utils/log";
import type { TurnStats } from "../types";

export function handleUserMessage(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  assistantContent: ContentBlock[],
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
): void {
  const um = message as unknown as {
    message: { content: Array<{ type: string; [k: string]: unknown }> };
    parent_tool_use_id?: string | null;
  };
  const blocks = um.message.content;
  for (const block of blocks) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const output = block.content ?? block.output;
      const isError = block.is_error === true;
      stats.tool_results++;
      log.info(isError ? "tool_result (error)" : "tool_result", {
        tool_use_id: block.tool_use_id,
        output: summariseInput(output),
      });
      assistantContent.push({
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        output,
        is_error: isError,
      });
      emit({
        type: "tool_call_result",
        tool_use_id: block.tool_use_id,
        output,
        is_error: isError,
      });
    } else {
      log.debug("user block (unhandled)", { block_type: block.type });
    }
  }
}
