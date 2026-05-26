"use client";

import { useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { displayName } from "@/lib/displayName";
import type { CallEvent, CallLogDetail, CallLogSummary } from "@/types/agent";

type CallView = "detail" | "events";

export function CallLogsTab({ agentId }: { agentId: string }) {
  const [calls, setCalls] = useState<CallLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [viewByCallId, setViewByCallId] = useState<Record<string, CallView>>({});
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
                  view={viewByCallId[c.id] ?? "detail"}
                  onViewChange={(next) =>
                    setViewByCallId((v) => ({ ...v, [c.id]: next }))
                  }
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
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className="grid w-full cursor-pointer grid-cols-[auto_1.4fr_1fr_auto_auto] items-center gap-4 px-4 py-3 text-left transition hover:bg-(--color-panel-soft) focus:outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent)"
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
    </div>
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
  view,
  onViewChange,
}: {
  agentId: string;
  callId: string;
  detail: CallLogDetail | null;
  loading: boolean;
  view: CallView;
  onViewChange: (v: CallView) => void;
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
  const eventCount = detail.events.length;

  return (
    <div className="animate-fade-in space-y-5 border-t border-(--color-border) bg-(--color-panel-sunken) px-5 py-5">
      <div className="flex w-fit gap-1 rounded-lg border border-(--color-border) bg-(--color-panel-soft) p-1">
        {(
          [
            { id: "detail", label: "Overview" },
            { id: "events", label: `Events${eventCount ? ` (${eventCount})` : ""}` },
          ] as const
        ).map((t) => {
          const selected = view === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onViewChange(t.id)}
              className={`rounded-md px-3 py-1 text-xs transition ${
                selected
                  ? "bg-(--color-panel) font-medium text-(--color-foreground-strong) shadow-sm"
                  : "text-(--color-muted) hover:text-(--color-foreground)"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {view === "events" ? (
        <EventsView events={detail.events} />
      ) : (
      <>
      {dataChips.length > 0 && (
        <section>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Data extraction
          </h4>
          <div className="flex flex-wrap gap-2">
            {dataChips.map((d) => (
              <OutcomeChip
                key={d.name}
                name={d.name}
                value={d.value}
              />
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
              <EvaluationRow
                key={e.name}
                name={e.name}
                passed={e.passed}
                rationale={e.rationale}
              />
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
      </>
      )}
    </div>
  );
}

/**
 * Chronological event log. Tool calls and tool results render as JSON-
 * inspectable cards; messages stay compact. Events are already sorted by
 * upstream emission order on the wire, so we just preserve it.
 */
function EventsView({ events }: { events: CallEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-(--color-border) bg-(--color-panel) px-4 py-6 text-center text-xs text-(--color-muted)">
        No events recorded for this call.
      </div>
    );
  }
  return (
    <ol className="space-y-2">
      {events.map((ev, i) => (
        <EventRow key={i} event={ev} />
      ))}
    </ol>
  );
}

function EventRow({ event }: { event: CallEvent }) {
  const [open, setOpen] = useState(false);
  const ts = `${Math.floor(event.time_in_call_seconds)}s`;

  if (event.kind === "message") {
    const isAgent = event.role === "agent";
    const isSys = event.role === "system";
    return (
      <li className="flex items-start gap-3 rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2">
        <span className="mt-[1px] w-9 shrink-0 font-mono text-[10px] text-(--color-muted-soft)">
          {ts}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider ${
            isSys
              ? "bg-(--color-panel-soft) text-(--color-muted)"
              : isAgent
                ? "bg-(--color-panel-soft) text-(--color-foreground)"
                : "bg-(--color-accent)/15 text-(--color-accent)"
          }`}
        >
          {isSys ? "Sys" : isAgent ? "Agent" : "User"}
        </span>
        <span className="min-w-0 flex-1 text-sm text-(--color-foreground)">
          {event.message}
          {event.interrupted && (
            <span className="ml-2 rounded-full bg-(--color-warning)/15 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-(--color-warning)">
              interrupted
            </span>
          )}
        </span>
      </li>
    );
  }

  if (event.kind === "tool_call") {
    return (
      <li className="rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-start gap-3 text-left"
        >
          <span className="mt-[1px] w-9 shrink-0 font-mono text-[10px] text-(--color-muted-soft)">
            {ts}
          </span>
          <span className="shrink-0 rounded-full bg-(--color-violet-100) px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider text-(--color-violet-700)">
            Tool ▸
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-foreground-strong)">
            {event.tool_name}
          </span>
          {event.tool_type && (
            <span className="rounded bg-(--color-panel-soft) px-1.5 py-[1px] text-[10px] text-(--color-muted)">
              {event.tool_type}
            </span>
          )}
        </button>
        {open && (
          <div className="mt-2 space-y-1 border-t border-(--color-border) pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-(--color-muted)">
              Params
            </div>
            <pre dir="ltr" className="overflow-x-auto rounded bg-(--color-panel-sunken) p-2 font-mono text-[11px] leading-snug text-(--color-foreground)">
              {prettyJson(event.params)}
            </pre>
            {event.request_id && (
              <div className="font-mono text-[10px] text-(--color-muted-soft)">
                request_id: {event.request_id}
              </div>
            )}
          </div>
        )}
      </li>
    );
  }

  // tool_result
  return (
    <li
      className={`rounded-lg border px-3 py-2 ${
        event.is_error
          ? "border-(--color-danger)/40 bg-(--color-danger)/5"
          : "border-(--color-border) bg-(--color-panel)"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 text-left"
      >
        <span className="mt-[1px] w-9 shrink-0 font-mono text-[10px] text-(--color-muted-soft)">
          {ts}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider ${
            event.is_error
              ? "bg-(--color-danger)/15 text-(--color-danger)"
              : "bg-(--color-success)/15 text-(--color-success)"
          }`}
        >
          {event.is_error ? "Error ▸" : "Result ▸"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-foreground)">
          {event.tool_name ?? event.request_id ?? "tool"}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1 border-t border-(--color-border) pt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-(--color-muted)">
            Output
          </div>
          <pre
            dir="ltr"
            className={`overflow-x-auto rounded bg-(--color-panel-sunken) p-2 font-mono text-[11px] leading-snug ${
              event.is_error ? "text-(--color-danger)" : "text-(--color-foreground)"
            }`}
          >
            {prettyJson(event.result)}
          </pre>
          {event.request_id && (
            <div className="font-mono text-[10px] text-(--color-muted-soft)">
              request_id: {event.request_id}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function EvaluationRow({
  name,
  passed,
  rationale,
}: {
  name: string;
  passed: boolean;
  rationale?: string;
}) {
  const criteria = useAgentStore((s) => s.config?.evaluation_criteria);
  const label = useMemo(() => {
    const c = criteria?.find((x) => x.name === name);
    return c ? displayName(c) : name.replace(/_/g, " ");
  }, [name, criteria]);
  return (
    <li className="flex items-start gap-2 text-xs">
      <span
        className={`mt-[1px] inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
          passed
            ? "bg-(--color-success)/15 text-(--color-success)"
            : "bg-(--color-danger)/15 text-(--color-danger)"
        }`}
      >
        {passed ? "✓" : "✕"}
      </span>
      <div className="min-w-0">
        <span className="font-medium text-(--color-foreground)">{label}</span>
        {rationale && (
          <span className="text-(--color-muted)"> — {rationale}</span>
        )}
      </div>
    </li>
  );
}

function OutcomeChip({ name, value }: { name: string; value: unknown }) {
  // Resolve the human label from the agent's configured data_collection.
  // Falls back to a humanised snake_case if the field doesn't have one set
  // (or if the call was recorded before the field was renamed/relabeled).
  const dataFields = useAgentStore((s) => s.config?.data_collection);
  const label = useMemo(() => {
    const field = dataFields?.find((f) => f.name === name);
    return field ? displayName(field) : name.replace(/_/g, " ");
  }, [name, dataFields]);
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
