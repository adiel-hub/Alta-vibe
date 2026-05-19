"use client";

import { useAgentStore } from "@/store/agentStore";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "../../ChatWidget";
import { Typewriter } from "../../Typewriter";
import { ToolCard } from "./ToolCard";

export function BlockView({
  block,
  agentId,
  live,
  isLast,
  result,
}: {
  block: ContentBlock;
  agentId?: string;
  live: boolean;
  isLast: boolean;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const widgets = useAgentStore((s) => s.widgets);

  if (block.type === "text") {
    return (
      <div dir="auto" className="leading-relaxed">
        <Typewriter text={block.text} live={live && isLast} />
      </div>
    );
  }
  if (block.type === "tool_use") {
    // Widgets render as their own interactive component, not a tool card.
    // Any tool that creates a widget action (request_user_action,
    // setup_phone_number, …) shows up as the widget itself. We look up by
    // tool_use_id — set by the SSE client when widget_inserted follows
    // tool_call_start — so this works for every widget-producing tool
    // automatically without a hardcoded name list.
    if (agentId) {
      const input = block.input as { kind?: string; payload?: unknown } | undefined;
      const widget =
        Object.values(widgets).find((w) => w.tool_use_id === block.id) ??
        // Legacy fallback: widgets persisted before tool_use_id stamping
        // existed (re-hydrated on reload) match by kind+payload equality.
        // Only meaningful for `request_user_action` where the tool input
        // carries the same shape as the widget payload.
        (block.name === "mcp__alta__request_user_action"
          ? Object.values(widgets).find(
              (w) =>
                w.kind === input?.kind &&
                JSON.stringify(w.payload) === JSON.stringify(input?.payload),
            )
          : undefined);
      if (widget) return <ChatWidget agentId={agentId} widget={widget} />;
    }
    // Hide SDK internals from the chat. ToolSearch is the Claude Agent
    // SDK's deferred-tool loader — it fires every turn to bring our MCP
    // tool schemas into the model's context. It's machinery, not a step
    // the user cares about.
    if (block.name === "ToolSearch") return null;
    return <ToolCard block={block} result={result} />;
  }
  // tool_result blocks are rendered INSIDE the matching tool_use card.
  return null;
}
