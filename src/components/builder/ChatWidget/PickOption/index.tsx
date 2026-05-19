"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";

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

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-white p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isWizard && (
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-(--color-muted)">
              Question {step + 1} of {questions.length}
            </div>
          )}
          <p dir="auto" className="text-sm">
            {current.question}
          </p>
        </div>
        {widget.status !== "pending" && (
          <StatusBadge status={widget.status} />
        )}
      </div>
      {widget.status === "pending" && (
        <>
          <div className="mt-3 space-y-1.5">
            {visibleOptions.map((o) => {
              if (isMulti) {
                const isSel = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={busy}
                    onClick={() => toggle(o.value)}
                    className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition ${
                      isSel
                        ? "border-(--color-accent) bg-(--color-accent)/10"
                        : "border-(--color-border) bg-white hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`mt-[2px] grid h-4 w-4 flex-shrink-0 place-items-center rounded border ${
                        isSel
                          ? "border-(--color-accent) bg-(--color-accent) text-white"
                          : "border-(--color-border)"
                      }`}
                    >
                      {isSel ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        dir="auto"
                        className="block font-medium text-(--color-foreground-strong)"
                      >
                        {o.label}
                      </span>
                      {o.description && (
                        <span
                          dir="auto"
                          className="mt-0.5 block text-(--color-muted)"
                        >
                          {o.description}
                        </span>
                      )}
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
                  className="flex w-full items-start gap-2 rounded-lg border border-(--color-border) bg-white px-3 py-2 text-left text-xs transition hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      dir="auto"
                      className="block font-medium text-(--color-foreground-strong)"
                    >
                      {o.label}
                    </span>
                    {o.description && (
                      <span
                        dir="auto"
                        className="mt-0.5 block text-(--color-muted)"
                      >
                        {o.description}
                      </span>
                    )}
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
                className="mt-2 w-full rounded-lg border border-(--color-border) bg-white px-3 py-2 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
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
                className="flex-1 rounded-lg border border-(--color-border) bg-white px-3 py-2 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
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
      )}
    </div>
  );
}
