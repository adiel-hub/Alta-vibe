import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import type { createLogger } from "@/lib/logger";
import { widgetActionsCol } from "@/lib/mongodb";
import type { ContentBlock, SSEEvent } from "@/types/agent";
import { summariseInput } from "../utils/log";
import type { TurnStats } from "../types";

const ACTION_ID_RE = /action_id=([a-f0-9]{24})/i;

/**
 * Extract action_id=<hex> from a tool_result output (text or content array).
 * Returns null if not present or shape is unexpected.
 */
function extractActionId(output: unknown): string | null {
  if (typeof output === "string") {
    const m = output.match(ACTION_ID_RE);
    return m ? m[1] : null;
  }
  if (Array.isArray(output)) {
    for (const item of output) {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: string }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        const m = (item as { text: string }).text.match(ACTION_ID_RE);
        if (m) return m[1];
      }
    }
  }
  return null;
}

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
      // If this is a widget-producing tool, the result text carries
      // `action_id=<hex>`. Stamp the widget_actions doc with the
      // tool_use_id so it rehydrates inline on page reload instead of
      // floating as an orphan above the chat. Fire-and-forget — the
      // forward loop must not block on Mongo, and an occasional miss is
      // harmless (the legacy kind+payload fallback still catches some).
      if (!isError) {
        const actionId = extractActionId(output);
        if (actionId && ObjectId.isValid(actionId)) {
          const toolUseId = block.tool_use_id;
          void (async () => {
            try {
              const widgets = await widgetActionsCol();
              await widgets.updateOne(
                { _id: new ObjectId(actionId) },
                { $set: { tool_use_id: toolUseId } },
              );
            } catch {
              // best-effort; hydration without tool_use_id falls back to
              // the legacy kind+payload match for request_user_action.
            }
          })();
        }
      }
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
