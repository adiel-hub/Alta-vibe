"use client";

import { useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import type { AgentConfigCache } from "@/types/agent";

const LLM_OPTIONS = {
  Gemini: [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  OpenAI: [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  Anthropic: [
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-haiku",
  ],
  Other: ["grok-beta", "custom-llm"],
};

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
  ["he", "Hebrew"],
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
      .catch((e) =>
        setVoicesError(e instanceof Error ? e.message : "load failed"),
      )
      .finally(() => setVoicesLoading(false));
  }, []);

  const currentVoice = useMemo(
    () => voices.find((v) => v.voice_id === config?.voice_id),
    [voices, config?.voice_id],
  );

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
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as { revision: number };
      applyConfigDirect(data, json.revision);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6">
      {error && (
        <div className="rounded-lg border border-(--color-danger)/30 bg-(--color-red-50) px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      <Section
        title="Voice"
        meta={`${voices.length} available · ASR + TTS`}
        busy={inFlight.has("voice")}
      >
        <div className="vb-field-grid">
          <div className="vb-field">
            <div className="vb-field-label">Voice</div>
            {voicesError && (
              <p
                className="vb-field-hint"
                style={{ color: "var(--color-danger)" }}
              >
                Voice list error: {voicesError}
              </p>
            )}
            <select
              value={config.voice_id}
              disabled={voicesLoading || voices.length === 0}
              onChange={(e) => patch({ voice_id: e.target.value })}
              className="vb-field-input font-medium"
            >
              {voicesLoading && <option value="">Loading voices…</option>}
              {!voicesLoading && !currentVoice && (
                <option value={config.voice_id}>
                  {config.voice_id || "(unset)"}
                </option>
              )}
              {voices.map((v) => {
                const accent = v.labels?.accent;
                const gender = v.labels?.gender;
                const cat = v.category ?? "premade";
                const meta = [cat, gender, accent].filter(Boolean).join(" · ");
                return (
                  <option key={v.voice_id} value={v.voice_id}>
                    {v.name}
                    {meta ? `  —  ${meta}` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="vb-field">
            <div className="vb-field-label">Language</div>
            <select
              value={config.language}
              onChange={(e) => patch({ language: e.target.value })}
              className="vb-field-input"
            >
              {LANGUAGE_OPTIONS.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <p className="vb-field-hint">
              Drives transcription and TTS pronunciation.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Voice settings" meta="ElevenLabs">
        <div className="vb-field-grid">
          <SliderField
            label="Stability"
            hint="Low = expressive · High = consistent"
            value={config.voice_settings.stability}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) =>
              patch({
                voice_settings: { ...config.voice_settings, stability: v },
              })
            }
          />
          <SliderField
            label="Similarity"
            hint="How close to the source voice"
            value={config.voice_settings.similarity_boost}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) =>
              patch({
                voice_settings: {
                  ...config.voice_settings,
                  similarity_boost: v,
                },
              })
            }
          />
          <SliderField
            label="Style"
            hint="v3 expressiveness (0 = neutral)"
            value={config.voice_settings.style}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) =>
              patch({
                voice_settings: { ...config.voice_settings, style: v },
              })
            }
          />
          <SliderField
            label="Speed"
            hint="0.7 slow … 1.2 fast"
            value={config.voice_settings.speed}
            min={0.7}
            max={1.2}
            step={0.05}
            onCommit={(v) =>
              patch({
                voice_settings: { ...config.voice_settings, speed: v },
              })
            }
          />
        </div>

        <div className="vb-field">
          <div className="vb-field-label">Speaker boost</div>
          <div className="vb-toggle-row">
            <button
              type="button"
              className={`vb-toggle-pill ${
                config.voice_settings.use_speaker_boost ? "on" : ""
              }`}
              onClick={() =>
                patch({
                  voice_settings: {
                    ...config.voice_settings,
                    use_speaker_boost: !config.voice_settings.use_speaker_boost,
                  },
                })
              }
            >
              {config.voice_settings.use_speaker_boost ? "Enabled" : "Disabled"}
            </button>
            <span className="vb-field-hint">
              Emphasises the selected voice over the source mix. Slight latency
              cost.
            </span>
          </div>
        </div>
      </Section>

      <Section title="LLM" meta="reasoning" busy={inFlight.has("llm")}>
        <div className="vb-field-grid">
          <div className="vb-field">
            <div className="vb-field-label">Model</div>
            <select
              value={config.llm}
              onChange={(e) => patch({ llm: e.target.value })}
              className="vb-field-input font-mono"
            >
              {!Object.values(LLM_OPTIONS)
                .flat()
                .includes(config.llm) && (
                <option value={config.llm}>{config.llm}</option>
              )}
              {Object.entries(LLM_OPTIONS).map(([group, models]) => (
                <optgroup key={group} label={group}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="vb-field-hint">
              The LLM that drives the agent during calls.
            </p>
          </div>
          <SliderField
            label="Temperature"
            hint="0 deterministic … 1 creative"
            value={config.temperature}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) => patch({ temperature: v })}
          />
        </div>
      </Section>

      <Section title="Limits" meta="runtime" busy={inFlight.has("limits")}>
        <div className="vb-field">
          <div className="vb-field-label">Max call duration</div>
          <div className="flex items-center gap-2">
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
              className="vb-field-input"
              style={{ width: 120 }}
            />
            <span className="vb-field-hint">seconds</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  meta,
  busy,
  children,
}: {
  title: string;
  meta?: string;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-5 shadow-[var(--shadow-xs)]">
      <header className="mb-3 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-(--color-foreground-strong)">
          {title}
        </h3>
        {meta && (
          <span className="font-mono text-[10px] tracking-widest text-(--color-muted-soft)">
            · {meta.toUpperCase()}
          </span>
        )}
        <span className="ml-auto">
          {busy && (
            <span className="font-mono text-[10px] tracking-widest text-(--color-violet-600)">
              SYNCING…
            </span>
          )}
        </span>
      </header>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SliderField({
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
  const pct = ((local - min) / (max - min)) * 100;
  return (
    <div className="vb-field">
      <div className="vb-field-label vb-slider-row">
        <span>{label}</span>
        <span className="vb-slider-val">{local.toFixed(2)}</span>
      </div>
      <div className="vb-slider">
        <div className="vb-slider-track">
          <div className="vb-slider-fill" style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={local}
          onChange={(e) => setLocal(Number(e.target.value))}
          onMouseUp={() => onCommit(local)}
          onTouchEnd={() => onCommit(local)}
          onKeyUp={() => onCommit(local)}
        />
      </div>
      {hint && <p className="vb-field-hint">{hint}</p>}
    </div>
  );
}
