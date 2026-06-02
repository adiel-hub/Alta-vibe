"use client";

/**
 * Pill-click edge editor: edits an edge's forward AND backward conditions
 * (Forward/Backward tabs), each supporting unconditional / llm / result /
 * expression — parity with ElevenLabs' editor. Backward conditions turn an
 * edge into a loop without adding a flipped sibling. Self-contained: owns its
 * state and PATCHes /workflow/edges/[edgeId].
 */
import { useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import type {
  AgentConfigCache,
  WorkflowAstNode,
  WorkflowEdge,
  WorkflowEdgeCondition,
} from "@/types/agent";
import { Field } from "./_shared/Field";
import { ExpressionBuilder, emptyComparison } from "./ExpressionBuilder";

const PILL_MAX_CHARS = 50;

/** Seed forward from the structured form, falling back to the legacy fields. */
function seedForward(edge: WorkflowEdge): WorkflowEdgeCondition {
  if (edge.forward_condition) return edge.forward_condition;
  if (edge.condition && edge.condition.trim().length > 0) {
    return { type: "llm", condition: edge.condition, label: edge.label };
  }
  return { type: "unconditional", ...(edge.label ? { label: edge.label } : {}) };
}

function ConditionForm({
  cond,
  onChange,
  parentLabel,
  targetLabel,
}: {
  cond: WorkflowEdgeCondition;
  onChange: (c: WorkflowEdgeCondition) => void;
  parentLabel: string;
  targetLabel: string;
}) {
  const setType = (t: WorkflowEdgeCondition["type"]) => {
    if (t === "llm")
      onChange({
        type: "llm",
        condition: cond.type === "llm" ? cond.condition : "",
        label: cond.label,
      });
    else if (t === "result")
      onChange({
        type: "result",
        successful: cond.type === "result" ? cond.successful : true,
        label: cond.label,
      });
    else if (t === "expression")
      onChange({
        type: "expression",
        expression: cond.type === "expression" ? cond.expression : emptyComparison(),
        label: cond.label,
      });
    else onChange({ type: "unconditional", label: cond.label });
  };
  return (
    <>
      <Field
        label="Label (pill text)"
        hint={`Short text on the canvas pill — keep ≤${PILL_MAX_CHARS} chars.`}
      >
        <input
          dir="auto"
          value={cond.label ?? ""}
          maxLength={PILL_MAX_CHARS}
          onChange={(e) => onChange({ ...cond, label: e.target.value || undefined })}
          className="vb-field-input"
          placeholder="e.g. wants billing"
        />
      </Field>
      <Field
        label="Transition type"
        hint={`Decides when the flow routes from “${parentLabel}” into “${targetLabel}”.`}
      >
        <select
          value={cond.type}
          onChange={(e) => setType(e.target.value as WorkflowEdgeCondition["type"])}
          className="vb-field-input"
        >
          <option value="llm">LLM Condition</option>
          <option value="expression">Expression</option>
          <option value="result">Tool result branch</option>
          <option value="unconditional">Unconditional</option>
        </select>
        {cond.type === "llm" && (
          <textarea
            dir="auto"
            value={cond.condition}
            onChange={(e) => onChange({ ...cond, condition: e.target.value })}
            placeholder="e.g. the caller confirmed their issue is resolved"
            rows={4}
            className={`vb-field-input vb-field-textarea mt-2 ${
              cond.condition.trim().length === 0
                ? "border-red-400/60 ring-1 ring-red-400/40"
                : ""
            }`}
          />
        )}
        {cond.type === "result" && (
          <select
            value={cond.successful ? "successful" : "failed"}
            onChange={(e) => onChange({ ...cond, successful: e.target.value === "successful" })}
            className="vb-field-input mt-2"
          >
            <option value="successful">Parent tool succeeded</option>
            <option value="failed">Parent tool failed</option>
          </select>
        )}
        {cond.type === "expression" && (
          <div className="mt-2">
            <ExpressionBuilder
              value={cond.expression as WorkflowAstNode}
              onChange={(expr) => onChange({ ...cond, expression: expr })}
            />
          </div>
        )}
        {cond.type === "unconditional" && (
          <p className="mt-1 text-xs text-(--color-muted)">
            The flow always routes here next.
          </p>
        )}
      </Field>
    </>
  );
}

export function EdgeConditionEditor({
  agentId,
  edge,
  parentLabel,
  targetLabel,
  onClose,
}: {
  agentId: string;
  edge: WorkflowEdge;
  parentLabel: string;
  targetLabel: string;
  onClose: () => void;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [tab, setTab] = useState<"forward" | "backward">("forward");
  const [forward, setForward] = useState<WorkflowEdgeCondition>(() => seedForward(edge));
  const [backwardEnabled, setBackwardEnabled] = useState(!!edge.backward_condition);
  const [backward, setBackward] = useState<WorkflowEdgeCondition>(
    () => edge.backward_condition ?? { type: "llm", condition: "" },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initial = JSON.stringify({
    f: seedForward(edge),
    b: edge.backward_condition ?? null,
  });
  const current = JSON.stringify({
    f: forward,
    b: backwardEnabled ? backward : null,
  });
  const dirty = current !== initial;

  const llmEmpty = (c: WorkflowEdgeCondition) =>
    c.type === "llm" && c.condition.trim().length === 0;

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (llmEmpty(forward) || (backwardEnabled && llmEmpty(backward))) {
      setError("LLM conditions cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const labelField = forward.label?.trim() || undefined;
      const res = await appFetch(`/api/agents/${agentId}/workflow/edges/${edge.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          forward_condition: forward,
          // Keep the legacy edge-root label in sync with the forward pill.
          label: labelField ?? null,
          backward_condition: backwardEnabled ? backward : null,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as {
        revision: number;
        patch: Partial<AgentConfigCache>;
      };
      applyConfigDirect(json.patch, json.revision);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className="vb-el-inspector">
      <header className="vb-el-inspector-head">
        <span className="vb-el-icon" aria-hidden>
          ⤷
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-(--color-foreground-strong)">
            {parentLabel} → {targetLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          ✕
        </button>
      </header>

      <div className="vb-cond-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "forward"}
          className={`vb-cond-tab ${tab === "forward" ? "is-active" : ""}`}
          onClick={() => setTab("forward")}
        >
          Forward
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "backward"}
          className={`vb-cond-tab ${tab === "backward" ? "is-active" : ""}`}
          onClick={() => setTab("backward")}
        >
          Backward
        </button>
      </div>

      <div className="vb-el-inspector-body">
        {tab === "forward" ? (
          <ConditionForm
            cond={forward}
            onChange={setForward}
            parentLabel={parentLabel}
            targetLabel={targetLabel}
          />
        ) : (
          <>
            <label className="mb-3 flex items-center gap-2 text-xs text-(--color-foreground-strong)">
              <input
                type="checkbox"
                checked={backwardEnabled}
                onChange={(e) => setBackwardEnabled(e.target.checked)}
              />
              Enable backward (loop) transition
            </label>
            <p className="mb-3 text-[11px] text-(--color-muted)">
              Lets the flow loop back from “{targetLabel}” to “{parentLabel}” on the same edge,
              without adding a reversed sibling edge.
            </p>
            {backwardEnabled && (
              <ConditionForm
                cond={backward}
                onChange={setBackward}
                parentLabel={targetLabel}
                targetLabel={parentLabel}
              />
            )}
          </>
        )}

        {error && (
          <p className="vb-field-hint" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}
      </div>

      <footer className="vb-el-inspector-foot">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="rounded-md px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-(--color-foreground-strong) px-3 py-1.5 text-xs font-semibold text-white disabled:bg-(--color-border-strong) disabled:text-(--color-muted-soft)"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </footer>
    </aside>
  );
}
