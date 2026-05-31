"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { appFetch } from "@/lib/apiClient";
import { displayName } from "@/lib/displayName";
import type { DashboardMetrics } from "@/lib/dashboard/aggregate";

const ACCENT = "#4f46e5";
const SUCCESS = "#6da544";
const MUTED = "#9ca3af";

const RANGES = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
] as const;
type Range = (typeof RANGES)[number]["id"];

export function DashboardTab({ agentId }: { agentId: string }) {
  const [range, setRange] = useState<Range>("7d");
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (r: Range) => {
      setLoading(true);
      setError(null);
      try {
        const res = await appFetch(
          `/api/agents/${agentId}/dashboard?range=${r}`,
        );
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        const json = (await res.json()) as { metrics: DashboardMetrics };
        setMetrics(json.metrics);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    load(range);
  }, [load, range]);

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-(--color-foreground-strong)">
            Dashboard
          </h3>
          <p className="mt-1 text-xs text-(--color-muted)">
            Live snapshot of this agent&rsquo;s configuration and the outcomes of its recent calls.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RangeSwitcher value={range} onChange={setRange} />
          <button
            onClick={() => load(range)}
            className="text-xs text-(--color-muted) hover:text-(--color-foreground)"
          >
            refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      {loading && !metrics ? (
        <DashboardSkeleton />
      ) : metrics ? (
        <>
          <KpiRow metrics={metrics} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="Call volume" subtitle="Calls per day (last window)">
              <VolumeChart data={metrics.volume_by_day} />
            </Card>
            <Card title="Best calling time" subtitle="Connection rate by hour of day">
              <HourChart
                data={metrics.connection_by_hour}
                bestHour={metrics.best_hour}
              />
            </Card>
          </div>
          <Card title="Outcome pass rates" subtitle="Per configured call outcome">
            <OutcomesPanel outcomes={metrics.outcomes} />
          </Card>
          <Card title="Data extraction" subtitle="How often each field was captured">
            <ExtractionPanel extraction={metrics.extraction} />
          </Card>
        </>
      ) : null}
    </div>
  );
}

