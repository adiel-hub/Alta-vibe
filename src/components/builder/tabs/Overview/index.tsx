"use client";

import { useEffect, useRef, useState } from "react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { Button } from "@/components/ui/Button";
import type { AgentConfigCache } from "@/types/agent";
import { Typewriter } from "../../Typewriter";
import { MarkdownLiveEditor } from "../../MarkdownLiveEditor";

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
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const firstMessageAuthored = useAgentStore((s) => s.firstMessageAuthored);
  const systemPromptAuthored = useAgentStore((s) => s.systemPromptAuthored);
  if (!config) return null;

  // Each field gates its skeleton on its OWN authored flag so they reveal
  // independently as Alex writes them, instead of waiting for the slowest
  // tool to finish. The motivation is unchanged — until the real value
  // lands, the stored value is the bootstrap default (and for the system
  // prompt, often already mutated by caller-context injection), which
  // would leak template-looking junk to the user.
  const firstMessagePending = activeJobId != null && !firstMessageAuthored;
  const systemPromptPending = activeJobId != null && !systemPromptAuthored;

  return (
    <div className="mx-auto flex h-full max-w-[760px] flex-col gap-6">
      <Section title="Greeting" meta="first message" busy={inFlight.has("first_message")}>
        <PersonaField
          agentId={agentId}
          field="first_message"
          label="What the agent says when the call connects"
          value={config.first_message}
          busy={inFlight.has("first_message")}
          pending={firstMessagePending}
          multiline
          rows={3}
          placeholder="Hi! How can I help today?"
          cps={22}
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
          pending={systemPromptPending}
          multiline
          markdown
          rows={14}
          placeholder="You are a helpful voice agent…"
          fill
          cps={80}
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
  markdown,
  rows,
  mono,
  busy,
  pending,
  placeholder,
  hint,
  fill,
  cps = 60,
}: {
  agentId: string;
  field: keyof AgentConfigCache;
  label: string;
  value: string;
  multiline?: boolean;
  /** Render the idle editor as a live in-place markdown editor (system
   *  prompt) instead of a plain textarea. */
  markdown?: boolean;
  rows?: number;
  mono?: boolean;
  busy?: boolean;
  /** While true, the textarea is hidden behind a skeleton. Used during the
   *  first builder turn before Alta has authored a real value, so the user
   *  never sees the bootstrap/template content flash by. */
  pending?: boolean;
  placeholder?: string;
  hint?: string;
  /** When true the textarea (and Alta-typing overlay) stretches to fill
   *  the available vertical space. The parent Section must be `grow`. */
  fill?: boolean;
  /** Characters-per-second for the read-only reveal animation when Alta
   *  authors or rewrites this field. Greeting uses 22 to match the chat-
   *  header name's deliberate pace; system prompt uses 80 because long
   *  prompts at 22 cps would take 20s+. */
  cps?: number;
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
  // Auto-scroll the read-only streaming/typewriter container so the cursor
  // stays visible as the value grows, instead of leaving new text below the
  // fold of the (now bounded) textarea slot. Run on rAF while typing is
  // active because the Typewriter reveals characters internally — `value`
  // alone isn't enough to drive per-frame scroll updates.
  const streamRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!(busy || showTypewriter)) return;
    let raf = 0;
    const loop = () => {
      const el = streamRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [busy, showTypewriter]);

  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);

  // Detect external value change → fire typewriter overlay.
  //
  // Suppressed while `busy` is true: when the LLM is mid-stream the value is
  // already growing character-by-character via `tool_input_partial` events,
  // so the cosmetic typewriter would just compete with the live update (and
  // its 13× speedup catch-up would race ahead of what's actually streamed).
  // The `busy` branch in the render path shows the live value directly.
  useEffect(() => {
    if (dirty || busy) return;
    if (value === lastValueRef.current) return;
    lastValueRef.current = value;
    setShowTypewriter(true);
    if (typewriterTimerRef.current) clearTimeout(typewriterTimerRef.current);
    // Wait for the typewriter to finish, plus a short tail so the cursor
    // doesn't blink for one frame before the textarea takes over. Cap at
    // 8s so an enormous system prompt doesn't lock the field forever.
    const typingMs = (value.length / cps) * 1000;
    const ms = Math.min(8000, Math.max(800, typingMs + 400));
    typewriterTimerRef.current = setTimeout(() => setShowTypewriter(false), ms);
    return () => {
      if (typewriterTimerRef.current) clearTimeout(typewriterTimerRef.current);
    };
  }, [value, dirty, cps, busy]);

  // While the LLM is streaming this field's value, keep the lastValueRef in
  // lockstep with the live value so that once `busy` flips false we don't
  // immediately re-fire the typewriter for the same content.
  useEffect(() => {
    if (busy) lastValueRef.current = value;
  }, [value, busy]);

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
        {pending ? (
          <PromptSkeleton fill={fill} rows={rows} />
        ) : busy ? (
          // The LLM is actively streaming this field via `tool_input_partial`
          // events. Render the live value directly — no Typewriter, no
          // speedup, no overlay. The text grows naturally as the store
          // updates from successive partials.
          <div
            ref={streamRef}
            dir="auto"
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            } alta-typing-caret ${fill ? "min-h-0 flex-1 overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""}`}
            style={{
              minHeight:
                !fill && multiline ? `${(rows ?? 4) * 1.5}em` : undefined,
              whiteSpace: "pre-wrap",
              cursor: "default",
            }}
          >
            {value}
          </div>
        ) : showTypewriter ? (
          // Read-only overlay while we type the new value in. Once the
          // animation finishes, fall through to the regular editable input.
          <div
            ref={streamRef}
            dir="auto"
            className={`vb-field-input vb-field-textarea ${
              mono ? "vb-field-prompt" : ""
            } alta-typing-caret ${fill ? "min-h-0 flex-1 overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""}`}
            style={{
              minHeight:
                !fill && multiline ? `${(rows ?? 4) * 1.5}em` : undefined,
              whiteSpace: "pre-wrap",
              cursor: "default",
            }}
          >
            <Typewriter text={value} live cps={cps} />
          </div>
        ) : markdown ? (
          // Single in-place editor: the user types raw markdown and sees it
          // formatted live, in the same box. `draft` stays the exact markdown
          // string, so Save round-trips losslessly.
          <MarkdownLiveEditor
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setDirty(true);
            }}
            placeholder={placeholder}
            fill={fill}
            className={`vb-field-input vb-field-textarea ${
              fill
                ? "min-h-0 flex-1 overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                : ""
            }`}
          />
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
            } ${fill ? "min-h-0 flex-1 resize-none [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""}`}
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

/**
 * Shimmer placeholder shown in the system-prompt slot while Alex is still
 * building the agent. A handful of pulsing bars of varying widths read as
 * "lines of an instruction being written" without leaking the bootstrap
 * template that's sitting in the store underneath.
 */
function PromptSkeleton({ fill, rows }: { fill?: boolean; rows?: number }) {
  // Pseudo-random but stable line widths — paragraph-shaped, not uniform.
  const widths = ["92%", "78%", "85%", "60%", "88%", "72%", "95%", "55%", "82%"];
  const lineCount = fill ? 9 : Math.max(3, Math.min(rows ?? 6, 9));
  return (
    <div
      className={`vb-field-input vb-field-textarea ${
        fill ? "min-h-0 flex-1 overflow-hidden" : ""
      }`}
      style={{
        minHeight: !fill ? `${(rows ?? 4) * 1.5}em` : undefined,
        cursor: "default",
      }}
      aria-busy="true"
      aria-label="Alta is writing the system prompt"
    >
      <div className="flex flex-col gap-2.5 py-1">
        {widths.slice(0, lineCount).map((w, i) => (
          <div
            key={i}
            className="h-2.5 animate-pulse rounded-full bg-(--color-border)"
            style={{ width: w, animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
