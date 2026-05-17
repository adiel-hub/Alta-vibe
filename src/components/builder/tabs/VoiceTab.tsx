"use client";

import { useEffect, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import type { AgentConfigCache, VoiceSettings } from "@/types/agent";

const TTS_MODEL_OPTIONS = [
  { id: "eleven_v3", label: "Expressive v3 (most natural)" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5 (low latency)" },
  { id: "eleven_flash_v2_5", label: "Flash v2.5 (fastest)" },
];

const LANGUAGE_OPTIONS = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["ko", "Korean"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["sv", "Swedish"],
  ["tr", "Turkish"],
] as const;

type Voice = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
};

export function VoiceTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceQuery, setVoiceQuery] = useState("");
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setVoicesLoading(true);
    appFetch(`/api/voices`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`(${r.status})`);
        const j = (await r.json()) as { voices: Voice[] };
        setVoices(j.voices);
      })
      .catch((e) => setVoicesError(e instanceof Error ? e.message : "load failed"))
      .finally(() => setVoicesLoading(false));
  }, []);

  if (!config) return null;

  const patch = async (data: Partial<AgentConfigCache>) => {
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as { revision: number };
      applyConfigDirect(data, json.revision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  const filteredVoices = voiceQuery
    ? voices.filter((v) =>
        v.name.toLowerCase().includes(voiceQuery.toLowerCase()),
      )
    : voices.slice(0, 40);

  const currentVoice = voices.find((v) => v.voice_id === config.voice_id);

  return (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg border border-(--color-danger) bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      <Section title="Voice" busy={inFlight.has("voice")}>
        <p className="text-sm">
          {currentVoice ? (
            <>
              <span className="font-medium">{currentVoice.name}</span>
              {currentVoice.category && (
                <span className="ml-2 text-xs text-(--color-muted)">
                  · {currentVoice.category}
                </span>
              )}
            </>
          ) : (
            <span className="font-mono text-xs">{config.voice_id}</span>
          )}
        </p>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={voiceQuery}
            onChange={(e) => setVoiceQuery(e.target.value)}
            placeholder="Search voices…"
            className="w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
          />
          {voicesError && (
            <p className="text-xs text-(--color-danger)">Voice list error: {voicesError}</p>
          )}
          <div className="max-h-56 overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-panel-soft)">
            {voicesLoading && (
              <p className="px-3 py-2 text-xs text-(--color-muted)">loading…</p>
            )}
            {filteredVoices.map((v) => (
              <button
                key={v.voice_id}
                onClick={() => patch({ voice_id: v.voice_id })}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition hover:bg-(--color-panel) ${
                  v.voice_id === config.voice_id ? "bg-(--color-accent)/15" : ""
                }`}
              >
                <span>{v.name}</span>
                <span className="text-xs text-(--color-muted)">{v.category}</span>
              </button>
            ))}
            {!voicesLoading && filteredVoices.length === 0 && (
              <p className="px-3 py-2 text-xs text-(--color-muted)">No matches.</p>
            )}
          </div>
        </div>
      </Section>

      <Section title="Voice settings">
        <Slider
          label="Stability"
          hint="Low = expressive, High = consistent"
          value={config.voice_settings.stability}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) =>
            patch({ voice_settings: { ...config.voice_settings, stability: v } })
          }
        />
        <Slider
          label="Similarity boost"
          hint="How close to the source voice"
          value={config.voice_settings.similarity_boost}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) =>
            patch({
              voice_settings: { ...config.voice_settings, similarity_boost: v },
            })
          }
        />
        <Slider
          label="Style"
          hint="v3 expressiveness (0 = neutral)"
          value={config.voice_settings.style}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) =>
            patch({ voice_settings: { ...config.voice_settings, style: v } })
          }
        />
        <Slider
          label="Speed"
          hint="0.7 slow … 1.2 fast"
          value={config.voice_settings.speed}
          min={0.7}
          max={1.2}
          step={0.05}
          onCommit={(v) =>
            patch({ voice_settings: { ...config.voice_settings, speed: v } })
          }
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.voice_settings.use_speaker_boost}
            onChange={(e) =>
              patch({
                voice_settings: {
                  ...config.voice_settings,
                  use_speaker_boost: e.target.checked,
                },
              })
            }
          />
          Speaker boost
        </label>
      </Section>

      <Section title="Model & language">
        <label className="block text-xs uppercase tracking-wider text-(--color-muted)">
          TTS model
        </label>
        <select
          value={config.tts_model}
          onChange={(e) => patch({ tts_model: e.target.value })}
          className="mt-1 w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
        >
          {TTS_MODEL_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>

        <label className="mt-4 block text-xs uppercase tracking-wider text-(--color-muted)">
          Language
        </label>
        <select
          value={config.language}
          onChange={(e) => patch({ language: e.target.value })}
          className="mt-1 w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
        >
          {LANGUAGE_OPTIONS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </Section>

      <Section title="LLM" busy={inFlight.has("llm")}>
        <label className="block text-xs uppercase tracking-wider text-(--color-muted)">
          Model
        </label>
        <input
          type="text"
          defaultValue={config.llm}
          onBlur={(e) =>
            e.target.value !== config.llm && patch({ llm: e.target.value })
          }
          className="mt-1 w-full rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm font-mono"
        />
        <Slider
          label="Temperature"
          hint="0 deterministic … 1 creative"
          value={config.temperature}
          min={0}
          max={1}
          step={0.05}
          onCommit={(v) => patch({ temperature: v })}
        />
      </Section>

      <Section title="Limits" busy={inFlight.has("limits")}>
        <label className="block text-xs uppercase tracking-wider text-(--color-muted)">
          Max call duration (seconds)
        </label>
        <input
          type="number"
          min={30}
          max={7200}
          defaultValue={config.max_duration_seconds}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v !== config.max_duration_seconds)
              patch({ max_duration_seconds: v });
          }}
          className="mt-1 w-32 rounded-xl border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 text-sm"
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  busy,
  children,
}: {
  title: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-2xl border border-(--color-border) bg-(--color-panel) p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-(--color-muted)">
          {title}
        </h3>
        {busy && <span className="text-xs text-(--color-accent)">syncing…</span>}
      </div>
      {children}
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-(--color-muted)">{label}</span>
        <span className="font-mono">{local.toFixed(2)}</span>
      </div>
      {hint && <p className="text-[10px] text-(--color-muted)">{hint}</p>}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        className="mt-1 w-full accent-(--color-accent)"
      />
    </div>
  );
}
