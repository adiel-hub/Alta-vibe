"use client";

import { useCallback, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import type { EvaluationCriterion } from "@/types/agent";
import { useTypewriter } from "../_shared/useTypewriter";
import { useOutcomesReveal } from "./useOutcomesReveal";
import { DataExtractionSection } from "./DataExtractionSection";

type DraftOutcome = {
  name: string;
  prompt: string;
  use_knowledge_base: boolean;
  scope: "conversation" | "agent";
};

const EMPTY_DRAFT: DraftOutcome = {
  name: "",
  prompt: "",
  use_knowledge_base: false,
  scope: "conversation",
};

type ApiResponse = {
  revision: number;
  patch: { evaluation_criteria: EvaluationCriterion[] };
  outcome?: EvaluationCriterion;
};

export function CallOutcomesTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<DraftOutcome>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Reveal hook runs before the early return so hook order is stable.
  // It safely no-ops on an empty list.
  const outcomes = config?.evaluation_criteria ?? [];
  const { isRevealed, isTyping } = useOutcomesReveal(outcomes);

  if (!config) return null;

  const handle = async (run: () => Promise<Response>, key: string) => {
    setError(null);
    setBusy(key);
    try {
      const res = await run();
      const body = (await res.json().catch(() => null)) as
        | (ApiResponse & { error?: string })
        | null;
      if (!res.ok) {
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      if (body) applyConfigDirect(body.patch, body.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async () => {
    if (!draft.name.trim() || draft.prompt.trim().length < 10) {
      setError("Name is required and prompt must be at least 10 characters.");
      return;
    }
    try {
      await handle(
        () =>
          appFetch(`/api/agents/${agentId}/call-outcomes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: draft.name.trim(),
              prompt: draft.prompt.trim(),
              use_knowledge_base: draft.use_knowledge_base,
              scope: draft.scope,
            }),
          }),
        "create",
      );
      setDraft(EMPTY_DRAFT);
      setCreating(false);
    } catch {
      /* error already surfaced */
    }
  };

  const onUpdate = async (
    outcomeId: string,
    next: Partial<DraftOutcome>,
  ) => {
    await handle(
      () =>
        appFetch(`/api/agents/${agentId}/call-outcomes/${outcomeId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(next),
        }),
      outcomeId,
    );
  };

  const onDelete = async (outcomeId: string) => {
    await handle(
      () =>
        appFetch(`/api/agents/${agentId}/call-outcomes/${outcomeId}`, {
          method: "DELETE",
        }),
      outcomeId,
    );
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-1 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
              Call outcomes
            </h3>
            <p className="mt-1 text-[12px] text-(--color-muted)">
              Goals the agent is graded on after every call. Each outcome
              becomes a yes/no success metric on the call log.
            </p>
          </div>
          {inFlight.has("evaluation") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {outcomes.length === 0 && !creating && (
            <div className="rounded-xl border border-dashed border-(--color-border) bg-(--color-panel-soft) px-4 py-6 text-center">
              <p className="text-sm text-(--color-foreground-strong)">
                No call outcomes yet.
              </p>
              <p className="mt-1 text-[12px] text-(--color-muted)">
                Define the goals you want the agent to achieve on each call —
                for example <em>&quot;agent verified the caller&apos;s
                identity&quot;</em>.
              </p>
            </div>
          )}

          {outcomes
            .filter((o) => isRevealed(o.id))
            .map((o, i) => (
              <div
                key={o.id}
                style={{
                  animationDelay: isTyping(o.id)
                    ? "0ms"
                    : `${Math.min(i, 8) * 40}ms`,
                }}
                className="animate-message-in"
              >
                <OutcomeRow
                  outcome={o}
                  busy={busy === o.id}
                  typewriter={isTyping(o.id)}
                  onSave={(next) => onUpdate(o.id, next)}
                  onDelete={() => onDelete(o.id)}
                />
              </div>
            ))}

          {creating ? (
            <DraftRow
              draft={draft}
              setDraft={setDraft}
              busy={busy === "create"}
              onCancel={() => {
                setDraft(EMPTY_DRAFT);
                setCreating(false);
                setError(null);
              }}
              onSave={onCreate}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="group inline-flex items-center gap-2 rounded-xl border border-dashed border-(--color-border) bg-(--color-panel-soft) px-4 py-3 text-sm font-medium text-(--color-muted) transition hover:border-(--color-accent) hover:text-(--color-accent)"
            >
              <PlusIcon />
              Add call outcome
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      <DataExtractionSection agentId={agentId} />
    </div>
  );
}

function OutcomeRow({
  outcome,
  busy,
  typewriter,
  onSave,
  onDelete,
}: {
  outcome: EvaluationCriterion;
  busy: boolean;
  typewriter: boolean;
  onSave: (next: Partial<DraftOutcome>) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftOutcome>({
    name: outcome.name,
    prompt: outcome.prompt,
    use_knowledge_base: outcome.use_knowledge_base ?? false,
    scope: outcome.scope ?? "conversation",
  });
  const markEvalAnimationDone = useAgentStore((s) => s.markEvalAnimationDone);

  // Type the name first, then the prompt — same one-field-at-a-time
  // cadence the KB cards use, so the agent looks like it's authoring the
  // outcome live.
  const typedName = useTypewriter(outcome.name, typewriter, 55);
  const nameDone = typedName.length >= outcome.name.length;
  const onPromptDone = useCallback(() => {
    markEvalAnimationDone(outcome.id);
  }, [outcome.id, markEvalAnimationDone]);
  const typedPrompt = useTypewriter(
    outcome.prompt,
    typewriter && nameDone,
    220,
    onPromptDone,
  );
  const showNameCursor = typewriter && !nameDone;
  const showPromptCursor =
    typewriter && nameDone && typedPrompt.length < outcome.prompt.length;

  const save = async () => {
    if (!draft.name.trim() || draft.prompt.trim().length < 10) return;
    await onSave({
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      use_knowledge_base: draft.use_knowledge_base,
      scope: draft.scope,
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-(--color-accent) bg-(--color-panel) p-4">
        <DraftFields draft={draft} setDraft={setDraft} />
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft({
                name: outcome.name,
                prompt: outcome.prompt,
                use_knowledge_base: outcome.use_knowledge_base ?? false,
                scope: outcome.scope ?? "conversation",
              });
              setEditing(false);
            }}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-(--color-muted) transition hover:bg-(--color-panel-soft)"
          >
            Cancel
          </button>
          <Button size="sm" onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start justify-between gap-3 rounded-xl border border-(--color-border) bg-(--color-panel) px-4 py-3 transition hover:border-(--color-border-strong)">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <CheckBadgeIcon />
          <span
            dir="auto"
            className="text-sm font-semibold text-(--color-foreground-strong)"
          >
            {typedName}
            {showNameCursor && (
              <span
                aria-hidden
                className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline"
              />
            )}
          </span>
          {nameDone && outcome.use_knowledge_base && (
            <span className="rounded-full bg-(--color-panel-soft) px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-muted)">
              uses KB
            </span>
          )}
          {nameDone && outcome.scope && outcome.scope !== "conversation" && (
            <span className="rounded-full bg-(--color-panel-soft) px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-(--color-muted)">
              scope: {outcome.scope}
            </span>
          )}
        </div>
        <p
          dir="auto"
          className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-(--color-muted)"
        >
          {typedPrompt}
          {showPromptCursor && (
            <span
              aria-hidden
              className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-cursor bg-current align-baseline"
            />
          )}
        </p>
      </div>
      {!typewriter && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            title="Edit"
            aria-label="Edit"
            className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            title="Delete"
            aria-label="Delete"
            className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-danger)/10 hover:text-(--color-danger) disabled:opacity-50"
          >
            {busy ? (
              <span className="text-[10px]">…</span>
            ) : (
              <TrashIcon />
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function DraftRow({
  draft,
  setDraft,
  busy,
  onCancel,
  onSave,
}: {
  draft: DraftOutcome;
  setDraft: (d: DraftOutcome) => void;
  busy: boolean;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  return (
    <div className="rounded-xl border border-(--color-accent) bg-(--color-panel) p-4">
      <DraftFields draft={draft} setDraft={setDraft} />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-(--color-muted) transition hover:bg-(--color-panel-soft)"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={busy}
          className="rounded-md bg-(--color-accent) px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create outcome"}
        </button>
      </div>
    </div>
  );
}

function DraftFields({
  draft,
  setDraft,
}: {
  draft: DraftOutcome;
  setDraft: (d: DraftOutcome) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Name
        </span>
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Caller verified identity"
          maxLength={80}
          className="mt-1 w-full rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm focus:border-(--color-accent) focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
          Goal prompt
        </span>
        <textarea
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          placeholder="Did the agent verify the caller's identity using at least two of: name, date of birth, account number?"
          rows={3}
          maxLength={2000}
          className="mt-1 w-full resize-y rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm leading-relaxed focus:border-(--color-accent) focus:outline-none"
        />
        <span className="mt-1 block text-[11px] text-(--color-muted-soft)">
          The LLM scores this prompt against the transcript as success /
          failure / unknown.
        </span>
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2">
          <input
            type="checkbox"
            checked={draft.use_knowledge_base}
            onChange={(e) =>
              setDraft({ ...draft, use_knowledge_base: e.target.checked })
            }
          />
          <div>
            <div className="text-xs font-medium">Use knowledge base</div>
            <div className="text-[11px] text-(--color-muted)">
              Let the evaluator consult the agent&apos;s KB.
            </div>
          </div>
        </label>
        <label className="rounded-md border border-(--color-border) bg-(--color-panel) px-3 py-2">
          <div className="text-xs font-medium">Scope</div>
          <select
            value={draft.scope}
            onChange={(e) =>
              setDraft({
                ...draft,
                scope: e.target.value as "conversation" | "agent",
              })
            }
            className="mt-1 w-full bg-transparent text-xs focus:outline-none"
          >
            <option value="conversation">Whole conversation</option>
            <option value="agent">Only this agent&apos;s turns</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CheckBadgeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-(--color-accent)"
      aria-hidden
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
