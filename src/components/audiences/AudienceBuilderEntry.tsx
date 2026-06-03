"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { sendMessage } from "@/store/sseClient";
import { ChatPanel } from "@/components/builder/ChatPanel";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";

const log = createClientLogger("audience-builder-entry");

const EXAMPLES = [
  "CTOs at fintech startups in NYC with a mobile phone.",
  "Sync all my HubSpot contacts tagged as 'lead'.",
  "Senior marketing leaders at SaaS companies with 50–200 employees.",
  "Heads of operations at logistics companies in the EU.",
  "Real-estate brokers in Miami who closed deals this year.",
];

const TYPE_MS = 28;
const ERASE_MS = 14;
const HOLD_MS = 1800;
const GAP_MS = 280;

function useTypingPlaceholder(active: boolean): string {
  const [text, setText] = useState("");
  const phase = useRef<{
    idx: number;
    chars: number;
    mode: "type" | "hold" | "erase" | "gap";
  }>({ idx: 0, chars: 0, mode: "type" });

  useEffect(() => {
    if (!active) return;
    let timer: NodeJS.Timeout | null = null;
    const tick = () => {
      const p = phase.current;
      const target = EXAMPLES[p.idx];
      if (p.mode === "type") {
        if (p.chars < target.length) {
          p.chars += 1;
          setText(target.slice(0, p.chars));
          timer = setTimeout(tick, TYPE_MS);
        } else {
          p.mode = "hold";
          timer = setTimeout(tick, HOLD_MS);
        }
      } else if (p.mode === "hold") {
        p.mode = "erase";
        timer = setTimeout(tick, ERASE_MS);
      } else if (p.mode === "erase") {
        if (p.chars > 0) {
          p.chars -= 1;
          setText(target.slice(0, p.chars));
          timer = setTimeout(tick, ERASE_MS);
        } else {
          p.mode = "gap";
          timer = setTimeout(tick, GAP_MS);
        }
      } else {
        p.idx = (p.idx + 1) % EXAMPLES.length;
        p.mode = "type";
        timer = setTimeout(tick, TYPE_MS);
      }
    };
    timer = setTimeout(tick, TYPE_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active]);

  return text;
}

/**
 * Two-state shell for /audiences/build[/[sessionId]]:
 *   - No sessionId on the URL  → render the hero. Submitting creates a
 *     new chat_session row and redirects to /audiences/build/[id], so
 *     each hero submission starts its own chat thread.
 *   - sessionId present        → render the embedded ChatPanel pointed
 *     at that session. The page hydrates the store from the session's
 *     persisted messages so the chat resumes exactly where it left off.
 */
export function AudienceBuilderEntry({
  agentId,
  sessionId,
}: {
  agentId: string;
  sessionId?: string;
}) {
  if (sessionId) {
    return <ChatPanel agentId={agentId} embedded sessionId={sessionId} />;
  }
  return <AudienceHero agentId={agentId} />;
}

function AudienceHero({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placeholder = useTypingPlaceholder(
    description.length === 0 && !submitting,
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (description.trim().length < 6) {
      setError("Tell me a bit more — at least a sentence.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Create the session first so the message and the URL agree on
      // which chat thread this belongs to from the very first turn.
      const res = await appFetch("/api/audiences/sessions", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Failed to create chat (${res.status})`);
      }
      const { id } = (await res.json()) as { id: string };
      await sendMessage(agentId, description.trim(), { chatSessionId: id });
      router.push(`/audiences/build/${id}`);
    } catch (err) {
      log.error("send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <section
        className="hero-stage"
        style={{ padding: "0", maxWidth: "880px" }}
      >
        <div className="hero-avatar" aria-hidden>
          <Image
            src="/alta-avatar.png"
            alt=""
            width={112}
            height={112}
            priority
          />
        </div>

        <h1 className="hero-title">
          Describe the audience.
          <br />
          <span className="hero-title-soft">Alta finds it.</span>
        </h1>

        <p className="hero-lede">
          Tell me who to reach — I&rsquo;ll search PDL, sync HubSpot, or
          import a CSV. Each chat lives in the sidebar so you can resume
          any of them later.
        </p>

        <form onSubmit={onSubmit} className="hero-form-shell">
          <div className="welcome-box">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void onSubmit(e as unknown as React.FormEvent);
                }
              }}
              placeholder={placeholder || EXAMPLES[0]}
              rows={5}
              disabled={submitting}
            />
            <div className="welcome-box-row">
              <span style={{ flex: 1 }} />
              <button
                type="submit"
                disabled={submitting || description.trim().length < 6}
                className="welcome-btn"
              >
                {submitting ? "Finding…" : "Find it"}
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          </div>
          {error && <div className="welcome-error">{error}</div>}
        </form>
      </section>
    </div>
  );
}

