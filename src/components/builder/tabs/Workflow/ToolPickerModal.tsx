import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { RuntimePhase, RuntimeTool } from "@/types/agent";
import { ToolsTab } from "../Tools";

/**
 * Centered modal that renders <ToolsTab mode="pick" /> so any caller — a
 * workflow node's "+" or a lifecycle column's "+ Pre-call tool" — gets
 * the same picker as the Tools tab (phase tabs, integration grid,
 * custom-tool list, search).
 *
 * Two usage modes:
 *  - Workflow tool_call binding: callers pass `onPick`. The Tools tab's
 *    "Pick" affordance fires it with the installed RuntimeTool so the
 *    caller can wire the tool into a workflow node.
 *  - Lifecycle install (pre/post/ambient): callers omit `onPick`. The
 *    Tools tab handles install internally (POST /provider-tools updates
 *    the store), and the modal closes when the user dismisses it.
 */
export function ToolPickerModal({
  onClose,
  onPick,
  initialPhase = "in_call",
  title = "Pick a tool",
  subtitle = "The picked tool becomes a tool_call step in the workflow.",
}: {
  onClose: () => void;
  onPick?: (tool: RuntimeTool) => void;
  initialPhase?: RuntimePhase;
  title?: string;
  subtitle?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portal to document.body so the modal escapes any transformed ancestor
  // (the Workflow stage uses transform: translate/scale for pan + zoom,
  // and `position: fixed` is contained by transformed ancestors per spec).
  // Without the portal the overlay only covers the transformed canvas
  // region instead of the full viewport.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      // Stop pointer events at the overlay so they don't bubble up
      // through the React tree to the Workflow canvas's pan handler.
      // createPortal moves the DOM, but React synthetic events still
      // travel through the component tree — without this, the canvas
      // captures the pointer and the modal becomes non-interactive
      // when invoked from a phantom column (which mounts inside the
      // canvas's React subtree).
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-panel) shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-(--color-border) px-5 py-3">
          <div>
            <h3 className="text-sm font-semibold text-(--color-foreground-strong)">
              {title}
            </h3>
            <p className="mt-0.5 text-[11px] text-(--color-muted)">
              {subtitle}
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
          <ToolsTab mode="pick" onPick={onPick} initialPhase={initialPhase} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
