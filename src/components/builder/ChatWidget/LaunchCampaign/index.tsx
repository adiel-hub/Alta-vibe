"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { appFetch } from "@/lib/apiClient";
import type { WidgetEntry } from "@/store/agentStore";
import type { PhoneNumber } from "@/types/agent";
import { resolveWidget } from "../_shared/resolveWidget";
import { ResolvedPill, WidgetFrame } from "../_shared/WidgetFrame";

type Payload = {
  title?: string;
  agent_id: string;
  agent_phone_numbers: PhoneNumber[];
  preselected_audience_id?: string | null;
};

type AudienceOption = {
  id: string;
  name: string;
  description?: string;
  prospect_count: number;
};

export function LaunchCampaignWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = (widget.payload ?? {}) as Payload;
  const phoneNumbers: PhoneNumber[] = payload.agent_phone_numbers ?? [];

  const [audiences, setAudiences] = useState<AudienceOption[] | null>(null);
  const [pickedAudienceId, setPickedAudienceId] = useState<string>(
    payload.preselected_audience_id ?? "",
  );
  const [pickedPhoneId, setPickedPhoneId] = useState<string>(
    phoneNumbers[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/audiences");
        if (!res.ok) return;
        const json = (await res.json()) as { audiences?: AudienceOption[] };
        if (cancelled) return;
        const list = json.audiences ?? [];
        setAudiences(list);
        setPickedAudienceId((cur) => {
          if (cur && list.some((a) => a.id === cur)) return cur;
          const firstWithProspects = list.find((a) => a.prospect_count > 0);
          return firstWithProspects?.id ?? list[0]?.id ?? "";
        });
      } catch {
        if (!cancelled) setAudiences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pickedAudience = useMemo(
    () => audiences?.find((a) => a.id === pickedAudienceId) ?? null,
    [audiences, pickedAudienceId],
  );

  const prospectCount = pickedAudience?.prospect_count ?? 0;
  const hasPhone = pickedPhoneId.length > 0;
  const canLaunch =
    !busy && pickedAudienceId.length > 0 && hasPhone && prospectCount > 0;

  const launch = async () => {
    if (!pickedAudience) return;
    setBusy(true);
    setError(null);
    try {
      const res = await appFetch(
        `/api/audiences/${pickedAudienceId}/campaigns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_id: agentId,
            agent_phone_number_id: pickedPhoneId,
          }),
        },
      );
      if (!res.ok) {
        const errBody = (await res
          .json()
          .catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as { id: string; total: number };
      await resolveWidget(agentId, widget, "done", {
        campaign_id: json.id,
        audience_id: pickedAudienceId,
        audience_name: pickedAudience.name,
        total: json.total,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch");
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

  const doneResult =
    widget.status === "done"
      ? ((widget.result ?? {}) as {
          audience_name?: string;
          total?: number;
        })
      : null;

  return (
    <WidgetFrame
      widget={widget}
      title={payload.title ?? "Pick a list to start calling"}
      description="We'll start dialing the prospects in the selected list with this agent."
      resolvedSummary={
        doneResult ? (
          <ResolvedPill>
            Launched
            {doneResult.audience_name ? ` · ${doneResult.audience_name}` : ""}
            {typeof doneResult.total === "number"
              ? ` · ${doneResult.total} call${doneResult.total === 1 ? "" : "s"}`
              : ""}
          </ResolvedPill>
        ) : undefined
      }
    >
      <div className="mt-3 space-y-3">
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
                List
              </label>
              {audiences === null ? (
                <div className="mt-1 h-8 animate-pulse rounded-md bg-(--color-panel-soft)" />
              ) : audiences.length === 0 ? (
                <p className="mt-1 text-xs text-(--color-muted)">
                  You don&apos;t have any audiences yet. Build one first from
                  the Audiences page.
                </p>
              ) : (
                <div className="mt-1 max-h-60 overflow-auto rounded-lg border border-(--color-border)">
                  {audiences.map((a) => {
                    const selected = a.id === pickedAudienceId;
                    const empty = a.prospect_count === 0;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        disabled={busy || empty}
                        onClick={() => setPickedAudienceId(a.id)}
                        className={`flex w-full items-start justify-between gap-3 border-b border-(--color-border) px-3 py-2 text-left text-xs last:border-b-0 transition ${
                          selected
                            ? "bg-(--color-accent)/10"
                            : "bg-white hover:bg-(--color-panel-soft)/60"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-(--color-foreground-strong)">
                            {a.name}
                          </span>
                          {a.description && (
                            <span className="mt-0.5 block truncate text-[10px] text-(--color-muted)">
                              {a.description}
                            </span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 text-[10px] ${
                            empty
                              ? "text-(--color-muted)"
                              : "text-(--color-foreground)"
                          }`}
                        >
                          {a.prospect_count} prospect
                          {a.prospect_count === 1 ? "" : "s"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {phoneNumbers.length > 1 && (
              <div>
                <label className="block text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
                  Call from
                </label>
                <select
                  value={pickedPhoneId}
                  disabled={busy}
                  onChange={(e) => setPickedPhoneId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-(--color-border) bg-white px-2 py-1.5 text-xs"
                >
                  {phoneNumbers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label ? `${p.label} — ${p.number}` : p.number}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {phoneNumbers.length === 1 && (
              <p className="text-[11px] text-(--color-muted)">
                Calling from{" "}
                <span className="font-mono text-(--color-foreground)">
                  {phoneNumbers[0].label
                    ? `${phoneNumbers[0].label} (${phoneNumbers[0].number})`
                    : phoneNumbers[0].number}
                </span>
              </p>
            )}
          </div>

          {error && (
            <p className="mt-2 text-[11px] text-(--color-danger)">{error}</p>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="rounded-full px-3 py-1.5 text-xs text-(--color-muted) hover:text-(--color-foreground-strong)"
            >
              Cancel
            </button>
            <Button disabled={!canLaunch} onClick={launch}>
              {busy
                ? "Launching…"
                : prospectCount > 0
                  ? `Launch · ${prospectCount} call${prospectCount === 1 ? "" : "s"}`
                  : "Launch"}
            </Button>
          </div>
    </WidgetFrame>
  );
}
