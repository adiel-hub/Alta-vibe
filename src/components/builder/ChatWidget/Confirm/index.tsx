"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";

export function ConfirmWidget({
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
