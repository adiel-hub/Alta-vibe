"use client";

import { useEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { Button } from "@/components/ui/Button";
import type { AgentConfigCache } from "@/types/agent";
import { Typewriter } from "../../Typewriter";

/**
 * Persona tab — the "doc page" version of the agent's identity.
 *
 * Renamed from the old Overview tab. Surfaces the three identity fields
 * (agent name, first message, system prompt) in a single editable form
 * that matches the Glow design.
 */
export function OverviewTab({ agentId }: { agentId: string }) {
  const config = useAgentStore((s) => s.config);
  const inFlight = useAgentStore((s) => s.inFlight);
  if (!config) return null;

  return (
    <div className="mx-auto flex min-h-full max-w-[760px] flex-col gap-6">
      <Section title="Greeting" meta="first message" busy={inFlight.has("first_message")}>
        <PersonaField
          agentId={agentId}
          field="first_message"
          label="What the agent says when the call connects"
          value={config.first_message}
          busy={inFlight.has("first_message")}
          multiline
          rows={3}
          placeholder="Hi! How can I help today?"
        />
      </Section>

      <Section
        title="System prompt"
        meta="instruction"
        busy={inFlight.has("system_prompt")}
        grow
      >
        <PersonaField
          agentId={agentId}
          field="system_prompt"
          label="Full instruction set the agent follows"
          value={config.system_prompt}
          busy={inFlight.has("system_prompt")}
          multiline
          rows={14}
          mono
          placeholder="You are a helpful voice agent…"
          fill
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  meta,
  busy,
  grow,
  children,
}: {
  title: string;
  meta?: string;
  busy?: boolean;
  /** Stretch this section to fill the remaining vertical space in its
   *  parent flex column. Used for the System prompt card so it fills the
   *  viewport instead of leaving dead grey area below. */
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        "rounded-2xl border border-(--color-border) bg-(--color-panel) p-5 shadow-[var(--shadow-xs)] " +
        (grow ? "flex min-h-0 flex-1 flex-col" : "")
      }
    >
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
              ALTA EDITING…
            </span>
          )}
        </span>
      </header>
      <div
        className={
          "space-y-1 " + (grow ? "flex min-h-0 flex-1 flex-col" : "")
        }
      >
        {children}
      </div>
    </section>
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
  fill,
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
  /** When true the textarea (and Alta-typing overlay) stretches to fill
   *  the available vertical space. The parent Section must be `grow`. */
  fill?: boolean;
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

  const fillClass = fill ? "flex min-h-0 flex-1 flex-col" : "";

  return (
    <div className={`vb-field ${fillClass}`}>
      <div className="vb-field-label flex items-center gap-3">
        <span>{label}</span>
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
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </span>
      </div>
      <div
        className={`${busy ? "alta-editing" : ""} ${fillClass}`.trim() || undefined}
      >
        {showTypewriter ? (
          // Read-only overlay while we type the new value in. Once the
          // animation finishes, fall through to the regular editable input.
          <div
            dir="auto"
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            } alta-typing-caret ${fill ? "min-h-0 flex-1 overflow-auto" : ""}`}
            style={{
              minHeight:
                !fill && multiline ? `${(rows ?? 4) * 1.5}em` : undefined,
              whiteSpace: "pre-wrap",
              cursor: "default",
            }}
          >
            <Typewriter text={value} live cps={120} />
          </div>
        ) : multiline ? (
          <textarea
            dir="auto"
            value={draft}
            // In `fill` mode the textarea stretches via flex, so `rows`
            // would only force an oversized initial size on first paint.
            rows={fill ? undefined : (rows ?? 4)}
            placeholder={placeholder}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            } ${fill ? "min-h-0 flex-1 resize-none" : ""}`}
          />
        ) : (
          <input
            dir="auto"
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
