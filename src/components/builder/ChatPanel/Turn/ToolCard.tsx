"use client";

import { useState } from "react";
import type { ContentBlock } from "@/types/agent";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";
import { StatusIndicator } from "./StatusIndicator";
import { extractResultText } from "./extractResultText";
import type { ToolStatus } from "./grouping";

/**
 * Inline card that represents one tool call in the assistant's response.
 * Renders a one-line summary (spinner | ✓ | ✗  +  emoji  +  friendly label).
 * Click to expand → shows the input args and the tool's text output.
 */
export function ToolCard({
  block,
  result,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const friendly = friendlyForTool(block.name);
  const status: ToolStatus = !result
    ? "running"
    : result.is_error
      ? "error"
      : "success";

  const indicator = <StatusIndicator status={status} />;

  const resultText = extractResultText(result);

  return (
    <div className="vb-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="vb-tool-card-head"
        aria-expanded={expanded}
      >
        {indicator}
        <span className="vb-tool-card-emoji" aria-hidden>
          {friendly.emoji}
        </span>
        <span
          className={`vb-tool-card-label ${
            status === "running" ? "vb-tool-card-label-shimmer" : ""
          }`}
        >
          {friendly.label}
        </span>
        <span className="vb-tool-card-chev" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="vb-tool-card-body">
          {block.input !== undefined && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">Input</div>
              <pre dir="auto" className="vb-tool-card-pre">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}
          {resultText !== null && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">
                {status === "error" ? "Error" : "Result"}
              </div>
              <pre
                dir="auto"
                className={`vb-tool-card-pre ${
                  status === "error" ? "vb-tool-card-pre-error" : ""
                }`}
              >
                {resultText || "(empty)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
