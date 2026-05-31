"use client";

import { useState } from "react";
import type { WidgetEntry } from "@/store/agentStore";
import { resolveWidget } from "../_shared/resolveWidget";
import { ResolvedPill, WidgetFrame } from "../_shared/WidgetFrame";

type Payload = { title?: string };

type Source = "pdl" | "hubspot" | "csv";

const SOURCES: Array<{
  id: Source;
  label: string;
  icon: string;
}> = [
  {
    id: "pdl",
    label: "Alta search",
    icon: "/alta-stars.png",
  },
  {
    id: "hubspot",
    label: "HubSpot",
    icon: "/integrations/hubspot.png",
  },
  {
    id: "csv",
    label: "CSV",
    icon: "/csv.png",
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

  const chosen =
    widget.status === "done"
      ? SOURCES.find(
          (s) =>
            s.id ===
            ((widget.result ?? {}) as { source?: Source }).source,
        ) ?? null
      : null;

  return (
    <WidgetFrame
      widget={widget}
      title={payload.title ?? "How do you want to build the audience?"}
      resolvedSummary={
        chosen ? (
          <ResolvedPill>
            <img
              src={chosen.icon}
              alt=""
              aria-hidden
              className="h-3.5 w-3.5 object-contain"
            />
            {chosen.label}
          </ResolvedPill>
        ) : undefined
      }
    >
      <div className="mt-3 flex flex-wrap justify-center gap-2">
            {SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy !== null}
                onClick={() => pick(s.id)}
                className={`group flex aspect-square w-24 flex-col items-center justify-center gap-1.5 rounded-xl border bg-white p-2 text-center transition ${
                  busy === s.id
                    ? "border-(--color-accent) bg-(--color-accent)/10"
                    : "border-(--color-border) hover:border-(--color-accent)/50 hover:bg-(--color-panel-soft)"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <img
                  src={s.icon}
                  alt=""
                  aria-hidden
                  className="h-6 w-6 object-contain"
                />
                <span className="text-[11px] font-semibold leading-tight text-(--color-foreground-strong)">
                  {s.label}
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
    </WidgetFrame>
  );
}
