"use client";

import { useAgentStore } from "@/store/agentStore";

export function OverviewTab() {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  return (
    <div className="space-y-5">
      <Section
        title="Name"
        busy={inFlight.has("name")}
        value={config.name}
      />
      <Section
        title="First message"
        busy={inFlight.has("first_message")}
        value={config.first_message}
      />
      <Section
        title="System prompt"
        busy={inFlight.has("system_prompt")}
        value={config.system_prompt}
        large
      />
    </div>
  );
}

function Section({
  title,
  busy,
  value,
  large,
}: {
  title: string;
  busy: boolean;
  value: string;
  large?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          {title}
        </h3>
        {busy && <span className="text-xs text-(--color-accent)">syncing…</span>}
      </div>
      <p
        className={`whitespace-pre-wrap text-sm leading-relaxed ${
          large ? "" : ""
        }`}
      >
        {value || <span className="text-(--color-muted)">—</span>}
      </p>
    </div>
  );
}
