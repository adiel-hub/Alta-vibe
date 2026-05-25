"use client";

import { useEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/apiClient";

type ItemStatus = "queued" | "calling" | "done" | "failed" | "skipped";

type Item = {
  prospect_id: string;
  full_name: string;
  job_title: string | null;
  job_company_name: string | null;
  to_number: string;
  status: ItemStatus;
  conversation_id: string | null;
  error: string | null;
};

type CampaignSnapshot = {
  id: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  next_seq: number;
  items: Item[];
};

const STATUS_COLOR: Record<ItemStatus, string> = {
  queued: "bg-(--color-muted)/15 text-(--color-muted)",
  calling: "bg-(--color-accent)/15 text-(--color-accent)",
  done: "bg-(--color-success)/15 text-(--color-success)",
  failed: "bg-(--color-danger)/15 text-(--color-danger)",
  skipped: "bg-(--color-muted)/15 text-(--color-muted)",
};

export function CampaignProgress({
  audienceId,
  campaignId,
  onDismiss,
}: {
  audienceId: string;
  campaignId: string;
  onDismiss: () => void;
}) {
  const [snapshot, setSnapshot] = useState<CampaignSnapshot | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Initial GET for the full prospect list, then attach the SSE stream
  // for live updates.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch(
          `/api/audiences/${audienceId}/campaigns/${campaignId}`,
        );
        const json = (await res.json().catch(() => null)) as
          | CampaignSnapshot
          | null;
        if (cancelled || !json) return;
        setSnapshot(json);
      } catch {
        /* will retry through SSE-driven updates */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audienceId, campaignId]);

  // SSE stream. EventSource doesn't support custom headers, so the shared
  // secret has to ride as a query param — but we use a same-origin URL
  // since auth headers come from middleware in production; the gate is
  // best-effort dev-only when no secret is configured. We rely on the
  // existing fetch flow for header-based auth and the SSE poll merely
  // shows live event types.
  useEffect(() => {
    if (!snapshot) return;
    const url = `/api/audiences/${audienceId}/campaigns/${campaignId}/stream?since=0`;
    const es = new EventSource(url);
    esRef.current = es;

    const refresh = async () => {
      try {
        const res = await appFetch(
          `/api/audiences/${audienceId}/campaigns/${campaignId}`,
        );
        const json = (await res.json().catch(() => null)) as
          | CampaignSnapshot
          | null;
        if (json) setSnapshot(json);
      } catch {
        /* keep last snapshot */
      }
    };

    // Each event type triggers a refresh — the SSE payload is the
    // event itself, and we re-GET to get the merged per-item view.
    const onEvent = () => {
      void refresh();
    };
    es.addEventListener("item_started", onEvent);
    es.addEventListener("item_done", onEvent);
    es.addEventListener("item_failed", onEvent);
    es.addEventListener("item_skipped", onEvent);
    es.addEventListener("campaign_done", () => {
      void refresh();
      es.close();
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [audienceId, campaignId, snapshot]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await appFetch(`/api/audiences/${audienceId}/campaigns/${campaignId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
    } finally {
      setCancelling(false);
    }
  };

  if (!snapshot) {
    return (
      <div className="rounded-xl border border-(--color-border) bg-white p-4 text-xs text-(--color-muted)">
        Loading campaign…
      </div>
    );
  }

  const total = snapshot.items.length;
  const done = snapshot.items.filter((i) => i.status === "done").length;
  const failed = snapshot.items.filter((i) => i.status === "failed").length;
  const skipped = snapshot.items.filter((i) => i.status === "skipped").length;
  const calling = snapshot.items.filter((i) => i.status === "calling").length;
  const progressed = done + failed + skipped;
  const pct = total === 0 ? 0 : Math.round((progressed / total) * 100);

  const isTerminal =
    snapshot.status === "completed" ||
    snapshot.status === "cancelled" ||
    snapshot.status === "failed";

  return (
    <div className="rounded-xl border border-(--color-accent)/30 bg-(--color-accent-glow) p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-(--color-foreground-strong)">
            Campaign {snapshot.status}
          </div>
          <div className="mt-0.5 text-xs text-(--color-muted)">
            {progressed} / {total} processed
            {calling > 0 ? ` • ${calling} calling` : ""}
            {done > 0 ? ` • ${done} done` : ""}
            {failed > 0 ? ` • ${failed} failed` : ""}
            {skipped > 0 ? ` • ${skipped} skipped` : ""}
          </div>
        </div>
        <div className="flex gap-2">
          {!isTerminal && (
            <button
              disabled={cancelling}
              onClick={cancel}
              className="rounded-md border border-(--color-danger)/30 px-2 py-1 text-[11px] text-(--color-danger) hover:bg-(--color-danger)/10"
            >
              Cancel
            </button>
          )}
          {isTerminal && (
            <button
              onClick={onDismiss}
              className="rounded-md px-2 py-1 text-[11px] text-(--color-muted) hover:text-(--color-foreground-strong)"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/60">
        <div
          className="h-full bg-(--color-accent) transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>

      <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {snapshot.items.map((it) => (
          <li
            key={it.prospect_id}
            className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-3 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-(--color-foreground-strong)">
                {it.full_name}
              </div>
              <div className="truncate text-(--color-muted)">
                {[it.job_title, it.job_company_name]
                  .filter(Boolean)
                  .join(" @ ") || "—"}
                {" • "}
                <span className="font-mono">{it.to_number || "(no #)"}</span>
              </div>
              {it.error && (
                <div className="truncate text-[10px] text-(--color-danger)">
                  {it.error}
                </div>
              )}
            </div>
            <span
              className={`rounded-full px-2 py-[2px] text-[10px] uppercase tracking-wide ${STATUS_COLOR[it.status]}`}
            >
              {it.status}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
