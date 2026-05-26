"use client";

import type { ReactNode } from "react";
import type { WidgetEntry } from "@/store/agentStore";

/**
 * Shared wrapper for chat widgets. Two visual states:
 *   - pending: full card (border + shadow), shows title, description, children
 *   - resolved (done/cancelled/failed): no border/shadow, just title + tiny
 *     inline status (or the widget's custom `resolvedSummary` for done)
 *
 * Each widget passes its title + description + resolved summary; children
 * are the interactive content that only renders while pending.
 */
export function WidgetFrame({
  widget,
  title,
  description,
  resolvedSummary,
  cancelledLabel = "Cancelled",
  failedLabel = "Failed",
  borderless = false,
  children,
}: {
  widget: WidgetEntry;
  title: ReactNode;
  description?: ReactNode;
  /** Shown on the right when status === "done". */
  resolvedSummary?: ReactNode;
  cancelledLabel?: string;
  failedLabel?: string;
  /** Skip the card chrome (border/bg/shadow) while pending. The widget's
   *  own contents are expected to provide enough visual structure. */
  borderless?: boolean;
  children?: ReactNode;
}) {
  const isPending = widget.status === "pending";
  return (
    <div
      className={
        isPending
          ? borderless
            ? "animate-scale-in p-1"
            : "animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-white p-4 shadow-md"
          : "animate-scale-in p-1"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {typeof title === "string" ? (
            <p className="text-sm font-medium text-(--color-foreground-strong)">
              {title}
            </p>
          ) : (
            title
          )}
          {isPending && description && (
            <p className="mt-0.5 text-[11px] text-(--color-muted)">
              {description}
            </p>
          )}
        </div>
        {widget.status === "done" && resolvedSummary}
        {widget.status === "cancelled" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-muted)">
            {cancelledLabel}
          </span>
        )}
        {widget.status === "failed" && (
          <span className="shrink-0 text-[11px] uppercase tracking-wide text-(--color-danger)">
            {failedLabel}
          </span>
        )}
      </div>
      {isPending && children}
    </div>
  );
}

/** Small success-toned pill used by many widgets to summarise a done state. */
export function ResolvedPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-(--color-success)/15 px-2.5 py-1 text-[11px] font-medium text-(--color-success)">
      {children}
    </span>
  );
}
