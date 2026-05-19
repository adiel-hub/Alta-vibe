import type { ContentBlock } from "@/types/agent";

export type ToolStatus = "running" | "success" | "error";

export type GroupedItem =
  | { kind: "block"; block: ContentBlock }
  | {
      kind: "group";
      name: string;
      blocks: Extract<ContentBlock, { type: "tool_use" }>[];
    };

/**
/**
 * Tool calls that are pure internal discovery — the agent looking things up
 * to decide what to do next — and add noise to the chat without telling the
 * user anything actionable. Hidden from the chat history rendering.
 */
export const HIDDEN_TOOL_NAMES = new Set([
  "ToolSearch",
  "mcp__alta__list_integration_providers",
  "mcp__alta__list_connected_integrations",
]);

/**
 * Collapse runs of consecutive same-name tool calls into one item so we
 * don't paint six "Writing a knowledge note" rows in a column — the user
 * can click to drill into the individual inputs/outputs.
 *
 * Standalone tool_result blocks and tools in HIDDEN_TOOL_NAMES are skipped
 * (already invisible in BlockView). Widget tools render alone.
 */
export function groupConsecutiveTools(
  content: ContentBlock[],
  widgetToolUseIds: Set<string>,
): GroupedItem[] {
  // Any tool that produced a widget renders as the widget itself (not a
  // ToolCard) and must not be folded into a same-name group.
  const isWidgetTool = (b: ContentBlock) =>
    b.type === "tool_use" && widgetToolUseIds.has(b.id);
  const items: GroupedItem[] = [];
  let i = 0;
  while (i < content.length) {
    const block = content[i];

    if (block.type === "tool_result") {
      i++;
      continue;
    }

    if (block.type === "tool_use" && HIDDEN_TOOL_NAMES.has(block.name)) {
      i++;
      continue;
    }

    if (block.type !== "tool_use") {
      items.push({ kind: "block", block });
      i++;
      continue;
    }

    if (isWidgetTool(block)) {
      items.push({ kind: "block", block });
      i++;
      continue;
    }

    const group: Extract<ContentBlock, { type: "tool_use" }>[] = [block];
    let j = i + 1;
    while (j < content.length) {
      const next = content[j];
      if (next.type === "tool_result") {
        j++;
        continue;
      }
      if (next.type === "tool_use" && HIDDEN_TOOL_NAMES.has(next.name)) {
        j++;
        continue;
      }
      if (
        next.type === "tool_use" &&
        next.name === block.name &&
        !isWidgetTool(next)
      ) {
        group.push(next);
        j++;
        continue;
      }
      break;
    }

    if (group.length === 1) {
      items.push({ kind: "block", block });
      i++;
    } else {
      items.push({ kind: "group", name: block.name, blocks: group });
      i = j;
    }
  }
  return items;
}
