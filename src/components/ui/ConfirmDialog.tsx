"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

/**
 * Reusable confirmation modal that matches the platform's modal language
 * (portal + dimmed/blurred backdrop, rounded panel, Button primitives) — use
 * it in place of the browser `confirm()`.
 *
 * The caller owns the async work and passes `busy`/`error` so the dialog can
 * show a pending state and surface failures inline without closing.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmVariant = "danger",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "danger" | "primary";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc to dismiss (ignored while the action is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const isDanger = confirmVariant === "danger";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => !busy && onCancel()}
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-sm animate-fade-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-(--color-border) bg-(--color-panel) p-6 shadow-lg animate-scale-in"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
              isDanger
                ? "bg-(--color-danger)/10 text-(--color-danger)"
                : "bg-(--color-accent)/10 text-(--color-accent)"
            }`}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-(--color-foreground-strong)">
              {title}
            </h2>
            <div className="mt-1 text-xs leading-relaxed text-(--color-muted)">
              {message}
            </div>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-(--color-danger)">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) transition-colors hover:text-(--color-foreground-strong) disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <Button variant={confirmVariant} disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
