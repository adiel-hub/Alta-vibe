"use client";

import { useState } from "react";
import type { WidgetEntry } from "@/store/agentStore";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";

type Payload = { title?: string };

type Source = "pdl" | "hubspot" | "csv";

const SOURCES: Array<{
  id: Source;
  label: string;
  description: string;
  icon: string;
}> = [
  {
    id: "pdl",
    label: "Search PDL",
    description: "Find prospects by role, industry, location.",
    icon: "🔎",
  },
  {
    id: "hubspot",
    label: "HubSpot CRM",
    description: "Pull contacts with phone numbers from your CRM.",
    icon: "🟠",
  },
  {
    id: "csv",
    label: "Upload CSV",
    description: "Bring your own list — paste or upload a file.",
    icon: "📄",
  },
];

export function AudienceSourcePickerWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = (widget.payload ?? {}) as Payload;
  const [busy, setBusy] = useState<Source | null>(null);

  const pick = async (source: Source) => {
    setBusy(source);
    try {
      await resolveWidget(agentId, widget, "done", { source });
    } catch {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("pdl");
    try {
      await resolveWidget(agentId, widget, "cancelled");
    } catch {
      setBusy(null);
    }
  };

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-white p-4 shadow-md">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-(--color-foreground-strong)">
          {payload.title ?? "How do you want to build the audience?"}
        </p>
        {widget.status !== "pending" && <StatusBadge status={widget.status} />}
      </div>

      {widget.status === "pending" && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy !== null}
                onClick={() => pick(s.id)}
                className={`group flex flex-col items-start gap-1.5 rounded-xl border bg-white p-3 text-left transition ${
                  busy === s.id
                    ? "border-(--color-accent) bg-(--color-accent)/10"
                    : "border-(--color-border) hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span className="text-xl" aria-hidden>
                  {s.icon}
                </span>
                <span className="text-xs font-semibold text-(--color-foreground-strong)">
                  {s.label}
                </span>
                <span className="text-[11px] text-(--color-muted)">
                  {s.description}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={busy !== null}
              onClick={cancel}
              className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
