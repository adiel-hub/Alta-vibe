import { useEffect } from "react";
import type { RuntimeTool } from "@/types/agent";
import { ToolsTab } from "../Tools";

/**
 * Centered modal that renders <ToolsTab mode="pick" /> so the workflow's
 * tool picker is visually identical to the Tools tab — phase tabs,
 * integration grid, custom-tool list, search. Calling onPick fires the
 * caller's addChildNode with the installed RuntimeTool.
 */
export function ToolPickerModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (tool: RuntimeTool) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a tool for this workflow step"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-panel) shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-(--color-border) px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-(--color-foreground-strong)">
              Pick a tool
            </h3>
            <p className="mt-0.5 text-[11px] text-(--color-muted)">
              The picked tool becomes a tool_call step in the workflow.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            ✕
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <ToolsTab mode="pick" onPick={onPick} />
        </div>
      </div>
    </div>
  );
}
