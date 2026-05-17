"use client";

import { useEffect, useMemo, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import type { AgentConfigCache } from "@/types/agent";

const TTS_MODEL_OPTIONS = [
  { id: "eleven_v3_conversational", label: "Expressive v3" },
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

  const filteredVoices = voiceQuery
    ? voices.filter((v) =>
        v.name.toLowerCase().includes(voiceQuery.toLowerCase()),
      )
    : voices.slice(0, 24);

  const gender = currentVoice?.labels?.gender;
  const accent = currentVoice?.labels?.accent;
  const age = currentVoice?.labels?.age;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6">
      {error && (
        <div className="rounded-lg border border-(--color-danger)/30 bg-(--color-red-50) px-3 py-2 text-xs text-(--color-danger)">
          {error}
        </div>
      )}

      <Section
        title="Voice"
        meta={`${voices.length} available`}
        busy={inFlight.has("voice")}
      >
        <div className="vb-field">
          <div className="vb-field-label flex items-center justify-between">
            <span>Current</span>
            <span className="font-mono text-[10px] tracking-widest text-(--color-muted-soft)">
              {currentVoice ? currentVoice.voice_id : config.voice_id}
            </span>
          </div>
          <div className="vb-preview-line">
            “{config.first_message || "Hi! How can I help today?"}”
          </div>
          <p className="vb-voice-style">
            {currentVoice?.name ?? "—"}
            {gender ? ` · ${gender}` : ""}
            {accent ? ` · ${accent}` : ""}
            {age ? ` · ${age}` : ""}
          </p>
        </div>

        <div className="vb-field">
          <div className="vb-field-label">Browse voices</div>
          <input
            type="text"
            value={voiceQuery}
            onChange={(e) => setVoiceQuery(e.target.value)}
            placeholder="Search voices…"
            className="vb-field-input"
          />
          {voicesError && (
            <p className="vb-field-hint" style={{ color: "var(--color-danger)" }}>
              Voice list error: {voicesError}
            </p>
          )}
          <div className="vb-voices" style={{ marginTop: 10 }}>
            {voicesLoading && (
              <p className="vb-field-hint">Loading voice catalogue…</p>
            )}
            {filteredVoices.map((v) => {
              const on = v.voice_id === config.voice_id;
              return (
                <button
                  key={v.voice_id}
                  type="button"
                  onClick={() => patch({ voice_id: v.voice_id })}
                  className={`vb-voice ${on ? "on" : ""}`}
                >
                  <div className="top">
                    <span className="play" aria-hidden>
                      ▶
                    </span>
                    <span className="nm">{v.name}</span>
                  </div>
                  <div className="wave" aria-hidden>
                    {Array.from({ length: 18 }).map((_, i) => (
                      <span
                        key={i}
                        style={{
                          height: `${4 + ((i * 17) % 11)}px`,
                        }}
                      />
                    ))}
                  </div>
                  <div className="vb-voice-meta">
                    {v.category ?? "premade"}
                    {v.labels?.accent ? ` · ${v.labels.accent}` : ""}
                  </div>
                </button>
              );
            })}
            {!voicesLoading && filteredVoices.length === 0 && (
              <p className="vb-field-hint">No matches.</p>
            )}
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

      <Section title="Model & language" meta="TTS">
        <div className="vb-field-grid">
          <div className="vb-field">
            <div className="vb-field-label">TTS model</div>
            <select
              value={config.tts_model}
              onChange={(e) => patch({ tts_model: e.target.value })}
              className="vb-field-input"
            >
              {TTS_MODEL_OPTIONS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <p className="vb-field-hint">
              Locked to v3 conversational — the most expressive ConvAI model.
            </p>
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
              Drives both transcription and TTS pronunciation.
            </p>
          </div>
        </div>
      </Section>

      <Section title="LLM" meta="reasoning" busy={inFlight.has("llm")}>
        <div className="vb-field-grid">
          <div className="vb-field">
            <div className="vb-field-label">Model</div>
            <input
              type="text"
              defaultValue={config.llm}
              onBlur={(e) =>
                e.target.value !== config.llm &&
                patch({ llm: e.target.value })
              }
              className="vb-field-input font-mono"
            />
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
