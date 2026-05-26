/**
 * Pure aggregation of call summaries + details into the metrics the Dashboard
 * tab renders. Keeping this isolated from any I/O makes it trivial to unit
 * test and lets the API route stay a thin orchestrator.
 */
import type {
  CallLogDetail,
  CallLogSummary,
  DataCollectionFieldType,
} from "@/types/agent";

export type DashboardMetrics = {
  totals: {
    calls: number;
    avg_duration_sec: number;
    total_duration_sec: number;
    connected: number;
    connect_rate: number;
  };
  volume_by_day: {
    date: string;
    calls: number;
    avg_duration_sec: number;
  }[];
  outcomes: {
    id: string;
    name: string;
    label?: string;
    passed: number;
    failed: number;
    not_evaluated: number;
    pass_rate: number;
  }[];
  extraction: {
    id: string;
    name: string;
    label?: string;
    type: DataCollectionFieldType;
    /** True when the field has an `enum` constraint configured — the UI
     *  uses this to switch between distribution-bar and chip-list rendering. */
    is_bounded: boolean;
    extracted: number;
    missing: number;
    completion_rate: number;
    top_values: { value: string; count: number }[];
    more_count: number;
  }[];
  connection_by_hour: {
    hour: number;
    calls: number;
    connected: number;
    connect_rate: number;
  }[];
  best_hour: number | null;
  window: { from: string | null; to: string | null; sample_size: number };
};

// A call is "connected" if it lasted long enough to be a real conversation
// (not a missed ring or instant hangup) and the status isn't an explicit
// failure. ElevenLabs doesn't expose a clean "answered" flag, so this
// heuristic is the best signal we have for time-of-day connection analysis.
const CONNECTED_MIN_SECONDS = 30;
function isConnected(call: Pick<CallLogSummary, "duration_seconds" | "status">): boolean {
  if (call.duration_seconds < CONNECTED_MIN_SECONDS) return false;
  const s = (call.status ?? "").toLowerCase();
  if (s.includes("failed") || s.includes("error")) return false;
  return true;
}

// Hour-of-day bucket is computed in the caller's local time so "best hour"
// matches their wall clock. start_time is an ISO string in UTC.
function hourOfDay(iso: string): number {
  return new Date(iso).getHours();
}

function isoDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function pct(n: number, d: number): number {
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10; // one decimal
}

export type AggregateInputs = {
  summaries: CallLogSummary[];
  details: CallLogDetail[];
  outcomeCriteria: { id: string; name: string; label?: string }[];
  dataFields: {
    id: string;
    name: string;
    label?: string;
    type: DataCollectionFieldType;
    enum?: string[];
  }[];
};

const TOP_VALUES_N = 8;

function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function aggregate(input: AggregateInputs): DashboardMetrics {
  const { summaries, details, outcomeCriteria, dataFields } = input;

  const totalCalls = summaries.length;
  const totalDuration = summaries.reduce((s, c) => s + (c.duration_seconds ?? 0), 0);
  const connectedCalls = summaries.filter(isConnected).length;

  // Volume by day
  const byDay = new Map<string, { calls: number; duration: number }>();
  for (const c of summaries) {
    const key = isoDate(c.start_time);
    const cur = byDay.get(key) ?? { calls: 0, duration: 0 };
    cur.calls += 1;
    cur.duration += c.duration_seconds ?? 0;
    byDay.set(key, cur);
  }
  const volume_by_day = Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, v]) => ({
      date,
      calls: v.calls,
      avg_duration_sec: v.calls > 0 ? Math.round(v.duration / v.calls) : 0,
    }));

  // Outcomes — name-keyed because ElevenLabs returns the criterion name, not id.
  // We line up each configured criterion against the detail.analysis.evaluation
  // rows by exact name match.
  const outcomes = outcomeCriteria.map((crit) => {
    let passed = 0;
    let failed = 0;
    let not_evaluated = 0;
    for (const d of details) {
      const ev = d.analysis?.evaluation?.find((e) => e.name === crit.name);
      if (!ev) {
        not_evaluated += 1;
        continue;
      }
      if (ev.passed) passed += 1;
      else failed += 1;
    }
    const decided = passed + failed;
    return {
      id: crit.id,
      name: crit.name,
      ...(crit.label ? { label: crit.label } : {}),
      passed,
      failed,
      not_evaluated,
      pass_rate: pct(passed, decided),
    };
  });

  // Data extraction — same name-keyed lineup. A field is "extracted" if the
  // upstream returned a non-null, non-empty value for it. We also tally the
  // distinct values so the UI can show the actual data, not just a rate.
  const extraction = dataFields.map((field) => {
    let extracted = 0;
    let missing = 0;
    const counts = new Map<string, number>();
    for (const d of details) {
      const row = d.analysis?.data_collection?.find((x) => x.name === field.name);
      const raw = row?.value;
      if (raw === null || raw === undefined || raw === "") {
        missing += 1;
        continue;
      }
      extracted += 1;
      const key = stringifyValue(raw);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
    const top_values = sorted.slice(0, TOP_VALUES_N);
    const more_count = sorted
      .slice(TOP_VALUES_N)
      .reduce((s, v) => s + v.count, 0);
    const is_bounded =
      (field.enum?.length ?? 0) > 0 || field.type === "boolean";
    return {
      id: field.id,
      name: field.name,
      ...(field.label ? { label: field.label } : {}),
      type: field.type,
      is_bounded,
      extracted,
      missing,
      completion_rate: pct(extracted, extracted + missing),
      top_values,
      more_count,
    };
  });

  // Hour-of-day connection rate. Fill all 24 buckets so the chart x-axis is
  // continuous even on sparse data.
  const hourBuckets: { calls: number; connected: number }[] = Array.from(
    { length: 24 },
    () => ({ calls: 0, connected: 0 }),
  );
  for (const c of summaries) {
    const h = hourOfDay(c.start_time);
    hourBuckets[h].calls += 1;
    if (isConnected(c)) hourBuckets[h].connected += 1;
  }
  const connection_by_hour = hourBuckets.map((b, hour) => ({
    hour,
    calls: b.calls,
    connected: b.connected,
    connect_rate: pct(b.connected, b.calls),
  }));

  // Require a minimum sample size before crowning a winning hour — otherwise
  // a single connected call at 3am claims the trophy on a fresh agent.
  const MIN_SAMPLES = 3;
  let best_hour: number | null = null;
  let bestRate = -1;
  for (const b of connection_by_hour) {
    if (b.calls < MIN_SAMPLES) continue;
    if (b.connect_rate > bestRate) {
      bestRate = b.connect_rate;
      best_hour = b.hour;
    }
  }

  const sorted = [...summaries].sort((a, b) =>
    a.start_time < b.start_time ? -1 : 1,
  );
  const window = {
    from: sorted[0]?.start_time ?? null,
    to: sorted[sorted.length - 1]?.start_time ?? null,
    sample_size: totalCalls,
  };

  return {
    totals: {
      calls: totalCalls,
      avg_duration_sec: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
      total_duration_sec: totalDuration,
      connected: connectedCalls,
      connect_rate: pct(connectedCalls, totalCalls),
    },
    volume_by_day,
    outcomes,
    extraction,
    connection_by_hour,
    best_hour,
    window,
  };
}
