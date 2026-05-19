"use client";

import { useState } from "react";
import type { ContentBlock } from "@/types/agent";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";
import { StatusIndicator } from "./StatusIndicator";
import { extractResultText } from "./extractResultText";
import type { ToolStatus } from "./grouping";

/**
 * Collapsed view of N consecutive calls to the same tool. The head row
 * shows the friendly label and a `×N` count; expanding lists every call's
 * input and result so the user can inspect each one.
 *
 * Aggregate status: any in-flight call → running; otherwise any error → error;
 * otherwise success.
 */
export function ToolCardGroup({
  name,
  blocks,
  results,
}: {
  name: string;
  blocks: Extract<ContentBlock, { type: "tool_use" }>[];
  results: Map<string, Extract<ContentBlock, { type: "tool_result" }>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const friendly = friendlyForTool(name);

  const callStatuses: ToolStatus[] = blocks.map((b) => {
    const r = results.get(b.id);
    if (!r) return "running";
    return r.is_error ? "error" : "success";
  });
  const aggregateStatus: ToolStatus = callStatuses.includes("running")
    ? "running"
    : callStatuses.includes("error")
      ? "error"
      : "success";

  return (
    <div className="vb-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="vb-tool-card-head"
        aria-expanded={expanded}
      >
        <StatusIndicator status={aggregateStatus} />
        <span className="vb-tool-card-emoji" aria-hidden>
          {friendly.emoji}
        </span>
        <span
          className={`vb-tool-card-label ${
            aggregateStatus === "running" ? "vb-tool-card-label-shimmer" : ""
          }`}
        >
          {friendly.label}
        </span>
        <span className="ml-1 rounded-full bg-(--color-panel-soft) px-1.5 py-0.5 font-mono text-[10px] font-medium text-(--color-muted)">
          ×{blocks.length}
        </span>
        <span className="vb-tool-card-chev" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="vb-tool-card-body space-y-3">
          {blocks.map((block, idx) => {
            const result = results.get(block.id);
            const status = callStatuses[idx];
            const resultText = extractResultText(result);
            return (
              <div
                key={block.id}
                className="rounded-md border border-(--color-border)/60 bg-(--color-panel)/60 p-2"
              >
                <div className="mb-1.5 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-(--color-muted)">
                  <StatusIndicator status={status} />
                  <span>Call {idx + 1}</span>
                </div>
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
            );
          })}
        </div>
      )}
    </div>
  );
}
