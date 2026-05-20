"use client";

import Image from "next/image";
import { useAgentStore } from "@/store/agentStore";
import type { ContentBlock } from "@/types/agent";
import { BlockView } from "./BlockView";
import { ToolCardGroup } from "./ToolCardGroup";
import { groupConsecutiveTools } from "./grouping";

export function TurnView({
  role,
  content,
  agentId,
  live,
  isLast,
  streamingHint,
}: {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  agentId?: string;
  live: boolean;
  isLast: boolean;
  streamingHint?: boolean;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";

  // Build a tool_use_id → tool_result map so each inline ToolCard knows
  // its own outcome without scanning the full block list per render.
  const toolResults = new Map<
    string,
    Extract<ContentBlock, { type: "tool_result" }>
  >();
  for (const b of content) {
    if (b.type === "tool_result") toolResults.set(b.tool_use_id, b);
  }

  // tool_use_ids that produced a widget. Any tool here renders as the
  // widget itself (not a ToolCard) and skips same-name grouping.
  const widgets = useAgentStore((s) => s.widgets);
  const widgetToolUseIds = new Set<string>();
  for (const w of Object.values(widgets)) {
    if (w.tool_use_id) widgetToolUseIds.add(w.tool_use_id);
  }

  // Drop empty assistant bubbles. A turn is visible if it has any non-empty
  // text, a non-result tool block, or we're showing the streaming hint.
  if (role === "assistant" && !streamingHint) {
    const hasVisible = content.some((b) => {
      if (b.type === "text" && b.text.trim().length > 0) return true;
      if (b.type === "tool_use") return true;
      return false;
    });
    if (!hasVisible) return null;
  }

  if (isSystem) {
    const text = content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex justify-center animate-message-in">
        <div className="rounded-full bg-(--color-panel-soft) px-3 py-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
          {text || "system"}
        </div>
      </div>
    );
  }
  const blocks = (
    <>
      {groupConsecutiveTools(content, widgetToolUseIds).map((item, i, arr) => {
        if (item.kind === "group") {
          return (
            <ToolCardGroup
              key={`g-${item.blocks[0].id}`}
              name={item.name}
              blocks={item.blocks}
              results={toolResults}
            />
          );
        }
        return (
          <BlockView
            key={i}
            block={item.block}
            agentId={agentId}
            live={live}
            isLast={isLast && i === arr.length - 1}
            result={
              item.block.type === "tool_use"
                ? toolResults.get(item.block.id)
                : undefined
            }
          />
        );
      })}
      {streamingHint && (
        <div className="mt-2 flex items-center gap-1 pl-3 text-xs italic text-(--color-muted)">
          <span className="mr-2">thinking</span>
          <span className="dot-flash" />
          <span className="dot-flash" style={{ animationDelay: "120ms" }} />
          <span className="dot-flash" style={{ animationDelay: "240ms" }} />
        </div>
      )}
    </>
  );

  if (isUser) {
    return (
      <div className="animate-message-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-(--color-panel-soft) px-4 py-2 text-sm text-(--color-foreground-strong)">
          {blocks}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-message-in flex gap-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-lg bg-(--color-violet-100)">
        <Image
          src="/alta-avatar.png"
          alt=""
          width={28}
          height={28}
          className="h-full w-full object-cover"
        />
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-[13px] font-semibold text-(--color-foreground-strong)">
          Alex
        </div>
        <div className="space-y-3 text-sm text-(--color-foreground)">
          {blocks}
        </div>
      </div>
    </div>
  );
}
