import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  RuntimeTool,
  WorkflowEdgeCondition,
  WorkflowNode,
} from "@/types/agent";
import { prettifyCustomName } from "../Tools/utils/names";

/**
 * Asks the user how a freshly-picked tool should be wired into the
 * workflow relative to a parent node. Two valid outcomes:
 *
 *   - "as_node"    → create a new tool_call node after `parent`, with
 *                    a structured `forward_condition` on the incoming
 *                    edge. The condition decides when the conversation
 *                    flow routes to this tool — same model as the one
 *                    ElevenLabs uses for transitions.
 *   - "additional" → add the tool's id to `parent.data.additional_tool_ids`.
 *                    The LLM gets access to the tool while the parent
 *                    node is active and decides on its own whether to
 *                    call it. No new graph node is added.
 *
 * Only `override_agent` parents (speak / collect / condition) support
 * `additional_tool_ids` — for any other parent type, the parent picks
 * the choice without opening this modal and falls through to "as_node".
 */
export function AttachModeModal({
  parent,
  tool,
  onClose,
  onChoose,
}: {
  parent: WorkflowNode;
  tool: RuntimeTool;
  onClose: () => void;
  onChoose: (args: {
    mode: "as_node" | "additional";
    /** Required when mode === "as_node". Defines the parent→tool edge. */
    forwardCondition?: WorkflowEdgeCondition;
  }) => void;
}) {
  // Step 1: pick the wiring mode. Step 2 (as_node only): configure the
  // transition condition. We collapse to step 2 immediately on the
  // "Run after" choice; "Attach" commits without a second step.
  const [mode, setMode] = useState<"as_node" | "additional" | null>(null);
  const [transitionType, setTransitionType] = useState<
    "unconditional" | "llm" | "result"
  >("llm");
  const [llmCondition, setLlmCondition] = useState("");
  const [resultSuccessful, setResultSuccessful] = useState(true);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const parentLabel = parent.label || parent.id;
  const toolLabel = prettifyCustomName(tool.name);

  const llmConditionValid =
    transitionType !== "llm" || llmCondition.trim().length > 0;

  function commit() {
    if (mode === "additional") {
      onChoose({ mode: "additional" });
      return;
    }
    setSubmitted(true);
    if (!llmConditionValid) return;
    let forwardCondition: WorkflowEdgeCondition;
    if (transitionType === "unconditional") {
      forwardCondition = { type: "unconditional" };
    } else if (transitionType === "llm") {
      forwardCondition = {
        type: "llm",
        condition: llmCondition.trim(),
      };
    } else {
      forwardCondition = {
        type: "result",
        successful: resultSuccessful,
      };
    }
    onChoose({ mode: "as_node", forwardCondition });
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose how to attach the tool"
      onClick={onClose}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-(--color-border) bg-(--color-panel) shadow-2xl"
      >
        <header className="border-b border-(--color-border) px-5 py-3">
          <h3 className="text-sm font-semibold text-(--color-foreground-strong)">
            How should &ldquo;{toolLabel}&rdquo; be wired?
          </h3>
          <p className="mt-0.5 text-[11px] text-(--color-muted)">
            {mode === null
              ? `Picked into the workflow after “${parentLabel}”.`
              : mode === "additional"
                ? `Attaching to “${parentLabel}”.`
                : `Configuring the transition from “${parentLabel}” → tool_call.`}
          </p>
        </header>

        {/* ── Step 1: choose mode ──────────────────────────────────── */}
        {mode === null && (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode("as_node")}
              className="group flex flex-col items-start gap-2 rounded-xl border border-(--color-border) bg-white p-4 text-left transition hover:border-(--color-accent)/60 hover:ring-1 hover:ring-(--color-accent)/40"
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-(--color-accent)">
                Run after this node
              </span>
              <span className="text-sm font-semibold text-(--color-foreground-strong)">
                New tool_call step
              </span>
              <span className="text-xs leading-snug text-(--color-muted)">
                Adds a new node after &ldquo;{parentLabel}&rdquo; with a
                transition you configure on the next step. The tool fires
                <strong className="px-1">every time</strong>
                the transition matches.
              </span>
              <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-(--color-accent)/10 px-2 py-0.5 text-[10px] font-medium text-(--color-accent)">
                Deterministic
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setMode("additional");
                onChoose({ mode: "additional" });
              }}
              className="group flex flex-col items-start gap-2 rounded-xl border border-(--color-border) bg-white p-4 text-left transition hover:border-(--color-accent)/60 hover:ring-1 hover:ring-(--color-accent)/40"
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-(--color-accent)">
                Attach to this node
              </span>
              <span className="text-sm font-semibold text-(--color-foreground-strong)">
                Available inside &ldquo;{parentLabel}&rdquo;
              </span>
              <span className="text-xs leading-snug text-(--color-muted)">
                Stays inside the existing node. The LLM
                <strong className="px-1">can choose</strong>
                to call the tool while the node is active — useful when
                the tool is a contingency (e.g. open a ticket if the
                caller asks), not a mandatory step.
              </span>
              <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                LLM-decided
              </span>
            </button>
          </div>
        )}

        {/* ── Step 2: configure the parent→tool edge condition ─────── */}
        {mode === "as_node" && (
          <div className="flex flex-col gap-3 p-4">
            <div>
              <label
                htmlFor="transition-type"
                className="block text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)"
              >
                Transition type
              </label>
              <select
                id="transition-type"
                value={transitionType}
                onChange={(e) =>
                  setTransitionType(
                    e.target.value as "unconditional" | "llm" | "result",
                  )
                }
                className="mt-1 w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm"
              >
                <option value="llm">LLM Condition</option>
                <option value="unconditional">Unconditional</option>
                <option value="result">Tool result branch</option>
              </select>
              <p className="mt-1 text-[11px] text-(--color-muted)">
                {transitionType === "llm" &&
                  "The LLM evaluates the predicate against the conversation each turn. Best for branching on intent (\"the caller asked for billing help\")."}
                {transitionType === "unconditional" &&
                  "Always route here next. The parent can have at most one unconditional outgoing edge — picking this will splice over the existing default."}
                {transitionType === "result" &&
                  "Only valid when the parent is itself a tool_call. Routes to this node based on whether the parent tool succeeded or failed."}
              </p>
            </div>

            {transitionType === "llm" && (
              <div>
                <label
                  htmlFor="llm-condition"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)"
                >
                  LLM condition
                </label>
                <textarea
                  id="llm-condition"
                  value={llmCondition}
                  onChange={(e) => setLlmCondition(e.target.value)}
                  placeholder="e.g. the caller confirmed they want to open a support ticket"
                  rows={4}
                  className={`mt-1 w-full rounded-md border bg-white px-3 py-2 text-sm ${
                    submitted && !llmConditionValid
                      ? "border-red-400/60 ring-1 ring-red-400/40"
                      : "border-(--color-border)"
                  }`}
                />
                {submitted && !llmConditionValid && (
                  <p className="mt-1 text-xs text-red-500">
                    Condition cannot be empty.
                  </p>
                )}
              </div>
            )}

            {transitionType === "result" && (
              <div>
                <label
                  htmlFor="result-branch"
                  className="block text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)"
                >
                  Branch on
                </label>
                <select
                  id="result-branch"
                  value={resultSuccessful ? "successful" : "failed"}
                  onChange={(e) =>
                    setResultSuccessful(e.target.value === "successful")
                  }
                  className="mt-1 w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-sm"
                >
                  <option value="successful">Parent tool succeeded</option>
                  <option value="failed">Parent tool failed</option>
                </select>
              </div>
            )}
          </div>
        )}

        <footer className="flex justify-end gap-2 border-t border-(--color-border) bg-(--color-panel-soft) px-5 py-3">
          {mode === "as_node" && (
            <button
              type="button"
              onClick={() => {
                setMode(null);
                setSubmitted(false);
              }}
              className="rounded-md border border-(--color-border) bg-white px-3 py-1 text-xs text-(--color-muted) hover:bg-(--color-panel-soft)"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-(--color-border) bg-white px-3 py-1 text-xs text-(--color-muted) hover:bg-(--color-panel-soft)"
          >
            Cancel
          </button>
          {mode === "as_node" && (
            <button
              type="button"
              onClick={commit}
              className="rounded-md bg-(--color-accent) px-3 py-1 text-xs font-semibold text-(--color-accent-foreground) hover:opacity-90"
            >
              Create node
            </button>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
