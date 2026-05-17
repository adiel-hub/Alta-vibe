"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "./ChatWidget";
import { LiveToolPill } from "./LiveToolPill";
import { Typewriter } from "./Typewriter";

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
        if (cancelled || !json.active) return;
        setSending(true);
        await attachToTurn(agentId, json.active.id, 0);
      } catch {
        /* swallow */
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
    setInput("");
    setSending(true);
    setError(null);
    try {
      await sendMessage(agentId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-(--color-border) px-5 py-4 animate-fade-in">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-(--color-muted)">
          Alta · Builder chat
        </h2>
        <p className="text-xs text-(--color-muted)">
          Tell Alta what to build. Anything you can do in the panel, you can ask
          for here.
          {activeJobId && (
            <span className="ml-2 inline-flex items-center gap-1 text-(--color-accent)">
              <span className="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-(--color-accent)" />
              working
            </span>
          )}
        </p>
      </header>

      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
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

      <footer className="border-t border-(--color-border) p-4">
        <div className="flex gap-2">
          <textarea
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
            className="flex-1 resize-none rounded-xl border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm outline-none transition-colors focus:border-(--color-accent)"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="self-end rounded-xl bg-(--color-accent) px-4 py-2 text-sm font-semibold text-(--color-accent-foreground) transition hover:brightness-110 active:scale-95"
          >
            {sending ? "…" : "Send"}
          </button>
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
            ? "max-w-[85%] rounded-2xl bg-(--color-accent) px-4 py-2 text-sm text-(--color-accent-foreground) shadow-sm"
            : "max-w-[90%] space-y-2 rounded-2xl bg-(--color-panel) px-4 py-3 text-sm shadow-sm"
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
      <div className="whitespace-pre-wrap leading-relaxed">
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
