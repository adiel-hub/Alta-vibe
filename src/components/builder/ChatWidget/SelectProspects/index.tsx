"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { appFetch } from "@/lib/apiClient";
import type { WidgetEntry } from "@/store/agentStore";
import { StatusBadge } from "../_shared/StatusBadge";
import { resolveWidget } from "../_shared/resolveWidget";

type ProspectRow = {
  pdl_id: string;
  full_name: string;
  job_title: string | null;
  job_company_name: string | null;
  location_name: string | null;
  mobile_phone: string | null;
  email: string | null;
  linkedin_url: string | null;
  phone_numbers: string[];
  raw: Record<string, unknown>;
};

type Payload = {
  title: string;
  total: number;
  prospects: ProspectRow[];
};

type AudienceOption = { id: string; name: string; prospect_count: number };

type AudienceChoice =
  | { kind: "existing"; id: string; name: string }
  | { kind: "new"; new_name: string };

export function SelectProspectsWidget({
  agentId,
  widget,
}: {
  agentId: string;
  widget: WidgetEntry;
}) {
  const payload = widget.payload as Payload;
  const prospects = payload?.prospects ?? [];

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(prospects.map((p) => p.pdl_id)),
  );
  const [audiences, setAudiences] = useState<AudienceOption[] | null>(null);
  const [audienceMode, setAudienceMode] = useState<"existing" | "new">("new");
  const [pickedId, setPickedId] = useState<string>("");
  const [newName, setNewName] = useState<string>(payload?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull existing audiences once on mount so the user can append into one.
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
        if (list.length > 0) {
          setAudienceMode("existing");
          setPickedId(list[0].id);
        }
      } catch {
        if (!cancelled) setAudiences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (pdl_id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(pdl_id)) next.delete(pdl_id);
      else next.add(pdl_id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((cur) =>
      cur.size === prospects.length
        ? new Set()
        : new Set(prospects.map((p) => p.pdl_id)),
    );
  };

  const audience: AudienceChoice | null = useMemo(() => {
    if (audienceMode === "existing") {
      const pick = audiences?.find((a) => a.id === pickedId);
      if (!pick) return null;
      return { kind: "existing", id: pick.id, name: pick.name };
    }
    const trimmed = newName.trim();
    if (!trimmed) return null;
    return { kind: "new", new_name: trimmed };
  }, [audienceMode, audiences, pickedId, newName]);

  const canSubmit = selected.size > 0 && audience !== null && !busy;

  const submit = async () => {
    if (!audience) return;
    setBusy(true);
    setError(null);
    try {
      const chosen = prospects.filter((p) => selected.has(p.pdl_id));
      await resolveWidget(agentId, widget, "done", {
        selected_prospect_ids: Array.from(selected),
        prospects: chosen,
        audience:
          audience.kind === "existing"
            ? { id: audience.id }
            : { new_name: audience.new_name },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
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

  const audienceLabel =
    audience?.kind === "existing"
      ? audience.name
      : audience?.kind === "new"
        ? audience.new_name
        : "—";

  return (
    <div className="animate-scale-in rounded-2xl border border-(--color-accent)/40 bg-white p-4 shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-(--color-foreground-strong)">
            {payload?.title ?? "Add prospects to an audience"}
          </p>
          <p className="mt-0.5 text-[11px] text-(--color-muted)">
            {payload?.total && payload.total > prospects.length ? (
              <>
                Previewing{" "}
                <span className="font-semibold text-(--color-foreground-strong)">
                  {prospects.length}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-(--color-foreground-strong)">
                  {payload.total.toLocaleString()}
                </span>{" "}
                matches in PDL
              </>
            ) : (
              <>
                {prospects.length} prospect
                {prospects.length === 1 ? "" : "s"} with a mobile phone
              </>
            )}
          </p>
        </div>
        {widget.status !== "pending" && <StatusBadge status={widget.status} />}
      </div>

      {widget.status === "pending" && (
        <>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={toggleAll}
              disabled={busy}
              className="text-(--color-accent) hover:underline"
            >
              {selected.size === prospects.length
                ? "Deselect all"
                : "Select all"}
            </button>
            <span className="text-(--color-muted)">
              {selected.size} of {prospects.length} selected
            </span>
          </div>

          <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-(--color-border)">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-[1] bg-(--color-panel-soft) text-left text-[10px] uppercase tracking-wide text-(--color-muted)">
                <tr>
                  <th className="w-8 px-2 py-1.5"></th>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Role</th>
                  <th className="px-2 py-1.5">Mobile</th>
                  <th className="px-2 py-1.5">Location</th>
                </tr>
              </thead>
              <tbody>
                {prospects.map((p) => {
                  const isSel = selected.has(p.pdl_id);
                  return (
                    <tr
                      key={p.pdl_id}
                      onClick={() => !busy && toggle(p.pdl_id)}
                      className="cursor-pointer border-t border-(--color-border) bg-white transition hover:bg-(--color-panel-soft)/60"
                    >
                      <td className="px-2 py-1.5 align-middle">
                        <span
                          aria-hidden
                          className={`grid h-4 w-4 place-items-center rounded border ${
                            isSel
                              ? "border-(--color-accent) bg-(--color-accent) text-white"
                              : "border-(--color-border) bg-white"
                          }`}
                        >
                          {isSel ? "✓" : ""}
                        </span>
                      </td>
                      <td className="max-w-[160px] truncate px-2 py-1.5 align-middle font-medium text-(--color-foreground-strong)">
                        {p.full_name}
                      </td>
                      <td className="max-w-[220px] truncate px-2 py-1.5 align-middle text-(--color-foreground)">
                        {[p.job_title, p.job_company_name]
                          .filter(Boolean)
                          .join(" @ ") || (
                          <span className="text-(--color-muted)">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-middle font-mono text-[10px] text-(--color-foreground)">
                        {p.mobile_phone ?? (
                          <span className="text-(--color-muted)">—</span>
                        )}
                      </td>
                      <td className="max-w-[160px] truncate px-2 py-1.5 align-middle text-(--color-muted)">
                        {p.location_name ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-(--color-muted)">
              Add to audience
            </div>
            {audiences && audiences.length > 0 && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name={`aud-${widget.action_id}`}
                  checked={audienceMode === "existing"}
                  onChange={() => setAudienceMode("existing")}
                  disabled={busy}
                />
                <span>Existing</span>
                <select
                  disabled={busy || audienceMode !== "existing"}
                  value={pickedId}
                  onChange={(e) => setPickedId(e.target.value)}
                  className="flex-1 rounded-md border border-(--color-border) bg-white px-2 py-1 text-xs"
                >
                  {audiences.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.prospect_count})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-xs">
              {audiences && audiences.length > 0 ? (
                <input
                  type="radio"
                  name={`aud-${widget.action_id}`}
                  checked={audienceMode === "new"}
                  onChange={() => setAudienceMode("new")}
                  disabled={busy}
                />
              ) : null}
              <span>{audiences && audiences.length > 0 ? "New" : "Audience name"}</span>
              <input
                type="text"
                dir="auto"
                value={newName}
                disabled={busy || audienceMode !== "new"}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Fintech CTOs NYC"
                className="flex-1 rounded-md border border-(--color-border) bg-white px-2 py-1 text-xs outline-none placeholder:text-(--color-muted) focus:border-(--color-accent)/60"
              />
            </label>
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
            <Button disabled={!canSubmit} onClick={submit}>
              Add {selected.size} to {audienceLabel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
