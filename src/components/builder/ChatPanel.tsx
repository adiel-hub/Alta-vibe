"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { streamChat } from "@/store/sseClient";
import type { ContentBlock } from "@/types/agent";

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

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
      await streamChat(agentId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-(--color-border) px-5 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-(--color-muted)">
          Builder Chat
        </h2>
        <p className="text-xs text-(--color-muted)">
          Tell Claude what to change. The right panel updates as ElevenLabs confirms.
        </p>
      </header>

      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {turns.length === 0 && !streaming && (
          <div className="text-sm text-(--color-muted)">
            Try: <span className="italic">&quot;Change the voice to something calm.&quot;</span>
            <br />
            Or: <span className="italic">&quot;Add https://docs.example.com to the knowledge base.&quot;</span>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView key={turn.id} role={turn.role} content={turn.content} />
        ))}
        {streaming && streaming.text && (
          <TurnView
            role="assistant"
            content={[{ type: "text", text: streaming.text }]}
            streaming
          />
        )}
        {streaming && !streaming.text && (
          <div className="text-xs italic text-(--color-muted)">thinking…</div>
        )}
      </div>

      {error && (
        <div className="border-t border-(--color-danger) bg-(--color-danger)/10 px-5 py-2 text-xs text-(--color-danger)">
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
            className="flex-1 resize-none rounded-xl border border-(--color-border) bg-(--color-panel) px-3 py-2 text-sm outline-none focus:border-(--color-accent)"
          />
          <button
            onClick={send}
            disabled={sending || !input.trim()}
            className="self-end rounded-xl bg-(--color-accent) px-4 py-2 text-sm font-semibold text-(--color-accent-foreground) hover:brightness-110"
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
  streaming,
}: {
  role: "user" | "assistant";
  content: ContentBlock[];
  streaming?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-2xl bg-(--color-accent) px-4 py-2 text-sm text-(--color-accent-foreground)"
            : "max-w-[90%] space-y-2 rounded-2xl bg-(--color-panel) px-4 py-3 text-sm"
        }
      >
        {content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
        {streaming && <span className="inline-block animate-pulse">▍</span>}
      </div>
    </div>
  );
}

function ContentBlockView({ block }: { block: ContentBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap leading-relaxed">{block.text}</div>;
  }
  if (block.type === "tool_use") {
    return (
      <div className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 font-mono text-xs">
        <div className="text-(--color-muted)">→ {block.name}()</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    return (
      <div
        className={`rounded-lg border px-3 py-2 font-mono text-xs ${
          block.is_error
            ? "border-(--color-danger) bg-(--color-danger)/10"
            : "border-(--color-success)/40 bg-(--color-success)/10"
        }`}
      >
        <div className="text-(--color-muted)">{block.is_error ? "✖ error" : "✓ result"}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
          {typeof block.output === "string"
            ? block.output
            : JSON.stringify(block.output, null, 2)}
        </pre>
      </div>
    );
  }
  return null;
}
