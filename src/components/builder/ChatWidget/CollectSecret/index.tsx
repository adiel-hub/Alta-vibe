"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";

export function CollectSecretWidget({
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
