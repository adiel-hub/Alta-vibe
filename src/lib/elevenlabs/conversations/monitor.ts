/**
 * Server-side bridge to ElevenLabs' real-time conversation monitoring socket.
 *
 * For an in-browser web call the `@elevenlabs/react` SDK fires
 * `onAgentToolResponse` directly in the page, which drives the live workflow
 * cursor (see TestCallButton + callMonitorStore). A PHONE call has no browser
 * session — audio is Twilio↔ElevenLabs — so the same signals are unavailable
 * client-side. The monitoring WebSocket streams the SAME `agent_tool_response`
 * events server-side, which we forward to the browser over SSE.
 *
 * Endpoint: wss://api.elevenlabs.io/v1/convai/conversations/{id}/monitor
 * Auth:     `xi-api-key` header — the key needs "ElevenLabs Agents Write"
 *           scope + EDITOR workspace access (enterprise-only feature).
 *
 * We use the `ws` package rather than the global WebSocket because the WHATWG
 * WebSocket can't set custom request headers.
 */
import WebSocket from "ws";
import { apiKey } from "../core/apiKey";
import { createLogger } from "@/lib/logger";

const log = createLogger("el-monitor");

const WS_BASE = "wss://api.elevenlabs.io";

/** A workflow/system tool signal as the position engine consumes it. */
export type MonitorToolResponse = {
  toolName: string;
  toolType: string;
  isError: boolean;
};

/**
 * Open a monitoring socket for a conversation. Calls `onToolResponse` for every
 * `agent_tool_response` frame (the `notify_condition_<N>_met` / `end_call`
 * signals the engine maps to node moves) and `onClose` exactly once when the
 * socket ends. Returns a `close()` to tear the socket down proactively (e.g.
 * the browser navigated away); after a proactive close `onClose` does NOT fire.
 */
export function openConversationMonitor(
  conversationId: string,
  handlers: {
    onToolResponse: (r: MonitorToolResponse) => void;
    onClose: (info: { code: number }) => void;
  },
): { close: () => void } {
  const url = `${WS_BASE}/v1/convai/conversations/${encodeURIComponent(
    conversationId,
  )}/monitor`;
  const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey() } });
  let closed = false;

  ws.on("open", () => log.info("monitor open", { conversation_id: conversationId }));

  ws.on("message", (data: WebSocket.RawData) => {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
    } catch {
      return; // non-JSON frame (shouldn't happen on a text-only stream)
    }
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { type?: string }).type === "agent_tool_response"
    ) {
      const r = (msg as { agent_tool_response?: Record<string, unknown> })
        .agent_tool_response;
      if (!r) return;
      handlers.onToolResponse({
        toolName: String(r.tool_name ?? ""),
        toolType: String(r.tool_type ?? ""),
        isError: Boolean(r.is_error),
      });
    }
  });

  ws.on("error", (err: Error) => {
    log.warn("monitor error", {
      conversation_id: conversationId,
      message: err.message,
    });
  });

  ws.on("close", (code: number) => {
    if (closed) return; // proactive close — client already gone
    closed = true;
    log.info("monitor close", { conversation_id: conversationId, code });
    handlers.onClose({ code });
  });

  return {
    close: () => {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
