"use client";

import { useAgentStore } from "@/store/agentStore";

export function AnalyticsTab() {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Data the agent should collect on every call
          </h3>
          {inFlight.has("data") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        {config.data_collection.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            Ask in chat:{" "}
            <span className="italic">&quot;Extract the order_number and callback_time from every call.&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.data_collection.map((d) => (
              <li
                key={d.id}
                className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2"
              >
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{d.name}</span>
                  <span className="text-xs uppercase text-(--color-muted)">{d.type}</span>
                </div>
                <p className="mt-1 text-xs text-(--color-muted)">{d.description}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Evaluation criteria (scored after each call)
          </h3>
          {inFlight.has("evaluation") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        {config.evaluation_criteria.length === 0 ? (
          <p className="text-sm text-(--color-muted)">
            Ask in chat:{" "}
            <span className="italic">&quot;Score every call on whether the agent verified the caller&apos;s identity.&quot;</span>
          </p>
        ) : (
          <ul className="space-y-2">
            {config.evaluation_criteria.map((c) => (
              <li
                key={c.id}
                className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2"
              >
                <div className="text-sm font-medium">{c.name}</div>
                <p className="mt-1 text-xs text-(--color-muted)">{c.prompt}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
