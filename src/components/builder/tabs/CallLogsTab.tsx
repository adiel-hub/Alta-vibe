"use client";

import { useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import type { CallLogDetail, CallLogSummary } from "@/types/agent";

export function CallLogsTab({ agentId }: { agentId: string }) {
  const [calls, setCalls] = useState<CallLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailsById, setDetailsById] = useState<Record<string, CallLogDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/calls`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const json = (await res.json()) as { calls: CallLogSummary[] };
      setCalls(json.calls);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [agentId]);

  useEffect(() => {
    if (!expandedId || detailsById[expandedId]) return;
    setDetailLoading(true);
    appFetch(`/api/agents/${agentId}/calls/${expandedId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`(${r.status})`);
        return (await r.json()) as CallLogDetail;
      })
      .then((d) => setDetailsById((prev) => ({ ...prev, [expandedId]: d })))
      .catch((err) => setError(err instanceof Error ? err.message : "Load failed"))
      .finally(() => setDetailLoading(false));
  }, [expandedId, agentId, detailsById]);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-(--color-foreground-strong)">
            Call logs
          </h3>
          <p className="mt-1 text-xs text-(--color-muted)">
            Every conversation the agent has handled — expand for transcript and outcomes.
          </p>
        </div>
        <button
          onClick={load}
          className="text-xs text-(--color-muted) hover:text-(--color-foreground)"
        >
          refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-(--color-muted)">loading…</p>
      ) : calls.length === 0 ? (
        <div className="rounded-xl border border-dashed border-(--color-border) px-4 py-10 text-center text-sm text-(--color-muted)">
          No calls yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {calls.map((c, i) => (
            <li
              key={c.id}
              style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
              className="animate-message-in overflow-hidden rounded-xl border border-(--color-border) bg-(--color-panel) shadow-(--shadow-xs) transition hover:border-(--color-border-strong)"
            >
              <CallRow
                call={c}
                expanded={expandedId === c.id}
                onToggle={() =>
                  setExpandedId(expandedId === c.id ? null : c.id)
                }
              />
              {expandedId === c.id && (
                <CallDetailView
                  agentId={agentId}
                  callId={c.id}
                  detail={detailsById[c.id] ?? null}
                  loading={detailLoading && !detailsById[c.id]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CallRow({
  call,
  expanded,
  onToggle,
}: {
  call: CallLogSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const start = new Date(call.start_time);
  const dateStr = start.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeStr = start.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const statusOk = call.call_successful !== false;
  const statusLabel =
    call.status === "done" || call.status === "completed" ? "Completed" : call.status;

  return (
    <button
      onClick={onToggle}
      className="grid w-full grid-cols-[auto_1.4fr_1fr_auto_auto] items-center gap-4 px-4 py-3 text-left transition hover:bg-(--color-panel-soft)"
    >
      <Chevron expanded={expanded} />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-(--color-foreground-strong)">
          {dateStr}
        </div>
        <div className="text-xs text-(--color-muted)">{timeStr}</div>
      </div>
      <div className="min-w-0 truncate text-sm text-(--color-foreground)">
        {call.caller ?? <span className="text-(--color-muted-soft)">—</span>}
      </div>
      <div className="flex items-center gap-3 text-xs text-(--color-muted)">
        <span
          className={`rounded-full px-2 py-[2px] text-[11px] font-medium ${
            statusOk
              ? "bg-(--color-success)/15 text-(--color-success)"
              : "bg-(--color-danger)/15 text-(--color-danger)"
          }`}
        >
          {statusLabel}
        </span>
        <span className="font-mono">{call.duration_seconds}s</span>
      </div>
      <div className="text-right text-xs">
        {call.outcome ? (
          <span className="inline-block max-w-[180px] truncate rounded-md bg-(--color-panel-soft) px-2 py-[3px] text-(--color-foreground)">
            {call.outcome}
          </span>
        ) : (
          <span className="text-(--color-muted-soft)">—</span>
        )}
      </div>
    </button>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-(--color-muted) transition-transform duration-200 ${
        expanded ? "rotate-180" : ""
      }`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CallDetailView({
  agentId,
  callId,
  detail,
  loading,
}: {
  agentId: string;
  callId: string;
  detail: CallLogDetail | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="border-t border-(--color-border) bg-(--color-panel-sunken) px-5 py-4 text-xs text-(--color-muted)">
        loading…
      </div>
    );
  }
  if (!detail) return null;

  // The two post-call signals were previously rendered with swapped
  // labels. data_collection is the typed value extraction (chips), and
  // evaluation is the yes/no call-outcome scoring (✓/✕ list).
  const dataChips = detail.analysis.data_collection ?? [];

  return (
    <div className="animate-fade-in space-y-5 border-t border-(--color-border) bg-(--color-panel-sunken) px-5 py-5">
      {dataChips.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Data extraction
          </h4>
          <div className="flex flex-wrap gap-2">
            {dataChips.map((d) => (
              <OutcomeChip key={d.name} name={d.name} value={d.value} />
            ))}
          </div>
        </section>
      )}

      {detail.analysis.summary && (
        <section>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Summary
          </h4>
          <p className="text-sm leading-relaxed text-(--color-foreground)">
            {detail.analysis.summary}
          </p>
        </section>
      )}

      {detail.analysis.evaluation && detail.analysis.evaluation.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Call outcomes
          </h4>
          <ul className="space-y-2">
            {detail.analysis.evaluation.map((e) => (
              <li key={e.name} className="flex items-start gap-2 text-xs">
                <span
                  className={`mt-[1px] inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                    e.passed
                      ? "bg-(--color-success)/15 text-(--color-success)"
                      : "bg-(--color-danger)/15 text-(--color-danger)"
                  }`}
                >
                  {e.passed ? "✓" : "✕"}
                </span>
                <div className="min-w-0">
                  <span className="font-medium text-(--color-foreground)">
                    {e.name}
                  </span>
                  {e.rationale && (
                    <span className="text-(--color-muted)"> — {e.rationale}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.transcript.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Transcript
          </h4>
          <div className="h-80 overflow-y-auto rounded-xl border border-(--color-border) bg-(--color-panel) p-3">
            <div className="flex flex-col gap-2">
              {detail.transcript.map((t, i) => (
                <TranscriptBubble key={i} role={t.role} message={t.message} />
              ))}
            </div>
          </div>
        </section>
      )}

      {detail.recording_url && (
        <RecordingSection agentId={agentId} callId={callId} />
      )}
    </div>
  );
}

function RecordingSection({
  agentId,
  callId,
}: {
  agentId: string;
  callId: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <section>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
        Recording
      </h4>
      {failed ? (
        <p className="rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 text-xs text-(--color-muted)">
          Recording unavailable for this call.
        </p>
      ) : (
        <audio
          controls
          src={`/api/agents/${agentId}/calls/${callId}/audio`}
          onError={() => setFailed(true)}
          className="h-9 w-full"
        />
      )}
    </section>
  );
}

function OutcomeChip({ name, value }: { name: string; value: unknown }) {
  const label = useMemo(() => name.replace(/_/g, " "), [name]);
  const isBool = typeof value === "boolean";
  const isNullish = value === null || value === undefined || value === "";
  const display = isBool
    ? value
      ? "Yes"
      : "No"
    : isNullish
      ? "—"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-panel) px-3 py-[5px] text-xs">
      <span className="text-(--color-muted)">{label}</span>
      <span
        className={`font-medium ${
          isBool
            ? value
              ? "rounded-full bg-(--color-success)/15 px-2 py-[1px] text-(--color-success)"
              : "rounded-full bg-(--color-danger)/15 px-2 py-[1px] text-(--color-danger)"
            : "text-(--color-foreground-strong)"
        }`}
      >
        {display}
      </span>
    </span>
  );
}

function TranscriptBubble({
  role,
  message,
}: {
  role: "user" | "agent" | "system";
  message: string;
}) {
  if (role === "system") {
    return (
      <div className="text-center text-[11px] italic text-(--color-muted-soft)">
        {message}
      </div>
    );
  }
  const isAgent = role === "agent";
  return (
    <div className={`flex ${isAgent ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
          isAgent
            ? "bg-(--color-panel-soft) text-(--color-foreground)"
            : "bg-(--color-accent) text-(--color-accent-foreground)"
        }`}
      >
        <div
          className={`mb-[2px] text-[10px] font-semibold uppercase tracking-wider ${
            isAgent ? "text-(--color-muted)" : "text-white/70"
          }`}
        >
          {isAgent ? "Agent" : "Visitor"}
        </div>
        {message}
      </div>
    </div>
  );
}
