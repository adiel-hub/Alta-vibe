"use client";

import { useAgentStore } from "@/store/agentStore";

/**
 * Single one-line tool-status indicator inside the chat, in the AskAlta
 * shimmer style: a 12 px violet spinner, a friendly label rendered as a
 * moving gradient, and a mono chip showing the raw tool name. As successive
 * tools fire, the label slides up + cross-fades while the chip swaps.
 *
 * Renders nothing when there is no active tool.
 */
export function LiveToolPill() {
  const live = useAgentStore((s) => s.liveTool);
  if (!live) return null;

  const stateClass =
    live.status === "running" ? "" : live.status === "success" ? "done" : "error";

  // Strip our MCP prefix so the code chip reads like a verb.
  const code = live.raw_name.replace(/^mcp__alta__/, "");
  const label =
    live.status === "running"
      ? live.label
      : live.status === "success"
        ? `${live.label} · done`
        : `${live.label} · failed`;

  return (
    <div
      // re-keying on status forces the slide-up + shimmer to restart.
      key={live.tool_use_id + ":" + live.status}
      className={`aa-thinking aa-thinking-single ${stateClass}`}
    >
      <div className="step active">
        <span aria-hidden>
          <span className="spin" />
        </span>
        <span className="step-label step-label-anim">{label}</span>
        {code && <span className="step-code">{code}</span>}
      </div>
      {live.status === "error" && live.error_message && (
        <span
          className="ml-2 truncate text-(--color-danger)"
          style={{ fontSize: 12, maxWidth: 240 }}
        >
          — {live.error_message.slice(0, 100)}
        </span>
      )}
    </div>
  );
}
