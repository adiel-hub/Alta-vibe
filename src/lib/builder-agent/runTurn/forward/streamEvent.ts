import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { SSEEvent } from "@/types/agent";
import { truncate } from "../utils/log";
import type { TurnStats } from "../types";

/** Persona-tab tool → which top-level string field of its input we stream. */
const STREAMED_FIELD_BY_TOOL: Record<
  string,
  "name" | "first_message" | "system_prompt"
> = {
  mcp__alta__update_agent_name: "name",
  mcp__alta__update_first_message: "first_message",
  mcp__alta__update_system_prompt: "system_prompt",
};

/**
 * Per-content-block state for the three persona tools, keyed by the SDK's
 * `index` for the block. The Anthropic stream identifies which content
 * block a delta applies to via its index — that's the only stable handle
 * before `tool_use_id` is known via `content_block_start`.
 */
export type PartialInputEntry = {
  toolUseId: string;
  field: "name" | "first_message" | "system_prompt";
  accumulated: string;
  lastEmitAt: number;
  lastEmitLen: number;
};
export type PartialInputs = Map<number, PartialInputEntry>;

/**
 * Extract a top-level string field value from possibly-incomplete JSON.
 * Returns the in-progress decoded value, or null if the value hasn't
 * started yet. Handles `\n`, `\t`, `\"`, `\\`, `\uXXXX` escapes; stops at
 * the closing quote (end-of-value) or end-of-input (still streaming).
 */
function extractStringField(json: string, field: string): string | null {
  const keyRe = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = json.match(keyRe);
  if (!m) return null;
  let i = m.index! + m[0].length;
  let out = "";
  while (i < json.length) {
    const c = json[i];
    if (c === "\\" && i + 1 < json.length) {
      const next = json[i + 1];
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
      };
      if (next in simple) {
        out += simple[next];
        i += 2;
        continue;
      }
      if (next === "u" && i + 5 < json.length) {
        out += String.fromCharCode(parseInt(json.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      // Incomplete escape (e.g. trailing `\` or `\u12` partial) — wait for
      // the next delta to deliver the rest.
      break;
    }
    if (c === '"') return out;
    out += c;
    i += 1;
  }
  return out;
}

export function handleStreamEvent(
  message: SDKMessage,
  emit: (event: SSEEvent) => void,
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
  partials: PartialInputs,
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
      const field = cb.name ? STREAMED_FIELD_BY_TOOL[cb.name] : undefined;
      if (
        field &&
        typeof ev.index === "number" &&
        typeof cb.id === "string"
      ) {
        partials.set(ev.index, {
          toolUseId: cb.id,
          field,
          accumulated: "",
          lastEmitAt: 0,
          lastEmitLen: 0,
        });
      }
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
      if (typeof ev.index !== "number") return;
      const entry = partials.get(ev.index);
      if (!entry) return;
      entry.accumulated += d.partial_json;
      const value = extractStringField(entry.accumulated, entry.field);
      if (value === null) return;
      // Throttle: avoid pushing an SSE event for every 3-char delta. The
      // 80ms bufferedEmit flush and 250ms SSE poll already collapse bursts
      // downstream, but each emit still becomes a Mongo events[] entry, so
      // skipping tiny updates is worthwhile.
      const now = Date.now();
      if (
        now - entry.lastEmitAt < 100 &&
        value.length - entry.lastEmitLen < 20
      )
        return;
      entry.lastEmitAt = now;
      entry.lastEmitLen = value.length;
      emit({
        type: "tool_input_partial",
        tool_use_id: entry.toolUseId,
        field: entry.field,
        value,
      });
      return;
    }
    // Unknown delta kind — surface so we notice when the SDK adds new ones.
    log.debug("stream delta (unknown kind)", { delta_type: d?.type });
    return;
  }

  if (ev.type === "content_block_stop") {
    log.debug("content_block_stop", { index: ev.index });
    if (typeof ev.index === "number") {
      const entry = partials.get(ev.index);
      if (entry) {
        // Belt-and-braces: flush the final partial before the canonical
        // state_patch lands. The two events are idempotent — applyPatch
        // will overwrite with the authoritative value either way.
        const value = extractStringField(entry.accumulated, entry.field);
        if (value !== null && value.length > entry.lastEmitLen) {
          emit({
            type: "tool_input_partial",
            tool_use_id: entry.toolUseId,
            field: entry.field,
            value,
          });
        }
        partials.delete(ev.index);
      }
    }
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
