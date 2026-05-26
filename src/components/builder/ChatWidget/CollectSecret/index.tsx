"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { resolveWidget } from "../_shared/resolveWidget";
import { ResolvedPill } from "../_shared/WidgetFrame";

type SecretEntry = {
  name: string;
  title: string;
  description: string;
  placeholder?: string;
  docs_url?: string;
};

type CollectSecretPayload =
  | SecretEntry
  | { secrets: SecretEntry[] };

function isBatch(p: CollectSecretPayload): p is { secrets: SecretEntry[] } {
  return Array.isArray((p as { secrets?: SecretEntry[] }).secrets);
}

export function CollectSecretWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as CollectSecretPayload;
  const entries: SecretEntry[] = isBatch(payload) ? payload.secrets : [payload];

  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(entries.map((e) => [e.name, ""])),
  );
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setValue = (name: string, v: string) =>
    setValues((prev) => ({ ...prev, [name]: v }));
  const toggleReveal = (name: string) =>
    setRevealed((prev) => ({ ...prev, [name]: !prev[name] }));

  const allFilled = entries.every((e) => (values[e.name] ?? "").trim().length > 0);

  const submit = async () => {
    const trimmedMap: Record<string, string> = {};
    for (const e of entries) {
      const v = (values[e.name] ?? "").trim();
      if (v.length < 4) {
        setError(`"${e.title}" looks too short. Paste the full value.`);
        return;
      }
      trimmedMap[e.name] = v;
    }
    setError(null);
    setBusy(true);
    try {
      const result =
        entries.length === 1
          ? { value: trimmedMap[entries[0].name] }
          : { values: trimmedMap };
      await resolveWidget(agentId, widget, "done", result);
      setValues(Object.fromEntries(entries.map((e) => [e.name, ""])));
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

  const isPending = widget.status === "pending";
  const isDone = widget.status === "done";

  if (!isPending) {
    return (
      <div className="animate-scale-in flex items-center justify-between gap-3 p-1">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-(--color-foreground-strong)">
          <LockIcon />
          {entries.length === 1
            ? entries[0].title
            : `${entries.length} secrets`}
        </div>
        {isDone && (
          <ResolvedPill>
            Saved
            {entries.length === 1 ? ` · ${entries[0].name}` : ""}
          </ResolvedPill>
        )}
        {widget.status === "cancelled" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-muted)">
            Cancelled
          </span>
        )}
        {widget.status === "failed" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-danger)">
            Failed
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="animate-scale-in rounded-xl border border-(--color-border) bg-(--color-panel-soft)/60 px-3.5 py-3">
      <div className="space-y-3">
        {entries.map((entry, idx) => (
          <div
            key={entry.name}
            className={
              idx > 0 ? "border-t border-(--color-border)/60 pt-3" : undefined
            }
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                title="Stored encrypted; never shown back to the model in plain text"
                className="text-(--color-muted)"
              >
                <LockIcon />
              </span>
              <h4 className="text-[13px] font-medium text-(--color-foreground-strong)">
                {entry.title}
              </h4>
              {isDone && (
                <span
                  aria-label="Saved"
                  className="text-(--color-success)"
                >
                  ✓
                </span>
              )}
            </div>
            {isPending && (
              <p className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-(--color-muted)">
                {entry.description}
              </p>
            )}
            {isPending && (
              <div className="mt-2">
                <div className="relative">
                  <input
                    type={revealed[entry.name] ? "text" : "password"}
                    value={values[entry.name] ?? ""}
                    onChange={(e) => setValue(entry.name, e.target.value)}
                    disabled={busy}
                    placeholder={entry.placeholder ?? "Paste the value…"}
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    autoComplete="off"
                    className="w-full rounded-md border border-(--color-border) bg-(--color-panel) px-2.5 py-1.5 pr-14 font-mono text-xs outline-none focus:border-(--color-accent)"
                  />
                  <button
                    type="button"
                    onClick={() => toggleReveal(entry.name)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-(--color-muted) hover:text-(--color-foreground)"
                    aria-label={revealed[entry.name] ? "Hide" : "Show"}
                  >
                    {revealed[entry.name] ? "Hide" : "Show"}
                  </button>
                </div>
                {entry.docs_url && (
                  <a
                    href={entry.docs_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block text-[10px] text-(--color-accent) hover:underline"
                  >
                    Where do I find this? →
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {isPending && (
        <div className="mt-3 flex gap-2">
          <Button disabled={busy || !allFilled} onClick={submit}>
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
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
