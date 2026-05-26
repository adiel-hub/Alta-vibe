"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import type { WidgetEntry } from "@/store/agentStore";
import { resolveWidget } from "../_shared/resolveWidget";
import { ResolvedPill, WidgetFrame } from "../_shared/WidgetFrame";

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
  const choice =
    widget.status === "done"
      ? ((widget.result ?? {}) as { value?: string }).value
      : null;
  return (
    <WidgetFrame
      widget={widget}
      title={payload.question}
      resolvedSummary={
        choice ? (
          <ResolvedPill>
            {choice === "yes" ? payload.confirm_label ?? "Yes" : choice}
          </ResolvedPill>
        ) : undefined
      }
      cancelledLabel={payload.cancel_label ?? "No"}
    >
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
    </WidgetFrame>
  );
}
