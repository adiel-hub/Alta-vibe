"use client";

import { useEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import type { AgentConfigCache } from "@/types/agent";
import { Typewriter } from "../Typewriter";

/**
 * Persona tab — the "doc page" version of the agent's identity.
 *
 * Renamed from the old Overview tab. Surfaces the three identity fields
 * (agent name, first message, system prompt) in a single editable form
 * that matches the Glow design.
 */
export function OverviewTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const description = useAgentStore((s) => s.agent?.description ?? "");
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  const initials = config.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("") || "A";

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-7">
      <div className="rounded-2xl border border-(--color-border) bg-(--color-panel) p-6 shadow-[var(--shadow-xs)]">
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-(--color-violet-500) to-(--color-indigo-600) text-lg font-semibold text-white">
            {initials}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-(--color-foreground-strong)">
              {config.name}
            </h1>
            <p className="mt-1 text-xs uppercase tracking-widest text-(--color-muted-soft)">
              VOICE AGENT · {config.language?.toUpperCase() ?? "EN"} ·{" "}
              {config.llm}
            </p>
            {description && (
              <p className="mt-3 text-[13px] leading-relaxed text-(--color-foreground)">
                {description}
              </p>
            )}
          </div>
        </div>
      </div>

      <PersonaField
        agentId={agentId}
        field="name"
        label="Agent name"
        value={config.name}
        busy={inFlight.has("name")}
        placeholder="e.g. Cedar Hollow Receptionist"
      />

      <PersonaField
        agentId={agentId}
        field="first_message"
        label="First message"
        value={config.first_message}
        multiline
        rows={3}
        busy={inFlight.has("first_message")}
        placeholder="Hi! How can I help today?"
        hint="The first thing the agent says when a call connects."
      />

      <PersonaField
        agentId={agentId}
        field="system_prompt"
        label="System prompt"
        value={config.system_prompt}
        multiline
        rows={14}
        mono
        busy={inFlight.has("system_prompt")}
        placeholder="You are a helpful voice agent…"
        hint="The full instruction set. Use plain English; reference workflow nodes if relevant."
      />
    </div>
  );
}

function PersonaField({
  agentId,
  field,
  label,
  value,
  multiline,
  rows,
  mono,
  busy,
  placeholder,
  hint,
}: {
  agentId: string;
  field: keyof AgentConfigCache;
  label: string;
  value: string;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
  busy?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  const applyConfigDirect = useAgentStore((s) => s.applyConfigDirect);
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track when Alta replaces the value externally so we can play a
  // type-out animation for ~1s before letting the user edit again.
  const [showTypewriter, setShowTypewriter] = useState(false);
  const lastValueRef = useRef(value);
  const typewriterTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);

  // Detect external value change → fire typewriter overlay.
  useEffect(() => {
    if (dirty) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    setShowTypewriter(true);
    if (typewriterTimerRef.current) clearTimeout(typewriterTimerRef.current);
    // Hide the overlay once the animation has had time to finish.
    // Typewriter runs at ~90 cps, so we wait min(1500ms, length/90 * 1000 + 400).
    const ms = Math.min(2400, Math.max(800, (value.length / 90) * 1000 + 400));
    typewriterTimerRef.current = setTimeout(() => setShowTypewriter(false), ms);
    return () => {
      if (typewriterTimerRef.current) clearTimeout(typewriterTimerRef.current);
    };
  }, [value, dirty]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: draft }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Save failed (${res.status})`);
      }
      const json = (await res.json()) as { revision: number };
      applyConfigDirect(
        { [field]: draft } as Partial<AgentConfigCache>,
        json.revision,
      );
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    setDraft(value);
    setDirty(false);
    setError(null);
  };

  return (
    <div className="vb-field">
      <div className="vb-field-label flex items-center gap-3">
        <span>{label}</span>
        {busy && (
          <span className="font-mono text-[10px] tracking-widest text-(--color-violet-600)">
            ALTA EDITING…
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {dirty && (
            <>
              <button
                type="button"
                onClick={revert}
                disabled={saving}
                className="rounded px-2 py-0.5 text-[11px] text-(--color-muted) hover:text-(--color-foreground-strong)"
              >
                Revert
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="rounded bg-(--color-accent) px-2.5 py-0.5 text-[11px] font-semibold text-white hover:brightness-110"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </span>
      </div>
      <div className={busy ? "alta-editing" : undefined}>
        {showTypewriter ? (
          // Read-only overlay while we type the new value in. Once the
          // animation finishes, fall through to the regular editable input.
          <div
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            } alta-typing-caret`}
            style={{
              minHeight: multiline ? `${(rows ?? 4) * 1.5}em` : undefined,
              whiteSpace: "pre-wrap",
              cursor: "default",
            }}
          >
            <Typewriter text={value} live cps={120} />
          </div>
        ) : multiline ? (
          <textarea
            value={draft}
            rows={rows ?? 4}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            }`}
          />
        ) : (
          <input
            type="text"
            value={draft}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            className="vb-field-input"
          />
        )}
      </div>
      {hint && <p className="vb-field-hint">{hint}</p>}
      {error && (
        <p className="vb-field-hint" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
