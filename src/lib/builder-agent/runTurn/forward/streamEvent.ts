import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { SSEEvent } from "@/types/agent";
import { truncate } from "../utils/log";
import type { TurnStats } from "../types";

export function handleStreamEvent(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
): void {
  const ev = (
    message as unknown as {
      event?: {
        type?: string;
        index?: number;
        content_block?: { type?: string; name?: string; id?: string };
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
          signature?: string;
          stop_reason?: string;
        };
        message?: { stop_reason?: string };
      };
    }
  ).event;
  if (!ev || typeof ev !== "object") return;

  stats.stream_deltas++;

  if (ev.type === "content_block_start") {
    const cb = ev.content_block;
    if (cb?.type === "thinking") {
      log.info("model thinking start", { index: ev.index });
    } else if (cb?.type === "tool_use") {
      log.debug("tool_use block start", {
        index: ev.index,
        name: cb.name,
        tool_use_id: cb.id,
      });
    } else if (cb?.type === "text") {
      log.debug("text block start", { index: ev.index });
    }
    return;
  }

  if (ev.type === "content_block_delta") {
    const d = ev.delta;
    if (d?.type === "text_delta" && typeof d.text === "string") {
      stats.text_chars += d.text.length;
      emit({ type: "assistant_delta", text: d.text });
      return;
    }
    if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
      // The model's chain-of-thought, streamed token-by-token. Log at
      // info level so it shows up by default; the user explicitly
      // asked to see the reasoning. Backend-only: not forwarded to
      // the client via SSE.
      stats.thinking_chars += d.thinking.length;
      log.info("thinking", { delta: truncate(d.thinking, 200) });
      return;
    }
    if (d?.type === "signature_delta") {
      log.debug("thinking signature delta");
      return;
    }
    if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
      log.debug("tool_input delta", {
        delta: truncate(d.partial_json, 120),
      });
      return;
    }
    // Unknown delta kind — surface so we notice when the SDK adds new ones.
    log.debug("stream delta (unknown kind)", { delta_type: d?.type });
    return;
  }

  if (ev.type === "content_block_stop") {
    log.debug("content_block_stop", { index: ev.index });
    return;
  }

  if (ev.type === "message_start") {
    log.debug("message_start");
    return;
  }

  if (ev.type === "message_delta") {
    if (ev.delta?.stop_reason) {
      stats.last_stop_reason = ev.delta.stop_reason;
      log.debug("message_delta", { stop_reason: ev.delta.stop_reason });
    }
    return;
  }

  if (ev.type === "message_stop") {
    log.debug("message_stop");
    return;
  }

  log.debug("stream_event (unhandled)", { event_type: ev.type });
}