function RangeSwitcher({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Time range"
      className="inline-flex items-center gap-0.5 rounded-full border border-(--color-border) bg-(--color-panel-soft) p-0.5"
    >
      {RANGES.map((r) => {
        const on = r.id === value;
        return (
          <button
            key={r.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(r.id)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
              on
                ? "bg-(--color-panel) text-(--color-foreground-strong) shadow-sm"
                : "text-(--color-muted) hover:text-(--color-foreground)"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4 shadow-sm">
      <header className="mb-3">
        <h4 className="text-[13px] font-semibold text-(--color-foreground-strong)">
          {title}
        </h4>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-(--color-muted)">{subtitle}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function KpiRow({ metrics }: { metrics: DashboardMetrics }) {
  const { totals } = metrics;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Kpi label="Calls" value={String(totals.calls)} />
      <Kpi label="Avg duration" value={formatDuration(totals.avg_duration_sec)} />
      <Kpi
        label="Connect rate"
        value={`${totals.connect_rate}%`}
        hint={`${totals.connected}/${totals.calls} connected`}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-3 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-(--color-muted)">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-(--color-foreground-strong)">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-(--color-muted)">{hint}</div>}
    </div>
  );
}

function VolumeChart({ data }: { data: DashboardMetrics["volume_by_day"] }) {
  if (data.length === 0) {
    return <NoData />;
  }
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={(d: string) => d.slice(5)}
            tick={{ fontSize: 11, fill: MUTED }}
          />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: MUTED }} />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(v, k) => {
              const n = Number(v);
              return k === "avg_duration_sec"
                ? [formatDuration(n), "Avg duration"]
                : [n, "Calls"];
            }}
          />
          <Line
            type="monotone"
            dataKey="calls"
            stroke={ACCENT}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function HourChart({
  data,
  bestHour,
}: {
  data: DashboardMetrics["connection_by_hour"];
  bestHour: number | null;
}) {
  const hasData = data.some((d) => d.calls > 0);
  if (!hasData) return <NoData />;
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#eee" strokeDasharray="3 3" />
          <XAxis
            dataKey="hour"
            tickFormatter={(h: number) => `${h}`}
            tick={{ fontSize: 11, fill: MUTED }}
          />
          <YAxis
            tickFormatter={(v: number) => `${v}%`}
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: MUTED }}
          />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(v) => [`${Number(v)}%`, "Connect rate"]}
            labelFormatter={(h) => {
              const hour = Number(h);
              return `${formatHour(hour)} · ${data[hour]?.calls ?? 0} calls`;
            }}
          />
          <Bar dataKey="connect_rate" radius={[3, 3, 0, 0]}>
            {data.map((d) => (
              <Cell
                key={d.hour}
                fill={d.hour === bestHour ? SUCCESS : ACCENT}
                fillOpacity={d.calls === 0 ? 0.15 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OutcomesPanel({
  outcomes,
}: {
  outcomes: DashboardMetrics["outcomes"];
}) {
  if (outcomes.length === 0) {
    return (
      <p className="text-xs text-(--color-muted)">
        No call outcomes configured yet. Add some on the Outcomes tab.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
      {outcomes.map((o) => {
        const decided = o.passed + o.failed;
        return (
          <li
            key={o.id}
            className="rounded-xl border border-(--color-border) bg-(--color-panel) p-3 shadow-sm"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-(--color-foreground-strong)">
                  {displayName(o)}
                </div>
                {o.label && (
                  <div className="truncate font-mono text-[10px] text-(--color-muted)">
                    {o.name}
                  </div>
                )}
              </div>
              <span className="shrink-0 text-[11px] text-(--color-muted)">
                {o.passed}✓ · {o.failed}✕ · {o.not_evaluated} n/a
              </span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-(--color-border)">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${decided > 0 ? o.pass_rate : 0}%`,
                    backgroundColor: SUCCESS,
                  }}
                />
              </div>
              <span className="w-12 text-right text-[12px] font-semibold text-(--color-foreground-strong)">
                {decided > 0 ? `${o.pass_rate}%` : "—"}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ExtractionPanel({
  extraction,
}: {
  extraction: DashboardMetrics["extraction"];
}) {
  if (extraction.length === 0) {
    return (
      <p className="text-xs text-(--color-muted)">
        No data-collection fields configured yet. Add some on the Outcomes tab.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
      {extraction.map((f) => (
        <li
          key={f.id}
          className="flex flex-col gap-2 rounded-xl border border-(--color-border) bg-(--color-panel) p-3 shadow-sm"
        >
          <div className="flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-(--color-foreground-strong)">
                  {displayName(f)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-(--color-muted)">
                  {f.type}
                </span>
              </div>
              {f.label && (
                <div className="truncate font-mono text-[10px] text-(--color-muted)">
                  {f.name}
                </div>
              )}
            </div>
            <span className="shrink-0 text-[11px] text-(--color-muted)">
              {f.extracted}/{f.extracted + f.missing} captured
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-(--color-border)">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${f.completion_rate}%`,
                  backgroundColor: ACCENT,
                }}
              />
            </div>
            <span className="w-12 text-right text-[12px] font-semibold text-(--color-foreground-strong)">
              {f.completion_rate}%
            </span>
          </div>
          <ExtractionValues field={f} />
        </li>
      ))}
    </ul>
  );
}

function ExtractionValues({
  field,
}: {
  field: DashboardMetrics["extraction"][number];
}) {
  if (field.top_values.length === 0) return null;
  const maxCount = field.top_values[0]?.count ?? 1;

  if (field.is_bounded) {
    return (
      <div className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2">
        <ul className="flex flex-col gap-1.5">
          {field.top_values.map((v) => (
            <li
              key={v.value}
              className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[11px] text-(--color-foreground)">
                  {v.value}
                </span>
                <div className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-(--color-border)">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(v.count / maxCount) * 100}%`,
                      backgroundColor: ACCENT,
                    }}
                  />
                </div>
              </div>
              <span className="text-right text-[11px] tabular-nums text-(--color-muted)">
                {v.count}
              </span>
            </li>
          ))}
        </ul>
        {field.more_count > 0 && (
          <p className="mt-1.5 text-[10px] text-(--color-muted)">
            + {field.more_count} more
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {field.top_values.map((v) => (
        <span
          key={v.value}
          title={v.value}
          className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-panel-soft) px-2 py-0.5 text-[11px] text-(--color-foreground)"
        >
          <span className="truncate font-mono">{v.value}</span>
          {v.count > 1 && (
            <span className="rounded-full bg-(--color-border) px-1.5 text-[10px] tabular-nums text-(--color-muted)">
              {v.count}
            </span>
          )}
        </span>
      ))}
      {field.more_count > 0 && (
        <span className="text-[10px] text-(--color-muted)">
          + {field.more_count} more
        </span>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl border border-(--color-border) bg-(--color-panel)"
          />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-(--color-border) bg-(--color-panel)" />
      <div className="h-56 animate-pulse rounded-2xl border border-(--color-border) bg-(--color-panel)" />
    </div>
  );
}

function NoData() {
  return (
    <p className="py-6 text-center text-xs text-(--color-muted)">
      Not enough data yet.
    </p>
  );
}

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return "0s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function formatHour(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

