"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { resolveWidget } from "../_shared/resolveWidget";
import { ResolvedPill, WidgetFrame } from "../_shared/WidgetFrame";

type PickOptionQuestion = {
  question: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multi?: boolean;
};

type PickOptionAnswer = { value: string } | { values: string[] };

export function PickOptionWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  // Accepts two payload shapes (matches the zod union in widgets.ts):
  //   - Single question:  { question, options, multi? }
  //   - Multi-question:   { questions: [...] }
  // Normalise both to a Question[] so the render path doesn't branch.
  const rawPayload = widget.payload as
    | PickOptionQuestion
    | { questions: PickOptionQuestion[] };
  const questions: PickOptionQuestion[] =
    "questions" in rawPayload && Array.isArray(rawPayload.questions)
      ? rawPayload.questions
      : [rawPayload as PickOptionQuestion];
  const isWizard = questions.length > 1;

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<PickOptionAnswer[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [otherText, setOtherText] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset the per-question scratch state whenever we advance.
  useEffect(() => {
    setSelected(new Set());
    setOtherText("");
  }, [step]);

  const current = questions[step] ?? questions[0];
  const visibleOptions = current.options.slice(0, 3);
  const isLast = step === questions.length - 1;

  // Submit one question's answer. If it's the last question, send the
  // payload upstream; otherwise stash it and advance the step.
  const recordAndAdvance = async (answer: PickOptionAnswer) => {
    if (!isLast) {
      setAnswers((prev) => [...prev, answer]);
      setStep((s) => s + 1);
      return;
    }
    setBusy(true);
    try {
      const finalAnswers = [...answers, answer];
      // Preserve the legacy single-answer shape when the payload was a
      // single question, so existing resolvers don't have to special-case.
      const result: Record<string, unknown> = isWizard
        ? { answers: finalAnswers }
        : (finalAnswers[0] as Record<string, unknown>);
      await resolveWidget(agentId, widget, "done", result);
    } finally {
      setBusy(false);
    }
  };

  const submitSingle = (value: string) => {
    void recordAndAdvance({ value });
  };

  const submitMulti = () => {
    const t = otherText.trim();
    const values = Array.from(selected);
    if (t) values.push(t);
    if (values.length === 0) return;
    void recordAndAdvance({ values });
  };

  const submitOther = () => {
    const t = otherText.trim();
    if (!t || busy) return;
    void recordAndAdvance({ value: t });
  };

  const toggle = (value: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  const isMulti = current.multi === true;
  const totalSelections = selected.size + (otherText.trim() ? 1 : 0);
  const advanceLabel = isLast ? "Confirm" : "Next";

  // Summarise the chosen value(s) for the resolved pill.
  const resolvedSummary = (() => {
    if (widget.status !== "done") return undefined;
    const raw = widget.result ?? {};
    type SingleAnswer = { value?: string };
    type MultiAnswer = { values?: string[] };
    type WizardAnswer = { answers?: Array<SingleAnswer | MultiAnswer> };
    const labelFor = (v: string, q: PickOptionQuestion) =>
      q.options.find((o) => o.value === v)?.label ?? v;
    if (isWizard) {
      const answers = (raw as WizardAnswer).answers ?? [];
      const parts = answers.map((a, i) => {
        const q = questions[i] ?? questions[0];
        if ("values" in a && Array.isArray(a.values)) {
          return a.values.map((v) => labelFor(v, q)).join(", ");
        }
        if ("value" in a && typeof a.value === "string") {
          return labelFor(a.value, q);
        }
        return "—";
      });
      return parts.length > 0 ? (
        <ResolvedPill>{parts.join(" · ")}</ResolvedPill>
      ) : undefined;
    }
    const single = raw as SingleAnswer & MultiAnswer;
    if (Array.isArray(single.values) && single.values.length > 0) {
      return (
        <ResolvedPill>
          {single.values.map((v) => labelFor(v, current)).join(", ")}
        </ResolvedPill>
      );
    }
    if (typeof single.value === "string") {
      return <ResolvedPill>{labelFor(single.value, current)}</ResolvedPill>;
    }
    return undefined;
  })();

  return (
    <WidgetFrame
      widget={widget}
      borderless
      title={
        <>
          {isWizard && (
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-(--color-muted)">
              Question {step + 1} of {questions.length}
            </div>
          )}
          <p dir="auto" className="text-sm">
            {current.question}
          </p>
        </>
      }
      resolvedSummary={resolvedSummary}
    >
      <>
          <div className="mt-3 space-y-2">
            {visibleOptions.map((o) => {
              if (isMulti) {
                const isSel = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(o.value)}
                    title={o.description}
                    className={`flex w-full items-center gap-2.5 rounded-md border px-4 py-3 text-left text-sm transition ${
                      isSel
                        ? "border-(--color-accent) bg-(--color-accent)/10"
                        : "border-(--color-border) bg-white hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`grid h-4 w-4 flex-shrink-0 place-items-center rounded border ${
                        isSel
                          ? "border-(--color-accent) bg-(--color-accent) text-white"
                          : "border-(--color-border)"
                      }`}
                    >
                      {isSel ? "✓" : ""}
                    </span>
                    <span
                      dir="auto"
                      className="min-w-0 flex-1 font-medium text-(--color-foreground-strong)"
                    >
                      {o.label}
                    </span>
                  </button>
                );
              }
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={busy}
                  onClick={() => submitSingle(o.value)}
                  title={o.description}
                  className="flex w-full items-center gap-2.5 rounded-md border border-(--color-border) bg-white px-4 py-3 text-left text-sm transition hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                >
                  <span
                    dir="auto"
                    className="min-w-0 flex-1 font-medium text-(--color-foreground-strong)"
                  >
                    {o.label}
                  </span>
                </button>
              );
            })}
          </div>

          {isMulti ? (
            <>
              <input
                type="text"
                dir="auto"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                disabled={busy}
                placeholder="Other..."
                className="mt-2 w-full rounded-md border border-(--color-border) bg-white px-3 py-2 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  disabled={busy}
                  onClick={() => resolveWidget(agentId, widget, "cancelled")}
                  className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
                >
                  Cancel
                </button>
                <Button
                  disabled={busy || totalSelections === 0}
                  onClick={submitMulti}
                >
                  {advanceLabel} ({totalSelections})
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                dir="auto"
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitOther();
                  }
                }}
                disabled={busy}
                placeholder="Other..."
                className="flex-1 rounded-md border border-(--color-border) bg-white px-3 py-2 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
              />
              <Button
                disabled={busy || !otherText.trim()}
                onClick={submitOther}
              >
                {isLast ? "Send" : "Next"}
              </Button>
            </div>
          )}
      </>
    </WidgetFrame>
  );
}
