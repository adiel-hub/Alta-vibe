"use client";

import { useAgentStore } from "@/store/agentStore";

export function VoiceTab() {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const errors = useAgentStore((s) => s.errors);
  if (!config) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
            Voice
          </h3>
          {inFlight.has("voice") && (
            <span className="text-xs text-(--color-accent)">syncing…</span>
          )}
        </div>
        <p className="font-mono text-sm">{config.voice_id}</p>
        {errors.voice && (
          <p className="mt-2 text-xs text-(--color-danger)">{errors.voice}</p>
        )}
      </div>
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          LLM
        </h3>
        <div className="flex justify-between text-sm">
          <span className="font-mono">{config.llm}</span>
          <span className="text-(--color-muted)">temp {config.temperature}</span>
        </div>
        {inFlight.has("llm") && (
          <p className="mt-2 text-xs text-(--color-accent)">syncing…</p>
        )}
      </div>
    </div>
  );
}
