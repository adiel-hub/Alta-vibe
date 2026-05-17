"use client";

import { useAgentStore } from "@/store/agentStore";

/**
 * The single one-line tool-status indicator inside the chat. As the agent
 * fires successive tools, the pill morphs in place — emoji + label crossfade
 * to the next tool. On success it briefly shows a check; on error it shows
 * a short, plain-English message.
 *
 * Renders nothing when there is no active tool.
 */
export function LiveToolPill() {
  const live = useAgentStore((s) => s.liveTool);
  if (!live) return null;
  const dot =
    live.status === "running"
      ? "bg-(--color-accent) animate-pulse"
      : live.status === "success"
        ? "bg-(--color-success)"
        : "bg-(--color-danger)";
  const verb =
    live.status === "running" ? "…" : live.status === "success" ? " · done" : " · failed";
  return (
    <div
      key={live.tool_use_id + ":" + live.status}
      className="mt-2 flex items-center gap-2 rounded-full bg-(--color-panel-soft) px-3 py-1.5 text-xs animate-tool-pill"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <span className="text-base leading-none">{live.emoji}</span>
      <span className="text-(--color-foreground)">
        {live.label}
        {verb}
      </span>
      {live.status === "error" && live.error_message && (
        <span className="ml-1 truncate text-(--color-danger) max-w-[200px]">
          — {live.error_message.slice(0, 80)}
        </span>
      )}
    </div>
  );
}
