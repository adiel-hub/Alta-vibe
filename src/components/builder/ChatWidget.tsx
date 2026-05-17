"use client";

import { useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore, type WidgetEntry } from "@/store/agentStore";
import { attachToTurn } from "@/store/sseClient";

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
    useAgentStore
      .getState()
      .resolveWidget(widget.action_id, "failed", { reason: `Resolve HTTP ${res.status}` });
    throw new Error(`Resolve failed (${res.status})`);
  }
  const json = (await res.json().catch(() => null)) as
    | { resumed_job_id?: string }
    | null;
  if (json?.resumed_job_id) {
    // Detached attach — agent continues its loop with the widget result.
    void attachToTurn(agentId, json.resumed_job_id, 0);
  }
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
  const click = async (status: "done" | "cancelled") => {
    setBusy(true);
    setError(null);
    try {
      await resolveWidget(agentId, widget, status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold">Connect {prettify(payload.provider)}</h4>
          <p className="mt-1 text-xs text-(--color-muted)">{payload.reason}</p>
        </div>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy}
            onClick={() => click("done")}
            className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground)"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button
            disabled={busy}
            onClick={() => click("cancelled")}
            className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground)"
          >
            Skip
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-(--color-danger)">{error}</p>}
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
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resolveWidget(agentId, widget, "done", { value: "yes" });
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-full bg-(--color-accent) px-4 py-1.5 text-xs font-semibold text-(--color-accent-foreground)"
          >
            {payload.confirm_label ?? "Yes"}
          </button>
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

function PickOptionWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as {
    question: string;
    options: Array<{ value: string; label: string }>;
  };
  const [busy, setBusy] = useState(false);
  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-(--color-panel-soft) p-4 shadow-md">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{payload.question}</p>
        <StatusBadge status={widget.status} />
      </div>
      {widget.status === "pending" && (
        <div className="mt-3 flex flex-wrap gap-2">
          {payload.options.map((o) => (
            <button
              key={o.value}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await resolveWidget(agentId, widget, "done", { value: o.value });
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-full border border-(--color-border) px-3 py-1 text-xs hover:bg-(--color-panel)"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function prettify(slug: string): string {
  return slug
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
