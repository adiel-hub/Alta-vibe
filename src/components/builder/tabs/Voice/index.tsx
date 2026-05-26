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

const TOTAL_REVEAL_STEPS = 10;
const STEP_MS = 300;

export function VoiceTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  const isFirstBuild = useAgentStore((s) => s.isFirstBuild);
  const voiceRevealToken = useAgentStore((s) => s.voiceRevealToken);
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `voiceBusy` = Alta is actively running a voice-tab tool (list voices,
  // update voice, update settings, update llm, update language, etc.).
  // Used to hold the tab in skeleton state while Alta works, so the user
  // doesn't see the animation play twice when Alta does a read tool
  // followed by an update tool — both register here, the skeleton spans
  // the whole sequence, and the staged reveal fires once when everything
  // settles.
  const voiceBusy =
    inFlight.has("voice") ||
    inFlight.has("llm") ||
    inFlight.has("limits");

  // Local trigger counter for the staged reveal. Bumped (1) once on
  // mount if the agent is brand-new (`isFirstBuild`) and (2) whenever
  // `voiceBusy` goes false after at least one `voiceRevealToken` bump
  // happened during the busy window. The reveal effect below resets
  // `revealStep` to 0 and runs the 10-step tick on every bump.
  const [playToken, setPlayToken] = useState(0);
  const [revealStep, setRevealStep] = useState<number>(TOTAL_REVEAL_STEPS);

  // Per-agent mutable bookkeeping. Recomputed when `agentId` changes so
  // switching agents starts with a clean slate. `useMemo` (not `useRef`)
  // because we need the reset to happen synchronously on agent switch.
  // `forceReveal` is set when we want the upcoming busy-cycle exit to
  // trigger a reveal *regardless* of whether a token bump happened
  // during the cycle — used to bootstrap the first-build animation.
  const stateRef = useMemo(
    () => ({
      bootstrapped: false,
      busyEntryToken: null as number | null,
      forceReveal: false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentId],
  );

  // Bootstrap effect — fires once per agent. First-build agents get a
  // synthetic "busy entry" so the busy effect's exit-debounce path is
  // the single trigger for ALL reveals (first-build + subsequent
  // updates). This way the tick never races with `voiceBusy` toggles.
  useEffect(() => {
    if (stateRef.bootstrapped) return;
    stateRef.bootstrapped = true;
    if (isFirstBuild) {
      console.debug("[voice-anim] bootstrap → synthesize first-build busy entry");
      stateRef.busyEntryToken = voiceRevealToken;
      stateRef.forceReveal = true;
      setRevealStep(0);
    }
  }, [isFirstBuild, voiceRevealToken, stateRef]);

  // Busy-gated reveal trigger. While `voiceBusy` is true the tab stays
  // in skeleton state (revealStep=0). When `voiceBusy` clears, we wait
  // 300ms (so a second voice tool starting right after the first
  // doesn't snap us out of skeleton briefly) and then trigger the
  // reveal if either (a) a patch landed during the busy window (token
  // delta) or (b) `forceReveal` was synthesized at bootstrap (first
  // build). Otherwise we snap back to fully-revealed.
  useEffect(() => {
    if (!stateRef.bootstrapped) return;

    if (voiceBusy && stateRef.busyEntryToken === null) {
      console.debug("[voice-anim] enter busy → skeleton", {
        tokenAtEntry: voiceRevealToken,
      });
      stateRef.busyEntryToken = voiceRevealToken;
      setRevealStep(0);
      return;
    }

    if (!voiceBusy && stateRef.busyEntryToken !== null) {
      const entryToken = stateRef.busyEntryToken;
      const handle = window.setTimeout(() => {
        const wasForced = stateRef.forceReveal;
        stateRef.forceReveal = false;
        stateRef.busyEntryToken = null;
        if (wasForced || voiceRevealToken !== entryToken) {
          console.debug("[voice-anim] busy cleared → reveal", {
            entryToken,
            currentToken: voiceRevealToken,
            wasForced,
          });
          setPlayToken((p) => p + 1);
        } else {
          console.debug("[voice-anim] busy cleared with no change → snap idle");
          setRevealStep(TOTAL_REVEAL_STEPS);
        }
      }, 300);
      return () => window.clearTimeout(handle);
    }
  }, [voiceBusy, voiceRevealToken, stateRef]);

  // The actual staged reveal loop. Runs whenever playToken changes
  // (non-zero). Resets revealStep to 0 and ticks up to TOTAL_REVEAL_STEPS.
  useEffect(() => {
    if (playToken === 0) return;
    console.debug("[voice-anim] reveal START", { playToken });
    setRevealStep(0);
    let cancelled = false;
    let step = 0;
    const tick = () => {
      if (cancelled) return;
      step += 1;
      setRevealStep(step);
      if (step < TOTAL_REVEAL_STEPS) setTimeout(tick, STEP_MS);
      else console.debug("[voice-anim] reveal COMPLETE", { playToken });
    };
    const handle = setTimeout(tick, STEP_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [playToken]);

  console.debug("[voice-anim] VoiceTab RENDER", {
    agentId,
    isFirstBuild,
    voiceBusy,
    voiceRevealToken,
    playToken,
    revealStep,
  });

  // Returns true while field `idx` is in skeleton state. Three signals
  // keep us in skeleton:
  //  - `voiceBusy` — Alta is actively running a voice tool right now
  //  - `stateRef.busyEntryToken !== null` — we're in the 300ms debounce
  //    window after `voiceBusy` cleared (no signal in component state
  //    would otherwise hold the skeleton here, so without this we'd
  //    flash the real values for ~300ms before the tick starts)
  //  - `playToken > 0` AND `revealStep < idx` — staged reveal is mid-tick
  // The ref read is safe: re-renders that happen during this window are
  // already provoked by `voiceBusy`/`revealStep`/`playToken` changes, so
  // we always read a fresh value.
  const isFieldPending = (idx: number): boolean =>
    (voiceBusy ||
      stateRef.busyEntryToken !== null ||
      playToken > 0) &&
    revealStep < idx;
  // True while a reveal tick is in flight and field `idx` has been
  // "unlocked". Signals downstream inputs to play their intro animation
  // (slider/count-up tween, slide-in for everything else). Always false
  // during pure `voiceBusy` (skeleton-only) — intros only fire while
  // values are settling in.
  const wasJustRevealed = (idx: number): boolean =>
    playToken > 0 && revealStep < TOTAL_REVEAL_STEPS && revealStep >= idx;

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
            {isFieldPending(1) ? (
              <InputSkeleton />
            ) : (
              <div
                className={wasJustRevealed(1) ? "animate-message-in" : ""}
              >
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
                    const meta = [cat, gender, accent]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <option key={v.voice_id} value={v.voice_id}>
                        {v.name}
                        {meta ? `  —  ${meta}` : ""}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </div>

          <div className="vb-field">
            <div className="vb-field-label">Language</div>
            {isFieldPending(2) ? (
              <InputSkeleton />
            ) : (
              <select
                value={config.language}
                onChange={(e) => patch({ language: e.target.value })}
                className={`vb-field-input ${
                  wasJustRevealed(2) ? "animate-message-in" : ""
                }`}
              >
                {LANGUAGE_OPTIONS.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <p className="vb-field-hint">
              Drives transcription and TTS pronunciation.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Voice settings" meta="ElevenLabs">
        <div className="vb-field-grid">
          {isFieldPending(3) ? (
            <SliderSkeleton
              label="Stability"
              hint="Low = expressive · High = consistent"
            />
          ) : (
            <SliderField
              label="Stability"
              hint="Low = expressive · High = consistent"
              value={config.voice_settings.stability}
              min={0}
              max={1}
              step={0.05}
              intro={wasJustRevealed(3)}
              onCommit={(v) =>
                patch({
                  voice_settings: { ...config.voice_settings, stability: v },
                })
              }
            />
          )}
          {isFieldPending(4) ? (
            <SliderSkeleton
              label="Similarity"
              hint="How close to the source voice"
            />
          ) : (
            <SliderField
              label="Similarity"
              hint="How close to the source voice"
              value={config.voice_settings.similarity_boost}
              min={0}
              max={1}
              step={0.05}
              intro={wasJustRevealed(4)}
              onCommit={(v) =>
                patch({
                  voice_settings: {
                    ...config.voice_settings,
                    similarity_boost: v,
                  },
                })
              }
            />
          )}
          {isFieldPending(5) ? (
            <SliderSkeleton
              label="Style"
              hint="v3 expressiveness (0 = neutral)"
            />
          ) : (
            <SliderField
              label="Style"
              hint="v3 expressiveness (0 = neutral)"
              value={config.voice_settings.style}
              min={0}
              max={1}
              step={0.05}
              intro={wasJustRevealed(5)}
              onCommit={(v) =>
                patch({
                  voice_settings: { ...config.voice_settings, style: v },
                })
              }
            />
          )}
          {isFieldPending(6) ? (
            <SliderSkeleton label="Speed" hint="0.7 slow … 1.2 fast" />
          ) : (
            <SliderField
              label="Speed"
              hint="0.7 slow … 1.2 fast"
              value={config.voice_settings.speed}
              min={0.7}
              max={1.2}
              step={0.05}
              intro={wasJustRevealed(6)}
              onCommit={(v) =>
                patch({
                  voice_settings: { ...config.voice_settings, speed: v },
                })
              }
            />
          )}
        </div>

        <div className="vb-field">
          <div className="vb-field-label">Speaker boost</div>
          <div className="vb-toggle-row">
            {isFieldPending(7) ? (
              <TogglePillSkeleton />
            ) : (
              <button
                type="button"
                className={`vb-toggle-pill ${
                  config.voice_settings.use_speaker_boost ? "on" : ""
                } ${wasJustRevealed(7) ? "animate-scale-in" : ""}`}
                onClick={() =>
                  patch({
                    voice_settings: {
                      ...config.voice_settings,
                      use_speaker_boost:
                        !config.voice_settings.use_speaker_boost,
                    },
                  })
                }
              >
                {config.voice_settings.use_speaker_boost
                  ? "Enabled"
                  : "Disabled"}
              </button>
            )}
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
            {isFieldPending(8) ? (
              <InputSkeleton />
            ) : (
              <select
                value={config.llm}
                onChange={(e) => patch({ llm: e.target.value })}
                className={`vb-field-input font-mono ${
                  wasJustRevealed(8) ? "animate-message-in" : ""
                }`}
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
            )}
            <p className="vb-field-hint">
              The LLM that drives the agent during calls.
            </p>
          </div>
          {isFieldPending(9) ? (
            <SliderSkeleton
              label="Temperature"
              hint="0 deterministic … 1 creative"
            />
          ) : (
            <SliderField
              label="Temperature"
              hint="0 deterministic … 1 creative"
              value={config.temperature}
              min={0}
              max={1}
              step={0.05}
              intro={wasJustRevealed(9)}
              onCommit={(v) => patch({ temperature: v })}
            />
          )}
        </div>
      </Section>

      <Section title="Limits" meta="runtime" busy={inFlight.has("limits")}>
        <div className="vb-field">
          <div className="vb-field-label">Max call duration</div>
          <div className="flex items-center gap-2">
            {isFieldPending(10) ? (
              <InputSkeleton width={120} />
            ) : (
              <CountUpInput
                value={config.max_duration_seconds}
                min={30}
                max={7200}
                onCommit={(v) => patch({ max_duration_seconds: v })}
                intro={wasJustRevealed(10)}
              />
            )}
            <span className="vb-field-hint">seconds</span>
          </div>
        </div>
      </Section>
    </div>
  );
}

/**
 * Skeleton shapes shown while Alta is mid-build — keeping labels visible
 * so the user can still scan the page, but replacing each input with a
 * pulsing bar of the right shape so default values don't read as the
 * user's choice.
 */
/**
 * Number input that counts up from `min` → `value` on first mount when
 * `intro` is true (the first-build animation). After the intro completes
 * it behaves like a normal blur-to-commit number input.
 */
function CountUpInput({
  value,
  min,
  max,
  onCommit,
  intro,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  intro?: boolean;
}) {
  const [display, setDisplay] = useState<number>(intro ? min : value);
  const [editing, setEditing] = useState(false);

  // Intro tween: count from `min` → `value` whenever `intro` flips
  // true. Same model as SliderField above — pairs with the parent's
  // staged reveal: each playToken bump remounts the input with
  // intro=true and we count up from the bottom of the range.
  useEffect(() => {
    if (!intro) {
      setDisplay(value);
      return;
    }
    const from = min;
    const to = value;
    if (from === to) return;
    const duration = 700;
    const start = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // Run once per intro flip. value/min are read inside via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro]);

  // Sync external value changes (Alta patches, user saves) when not mid-edit.
  useEffect(() => {
    if (intro || editing) return;
    setDisplay(value);
  }, [value, intro, editing]);

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={display}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDisplay(Number(e.target.value))}
      onBlur={(e) => {
        setEditing(false);
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v !== value) onCommit(v);
      }}
      className={`vb-field-input ${intro ? "animate-message-in" : ""}`}
      style={{ width: 120 }}
    />
  );
}

function InputSkeleton({ width }: { width?: number }) {
  return (
    <div
      className="h-9 animate-pulse rounded-md bg-(--color-border)"
      style={width ? { width } : undefined}
      aria-busy="true"
    />
  );
}

function SliderSkeleton({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="vb-field">
      <div className="vb-field-label vb-slider-row">
        <span>{label}</span>
        <span
          className="inline-block h-3 w-8 animate-pulse rounded bg-(--color-border)"
          aria-hidden
        />
      </div>
      <div className="vb-slider">
        <div className="vb-slider-track">
          <div
            className="h-full w-1/3 animate-pulse rounded-full bg-(--color-border)"
            aria-hidden
          />
        </div>
      </div>
      {hint && <p className="vb-field-hint">{hint}</p>}
    </div>
  );
}

function TogglePillSkeleton() {
  return (
    <div
      className="h-7 w-20 animate-pulse rounded-full bg-(--color-border)"
      aria-busy="true"
    />
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
  intro,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  /** When true on mount, tween the visible knob/fill from `min` to `value`
   *  over ~700ms with an ease-out curve so the slider looks like it's being
   *  set in real time. Subsequent value changes (user drag, Alta patches)
   *  snap normally. */
  intro?: boolean;
}) {
  const [local, setLocal] = useState(intro ? min : value);
  // Hold the displayed value during the intro tween; `local` is the source
  // of truth, but the tween writes to it directly so this state is just an
  // alias for `local` here. Kept separate to make the reset-on-prop-change
  // semantics easy to reason about.
  useEffect(() => {
    if (intro) return;
    setLocal(value);
  }, [value, intro]);
  // Intro tween: animate from `min` → `value` whenever `intro` flips
  // true. Pairs with the parent's staged staggered reveal — on each
  // playToken bump the slider is briefly skeleton'd then re-mounts
  // with intro=true, so this tween fires from the bottom of the range
  // up to the current value and reads as "the knob is being set".
  useEffect(() => {
    if (!intro) return;
    const from = min;
    const to = value;
    if (from === to) return;
    const duration = 700;
    const start = performance.now();
    let rafId = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setLocal(from + (to - from) * eased);
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // Intent: run once per intro flip. value/min are read inside via
    // closure. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intro]);
  const pct = ((local - min) / (max - min)) * 100;
  return (
    <div className={`vb-field ${intro ? "animate-message-in" : ""}`}>
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
