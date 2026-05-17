"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import type { CallLogDetail, CallLogSummary } from "@/types/agent";

export function CallLogsTab({ agentId }: { agentId: string }) {
  const [calls, setCalls] = useState<CallLogSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallLogDetail | null>(null);
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
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    appFetch(`/api/agents/${agentId}/calls/${selectedId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`(${r.status})`);
        return (await r.json()) as CallLogDetail;
      })
      .then(setDetail)
      .catch((err) => setError(err instanceof Error ? err.message : "Load failed"))
      .finally(() => setDetailLoading(false));
  }, [selectedId, agentId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          Recent calls
        </h3>
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
        <p className="text-sm text-(--color-muted)">No calls yet.</p>
      ) : (
        <ul className="space-y-2">
          {calls.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm"
            >
              <button
                onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {new Date(c.start_time).toLocaleString()}
                    {c.caller && (
                      <span className="ml-2 font-mono text-xs text-(--color-muted)">
                        {c.caller}
                      </span>
                    )}
                  </p>
                  {c.outcome && (
                    <p className="mt-1 truncate text-xs text-(--color-muted)">
                      {c.outcome}
                    </p>
                  )}
                </div>
                <div className="ml-3 flex flex-col items-end text-xs">
                  <span className="text-(--color-muted)">{c.duration_seconds}s</span>
                  <span
                    className={`mt-1 rounded-full px-2 py-[1px] ${
                      c.call_successful === true
                        ? "bg-(--color-success)/20 text-(--color-success)"
                        : c.call_successful === false
                          ? "bg-(--color-danger)/20 text-(--color-danger)"
                          : "bg-(--color-muted)/20 text-(--color-muted)"
                    }`}
                  >
                    {c.status}
                  </span>
                </div>
              </button>
              {selectedId === c.id && (
                <CallDetailView
                  agentId={agentId}
                  callId={c.id}
                  detail={detail}
                  loading={detailLoading}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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
  if (loading) return <p className="mt-3 text-xs text-(--color-muted)">loading…</p>;
  if (!detail) return null;
  return (
    <div className="mt-3 space-y-3 rounded-lg bg-(--color-panel-soft) p-3">
      {detail.recording_url && (
        <audio
          controls
          src={`/api/agents/${agentId}/calls/${callId}/audio`}
          className="w-full"
        />
      )}
      {detail.analysis.summary && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Summary
          </h4>
          <p className="text-sm">{detail.analysis.summary}</p>
        </div>
      )}
      {detail.analysis.evaluation && detail.analysis.evaluation.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Evaluation
          </h4>
          <ul className="space-y-1">
            {detail.analysis.evaluation.map((e) => (
              <li key={e.name} className="text-xs">
                <span
                  className={e.passed ? "text-(--color-success)" : "text-(--color-danger)"}
                >
                  {e.passed ? "✓" : "✗"}
                </span>{" "}
                <span className="font-medium">{e.name}</span>
                {e.rationale && (
                  <span className="text-(--color-muted)"> — {e.rationale}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.analysis.data_collection && detail.analysis.data_collection.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Collected data
          </h4>
          <ul className="space-y-1 text-xs">
            {detail.analysis.data_collection.map((d) => (
              <li key={d.name}>
                <span className="font-medium">{d.name}:</span>{" "}
                <span className="font-mono">{JSON.stringify(d.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {detail.transcript.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Transcript
          </h4>
          <div className="mt-1 max-h-72 space-y-1 overflow-y-auto text-xs">
            {detail.transcript.map((t, i) => (
              <p key={i}>
                <span
                  className={`mr-2 font-semibold uppercase ${
                    t.role === "agent"
                      ? "text-(--color-accent)"
                      : "text-(--color-foreground)"
                  }`}
                >
                  {t.role}
                </span>
                {t.message}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
