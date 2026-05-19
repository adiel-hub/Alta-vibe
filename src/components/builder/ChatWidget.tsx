"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";
import { createClientLogger } from "@/lib/clientLogger";
import { Button } from "@/components/ui/Button";

const log = createClientLogger("widget");

export function ChatWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  if (widget.kind === "connect_integration") {
    return <ConnectIntegrationWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "confirm") {
    return <ConfirmWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "pick_option") {
    return <PickOptionWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "collect_secret") {
    return <CollectSecretWidget agentId={agentId} widget={widget} />;
  }
  if (widget.kind === "phone_number_setup") {
    return <PhoneNumberSetupWidget agentId={agentId} widget={widget} />;
  }
  return null;
}

function StatusBadge({ status }: { status: WidgetEntry["status"] }) {
  const map: Record<WidgetEntry["status"], string> = {
    pending: "bg-(--color-muted)/20 text-(--color-muted)",
    done: "bg-(--color-success)/20 text-(--color-success)",
    cancelled: "bg-(--color-muted)/20 text-(--color-muted)",
    failed: "bg-(--color-danger)/20 text-(--color-danger)",
  };
  return (
    <span className={`rounded-full px-2 py-[1px] text-[10px] uppercase ${map[status]}`}>
      {status}
    </span>
  );
}

async function resolveWidget(
  agentId: string,
  widget: WidgetEntry,
  status: "done" | "cancelled" | "failed",
  result?: unknown,
): Promise<void> {
  log.info("resolve", {
    kind: widget.kind,
    action_id: widget.action_id,
    status,
  });
  useAgentStore.getState().resolveWidget(widget.action_id, status, result ?? null);
  const res = await appFetch(
    `/api/agents/${agentId}/widgets/${widget.action_id}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, result }),
    },
  );
  if (!res.ok) {
    log.error("resolve failed", { status: res.status });
    useAgentStore
      .getState()
      .resolveWidget(widget.action_id, "failed", { reason: `Resolve HTTP ${res.status}` });
    throw new Error(`Resolve failed (${res.status})`);
  }
  const json = (await res.json().catch(() => null)) as
    | { resumed_job_id?: string }
    | null;
  if (json?.resumed_job_id) {
    log.info("agent loop resumed", { job_id: json.resumed_job_id });
    // Detached attach — agent continues its loop with the widget result.
    void attachToTurn(agentId, json.resumed_job_id, 0);
  }
}

const PROVIDER_DOCS: Record<string, { docsUrl: string; tokenLabel: string }> = {
  hubspot: {
    docsUrl: "https://developers.hubspot.com/docs/guides/apps/private-apps/overview",
    tokenLabel: "Private App access token",
  },
};

function HubspotMark() {
  // Simplified HubSpot mark — keeps brand recognition without shipping the
  // full SVG. Colored via the brand orange so it pops against our panel.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className="text-[#FF7A59]"
    >
      <path d="M18.2 8.1V5.6a1.7 1.7 0 1 0-1.4 0V8a5.6 5.6 0 0 0-2.4.9L7.8 3.6l.2-.6a1.7 1.7 0 1 0-1 .8L13.5 9a5.6 5.6 0 1 0 6.6 1.5l1.7-1.7a1.4 1.4 0 1 0-1-1L18.6 9a5.5 5.5 0 0 0-.4-.9zM15 17a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2z" />
    </svg>
  );
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "hubspot") return <HubspotMark />;
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.71" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function EyeIcon() {
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
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
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
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a19.77 19.77 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a19.86 19.86 0 0 1-2.18 3.19" />
      <path d="M14.12 14.12a3 3 0 0 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function ConnectIntegrationWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as { provider: string; reason: string };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const docs = PROVIDER_DOCS[payload.provider];
  const supportsToken = Boolean(docs);

  const onConnect = async () => {
    setError(null);
    // No-token providers (OAuth) resolve straight away; token providers
    // expand inline so the user can paste their PAT.
    if (!supportsToken) {
      setBusy(true);
      try {
        await resolveWidget(agentId, widget, "done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!expanded) {
      setExpanded(true);
      return;
    }
    const trimmed = token.trim();
    if (trimmed.length < 20) {
      setError("That doesn't look like a valid token. Paste the full value.");
      return;
    }
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "done", { token: trimmed });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const onDismiss = async () => {
    if (expanded) {
      setExpanded(false);
      setToken("");
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const isPending = widget.status === "pending";
  const providerName = prettify(payload.provider);

  return (
    <div className="animate-scale-in overflow-hidden rounded-xl border border-(--color-border) bg-(--color-panel-soft) shadow-sm">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-md bg-(--color-panel)">
            <ProviderIcon provider={payload.provider} />
          </span>
          <span className="truncate text-[13px] font-medium text-(--color-foreground-strong)">
            Connect Your {providerName} Account
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {widget.status !== "pending" && <StatusBadge status={widget.status} />}
          {docs && (
            <a
              href={docs.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${providerName} docs`}
              className="grid h-6 w-6 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel) hover:text-(--color-foreground-strong)"
            >
              <ExternalLinkIcon />
            </a>
          )}
        </div>
      </div>

      {isPending && expanded && supportsToken && (
        <div className="border-t border-(--color-border) bg-(--color-panel) px-3 py-2.5">
          <label className="mb-1 block text-[11px] font-medium text-(--color-muted)">
            Paste your {docs.tokenLabel}
          </label>
          <div className="relative">
            <input
              type={revealed ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder="pat-na1-..."
              className="w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 pr-9 font-mono text-[11px] outline-none focus:border-(--color-accent)"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? "Hide token" : "Show token"}
              title={revealed ? "Hide token" : "Show token"}
              className="absolute right-1 top-1/2 grid h-6 w-7 -translate-y-1/2 place-items-center rounded text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </div>
      )}

      {isPending && (
        <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="text-[12px] text-(--color-muted) transition hover:text-(--color-foreground-strong) disabled:opacity-50"
          >
            {expanded ? "Cancel" : "Dismiss"}
          </button>
          <Button
            size="sm"
            disabled={busy || (expanded && token.trim().length === 0)}
            onClick={onConnect}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      )}

      {(error || payload.reason) && isPending && !expanded && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-muted)">
          {error ? (
            <span className="text-(--color-danger)">{error}</span>
          ) : (
            payload.reason
          )}
        </p>
      )}
      {error && expanded && (
        <p className="border-t border-(--color-border) bg-(--color-panel) px-3 py-1.5 text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  );
}

function ConfirmWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    question: string;
    confirm_label?: string;
    cancel_label?: string;
  };
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{payload.question}</p>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resolveWidget(agentId, widget, "done", { value: "yes" });
              } finally {
                setBusy(false);
              }
            }}
          >
            {payload.confirm_label ?? "Yes"}
          </Button>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resolveWidget(agentId, widget, "cancelled", { value: "no" });
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-full px-4 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
          >
            {payload.cancel_label ?? "No"}
          </button>
        </div>
      )}
    </div>
  );
}

