import type { ContentBlock } from "@/types/agent";

export function extractResultText(
  result?: Extract<ContentBlock, { type: "tool_result" }>,
): string | null {
  if (!result) return null;
  const out = result.output;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    return out
      .map((x) =>
        x && typeof x === "object" && "type" in x && (x as { type?: string }).type === "text"
          ? (x as { text?: string }).text ?? ""
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(out, null, 2);
}
