"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "./ChatWidget";
import { LiveToolPill } from "./LiveToolPill";
import { Typewriter } from "./Typewriter";

const log = createClientLogger("chat");

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await appFetch(`/api/agents/${agentId}/turns/active`);
        if (!res.ok) return;
        const json = (await res.json()) as { active: { id: string } | null };
        if (cancelled || !json.active) {
          log.debug("no active turn to resume", { agent_id: agentId });
          return;
        }
        log.info("resuming active turn", {
          agent_id: agentId,
          job_id: json.active.id,
        });
        setSending(true);
        await attachToTurn(agentId, json.active.id, 0);
      } catch (err) {
        log.warn("resume failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [turns, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    log.debug("user send", { text_len: text.length });
    setInput("");
    setSending(true);
    setError(null);
    try {
      await sendMessage(agentId, text);
    } catch (err) {
      log.error("send error", {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-(--color-border) px-4 py-3 animate-fade-in">
        <Link
          href="/"
          aria-label="Back to home"
          title="Back to home"
          className="grid h-8 w-8 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
        </Link>
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-(--color-violet-100) text-(--color-violet-600)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2 L13.6 9.5 L21 12 L13.6 14.5 L12 22 L10.4 14.5 L3 12 L10.4 9.5 Z" />
          </svg>
        </span>
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold text-(--color-foreground-strong)">
            Alta
          </span>
          <span className="text-[11px] text-(--color-muted-soft)">
            {activeJobId ? "working…" : "Builder chat"}
          </span>
        </div>
        <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-(--color-violet-100) px-2 py-1 font-mono text-[10px] tracking-widest text-(--color-violet-600)">
          {activeJobId ? "BUILDING" : "READY"}
        </span>
      </header>

      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5 text-(--color-foreground)">
        {turns.length === 0 && !streaming && (
          <div className="space-y-2 text-sm text-(--color-muted) animate-fade-in">
            <p>Try one of:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li className="italic">
                &quot;Sketch a workflow for triaging support calls.&quot;
              </li>
              <li className="italic">
                &quot;Use a calm female voice and slow her down a touch.&quot;
              </li>
              <li className="italic">
                &quot;Crawl https://docs.example.com into the knowledge base.&quot;
              </li>
              <li className="italic">
                &quot;Connect HubSpot so the agent can look up callers.&quot;
              </li>
              <li className="italic">
                &quot;Extract order_number and resolved (boolean) from every call.&quot;
              </li>
            </ul>
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnView
            key={turn.id}
            role={turn.role}
            content={turn.content}
            agentId={agentId}
            // Live-typewriter the final assistant turn while the run is still
            // active; otherwise show fully.
            live={false}
            isLast={i === turns.length - 1}
          />
        ))}
        {streaming && (
          <TurnView
            role="assistant"
            content={[{ type: "text", text: streaming.text || "" }]}
            agentId={agentId}
            live
            isLast
            streamingHint={!streaming.text}
          />
        )}
        {streaming && <LiveToolPill />}
      </div>

      {error && (
        <div className="border-t border-(--color-danger) bg-(--color-danger)/10 px-5 py-2 text-xs text-(--color-danger) animate-fade-in">
          {error}
        </div>
      )}

      <footer className="border-t border-(--color-border) bg-(--color-panel) p-3">
        <div className="rounded-xl border border-(--color-border) bg-(--color-panel) p-2.5 transition focus-within:border-(--color-accent) focus-within:shadow-[0_0_0_3px_rgba(79,70,229,0.08)]">
          <textarea
            dir="auto"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Describe a change…"
            disabled={sending}
            className="w-full resize-none bg-transparent text-sm text-(--color-foreground-strong) outline-none placeholder:text-(--color-muted-soft)"
          />
          <div className="mt-2 flex items-center gap-2 border-t border-(--color-panel-soft) pt-2">
            <span className="ml-auto rounded border border-(--color-border) bg-(--color-panel-soft) px-1.5 py-0.5 font-mono text-[10px] text-(--color-muted-soft)">
              ⏎
            </span>
            <button
              onClick={send}
              disabled={sending || !input.trim()}
              className="grid h-7 w-7 place-items-center rounded-md bg-(--color-accent) text-white transition hover:brightness-110 disabled:bg-(--color-border) disabled:text-(--color-muted-soft)"
              aria-label="Send"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function TurnView({
  role,
  content,
  agentId,
  live,
  isLast,
  streamingHint,
}: {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  agentId?: string;
  live: boolean;
  isLast: boolean;
  streamingHint?: boolean;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";

  // Suppress assistant bubbles whose only content is now-hidden tool blocks
  // (no text, no widget tool_use). Avoids ghost empty bubbles during
  // streaming when the agent's pre-tool text is still in the streaming buffer.
  if (role === "assistant" && !streamingHint) {
    const hasVisible = content.some((b) => {
      if (b.type === "text" && b.text.trim().length > 0) return true;
      if (b.type === "tool_use" && b.name === "mcp__alta__request_user_action")
        return true;
      return false;
    });
    if (!hasVisible) return null;
  }

  if (isSystem) {
    const text = content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex justify-center animate-message-in">
        <div className="rounded-full bg-(--color-panel-soft) px-3 py-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
          {text || "system"}
        </div>
      </div>
    );
  }
  return (
    <div
      className={`animate-message-in ${
        isUser ? "flex justify-end" : "flex justify-start"
      }`}
    >
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl bg-(--color-panel-soft) px-4 py-2 text-sm text-(--color-foreground-strong)"
            : "max-w-[92%] space-y-2 px-1 py-1 text-sm text-(--color-foreground)"
        }
      >
        {streamingHint && (
          <div className="flex items-center gap-1 text-xs italic text-(--color-muted)">
            <span className="dot-flash" />
            <span className="dot-flash" style={{ animationDelay: "120ms" }} />
            <span className="dot-flash" style={{ animationDelay: "240ms" }} />
            <span className="ml-2">thinking</span>
          </div>
        )}
        {content.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            agentId={agentId}
            live={live}
            isLast={isLast && i === content.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function BlockView({
  block,
  agentId,
  live,
  isLast,
}: {
  block: ContentBlock;
  agentId?: string;
  live: boolean;
  isLast: boolean;
}) {
  const widgets = useAgentStore((s) => s.widgets);

  if (block.type === "text") {
    return (
      <div dir="auto" className="whitespace-pre-wrap leading-relaxed">
        <Typewriter text={block.text} live={live && isLast} />
      </div>
    );
  }
  if (block.type === "tool_use") {
    // Only render interactive widgets inline. All other tool_use blocks
    // are suppressed — their progress shows through the LiveToolPill.
    if (block.name === "mcp__alta__request_user_action" && agentId) {
      const input = block.input as { kind?: string; payload?: unknown } | undefined;
      const widget = Object.values(widgets).find(
        (w) =>
          w.kind === input?.kind &&
          JSON.stringify(w.payload) === JSON.stringify(input?.payload),
      );
      if (widget) return <ChatWidget agentId={agentId} widget={widget} />;
    }
    return null;
  }
  if (block.type === "tool_result") {
    return null;
  }
  return null;
}