type PickOptionQuestion = {
  question: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multi?: boolean;
};

type PickOptionAnswer = { value: string } | { values: string[] };

function PickOptionWidget({
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

function CollectSecretWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    name: string;
    title: string;
    description: string;
    placeholder?: string;
    docs_url?: string;
  };
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = value.trim();
    if (trimmed.length < 4) {
      setError("That value looks too short. Paste the full secret.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Submit through the existing widget resolve endpoint. The plaintext
      // travels over HTTPS once, the server encrypts and persists, then it
      // is dropped from memory. We replace local state with an empty string
      // immediately on submit so the value doesn't linger in React DevTools.
      await resolveWidget(agentId, widget, "done", { value: trimmed });
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-(--color-foreground-strong)">
            {payload.title}
          </h4>
          <p className="mt-1 whitespace-pre-line text-xs text-(--color-muted)">
            {payload.description}
          </p>
          <p className="mt-1 font-mono text-[10px] text-(--color-muted-soft)">
            secret_ref: {payload.name}
          </p>
        </div>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 space-y-2">
          <div className="relative">
            <input
              type={revealed ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              placeholder={payload.placeholder ?? "Paste the value…"}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              className="w-full rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 pr-16 font-mono text-xs outline-none focus:border-(--color-accent)"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-[10px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-foreground)"
              aria-label={revealed ? "Hide secret" : "Show secret"}
            >
              {revealed ? "Hide" : "Show"}
            </button>
          </div>
          {payload.docs_url && (
            <a
              href={payload.docs_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[11px] text-(--color-accent) hover:underline"
            >
              Where do I find this? →
            </a>
          )}
          <div className="flex gap-2 pt-1">
            <Button
              disabled={busy || value.trim().length === 0}
              onClick={submit}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {widget.status === "done" && (
        <p className="mt-2 text-xs text-(--color-success)">
          Saved. The agent can now use this value via {payload.name}.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
    </div>
  );
}

function prettify(slug: string): string {
  return slug
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

// ── Phone-number setup widget ────────────────────────────────────────────
//
// Two tabs (Twilio / SIP trunk), matching the ElevenLabs import endpoint's
// `oneOf` request body. The user types the number, label, and credentials
// themselves so secrets never pass through the agent.

type TwilioFormState = {
  phone_number: string;
  label: string;
  sid: string;
  token: string;
};

type SipFormState = {
  phone_number: string;
  label: string;
  outbound_address: string;
  outbound_transport: "auto" | "udp" | "tcp" | "tls";
  outbound_media_encryption: "disabled" | "allowed" | "required";
  username: string;
  password: string;
};

const EMPTY_TWILIO: TwilioFormState = {
  phone_number: "",
  label: "",
  sid: "",
  token: "",
};

const EMPTY_SIP: SipFormState = {
  phone_number: "",
  label: "",
  outbound_address: "",
  outbound_transport: "auto",
  outbound_media_encryption: "allowed",
  username: "",
  password: "",
};

function PhoneNumberSetupWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    reason: string;
    default_provider?: "twilio" | "sip_trunk";
    attach_after_import?: boolean;
  };
  const [tab, setTab] = useState<"twilio" | "sip_trunk">(
    payload.default_provider ?? "twilio",
  );
  const [twilio, setTwilio] = useState<TwilioFormState>(EMPTY_TWILIO);
  const [sip, setSip] = useState<SipFormState>(EMPTY_SIP);
  const [revealAuth, setRevealAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPending = widget.status === "pending";

  const validate = (): string | null => {
    if (tab === "twilio") {
      if (!twilio.phone_number.trim()) return "Phone number is required.";
      if (!twilio.label.trim()) return "Label is required.";
      if (!twilio.sid.trim()) return "Twilio Account SID is required.";
      if (!twilio.token.trim()) return "Twilio Auth Token is required.";
      return null;
    }
    if (!sip.phone_number.trim()) return "Phone number is required.";
    if (!sip.label.trim()) return "Label is required.";
    if (!sip.outbound_address.trim())
      return "Outbound SIP address is required.";
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (tab === "twilio") {
        await resolveWidget(agentId, widget, "done", {
          provider: "twilio",
          phone_number: twilio.phone_number.trim(),
          label: twilio.label.trim(),
          sid: twilio.sid.trim(),
          token: twilio.token.trim(),
        });
      } else {
        const creds =
          sip.username.trim().length > 0
            ? {
                username: sip.username.trim(),
                password: sip.password.length > 0 ? sip.password : undefined,
              }
            : null;
        await resolveWidget(agentId, widget, "done", {
          provider: "sip_trunk",
          phone_number: sip.phone_number.trim(),
          label: sip.label.trim(),
          outbound_trunk_config: {
            address: sip.outbound_address.trim(),
            transport: sip.outbound_transport,
            media_encryption: sip.outbound_media_encryption,
            ...(creds ? { credentials: creds } : {}),
          },
        });
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-scale-in overflow-hidden rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) shadow-md">
      <div className="flex items-center justify-between gap-3 border-b border-(--color-border) px-4 py-3">
        <span className="truncate text-sm font-semibold text-(--color-foreground-strong)">
          Import a phone number
        </span>
        {widget.status !== "pending" && (
          <StatusBadge status={widget.status} />
        )}
      </div>

      {isPending && (
        <>
          <div className="flex border-b border-(--color-border) bg-(--color-panel)">
            <TabButton
              active={tab === "twilio"}
              onClick={() => setTab("twilio")}
            >
              <span className="inline-flex items-center gap-1.5">
                <Image
                  src="/integrations/twilio.png"
                  alt=""
                  width={14}
                  height={14}
                  className="h-3.5 w-3.5"
                />
                Twilio
              </span>
            </TabButton>
            <TabButton
              active={tab === "sip_trunk"}
              onClick={() => setTab("sip_trunk")}
            >
              SIP trunk
            </TabButton>
          </div>

          <div className="space-y-3 bg-(--color-panel) p-4">
            {tab === "twilio" ? (
              <>
                <Field
                  label="Phone number"
                  placeholder="+15551234567"
                  value={twilio.phone_number}
                  onChange={(v) =>
                    setTwilio((s) => ({ ...s, phone_number: v }))
                  }
                  disabled={busy}
                />
                <Field
                  label="Label"
                  placeholder="Sales line"
                  value={twilio.label}
                  onChange={(v) => setTwilio((s) => ({ ...s, label: v }))}
                  disabled={busy}
                />
                <Field
                  label="Twilio Account SID"
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={twilio.sid}
                  mono
                  onChange={(v) => setTwilio((s) => ({ ...s, sid: v }))}
                  disabled={busy}
                />
                <SecretField
                  label="Twilio Auth Token"
                  placeholder="paste token"
                  value={twilio.token}
                  revealed={revealAuth}
                  onToggleReveal={() => setRevealAuth((v) => !v)}
                  onChange={(v) => setTwilio((s) => ({ ...s, token: v }))}
                  disabled={busy}
                />
                <a
                  href="https://www.twilio.com/console"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block text-[11px] text-(--color-accent) hover:underline"
                >
                  Find SID + Auth Token in Twilio Console →
                </a>
              </>
            ) : (
              <>
                <Field
                  label="Phone number"
                  placeholder="+15551234567"
                  value={sip.phone_number}
                  onChange={(v) => setSip((s) => ({ ...s, phone_number: v }))}
                  disabled={busy}
                />
                <Field
                  label="Label"
                  placeholder="Production trunk"
                  value={sip.label}
                  onChange={(v) => setSip((s) => ({ ...s, label: v }))}
                  disabled={busy}
                />
                <Field
                  label="Outbound SIP address"
                  placeholder="sip.example.com"
                  value={sip.outbound_address}
                  mono
                  onChange={(v) =>
                    setSip((s) => ({ ...s, outbound_address: v }))
                  }
                  disabled={busy}
                />
                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label="Transport"
                    value={sip.outbound_transport}
                    onChange={(v) =>
                      setSip((s) => ({
                        ...s,
                        outbound_transport: v as SipFormState["outbound_transport"],
                      }))
                    }
                    disabled={busy}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "udp", label: "UDP" },
                      { value: "tcp", label: "TCP" },
                      { value: "tls", label: "TLS" },
                    ]}
                  />
                  <SelectField
                    label="Media encryption"
                    value={sip.outbound_media_encryption}
                    onChange={(v) =>
                      setSip((s) => ({
                        ...s,
                        outbound_media_encryption:
                          v as SipFormState["outbound_media_encryption"],
                      }))
                    }
                    disabled={busy}
                    options={[
                      { value: "disabled", label: "Disabled" },
                      { value: "allowed", label: "Allowed" },
                      { value: "required", label: "Required" },
                    ]}
                  />
                </div>
                <Field
                  label="SIP username (optional)"
                  placeholder="leave blank for ACL auth"
                  value={sip.username}
                  onChange={(v) => setSip((s) => ({ ...s, username: v }))}
                  disabled={busy}
                />
                <SecretField
                  label="SIP password (optional)"
                  placeholder="paste password"
                  value={sip.password}
                  revealed={revealAuth}
                  onToggleReveal={() => setRevealAuth((v) => !v)}
                  onChange={(v) => setSip((s) => ({ ...s, password: v }))}
                  disabled={busy}
                />
              </>
            )}
          </div>

          {error && (
            <p className="border-t border-(--color-border) bg-(--color-panel) px-4 py-2 text-[11px] text-(--color-danger)">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between border-t border-(--color-border) bg-(--color-panel) px-4 py-2">
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="text-[12px] text-(--color-muted) transition hover:text-(--color-foreground-strong) disabled:opacity-50"
            >
              Cancel
            </button>
            <Button disabled={busy} onClick={submit}>
              {busy ? "Importing…" : "Import number"}
            </Button>
          </div>
        </>
      )}

      {widget.status === "done" && (
        <p className="bg-(--color-panel) px-4 py-3 text-xs text-(--color-success)">
          Number imported.
        </p>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 px-4 py-2 text-xs font-medium transition ${
        active
          ? "border-b-2 border-(--color-accent) text-(--color-foreground-strong)"
          : "border-b-2 border-transparent text-(--color-muted) hover:text-(--color-foreground-strong)"
      }`}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        className={`w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-(--color-accent) ${
          mono ? "font-mono text-[11px]" : ""
        }`}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-md border border-(--color-border) bg-white px-2 py-1.5 text-[12px] outline-none focus:border-(--color-accent)"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  revealed,
  onToggleReveal,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-(--color-muted)">
        {label}
      </span>
      <div className="relative">
        <input
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="w-full rounded-md border border-(--color-border) bg-white px-2.5 py-1.5 pr-9 font-mono text-[11px] outline-none focus:border-(--color-accent)"
        />
        <button
          type="button"
          onClick={onToggleReveal}
          aria-label={revealed ? "Hide" : "Show"}
          className="absolute right-1 top-1/2 grid h-6 w-7 -translate-y-1/2 place-items-center rounded text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    </label>
  );
}
