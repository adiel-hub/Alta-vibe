import { MAX_HISTORY_TURNS } from "../constants";
import type { RunTurnInput } from "../types";

export function formatTranscript(
  transcript: RunTurnInput["transcript"],
): string {
  const recent = transcript.slice(-MAX_HISTORY_TURNS);
  if (recent.length === 0) return "(empty)";
  return recent
    .map((t) => {
      const text = t.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_use") {
            const input =
              typeof b.input === "object" && b.input !== null
                ? JSON.stringify(b.input).slice(0, 200)
                : "";
            return input ? `[called ${b.name}(${input})]` : `[called ${b.name}]`;
          }
          if (b.type === "tool_result") {
            const out =
              typeof b.output === "string"
                ? b.output.slice(0, 200)
                : JSON.stringify(b.output ?? "").slice(0, 200);
            return `[result${b.is_error ? " ERROR" : ""}: ${out}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${t.role.toUpperCase()}: ${text}`;
    })
    .join("\n");
}
