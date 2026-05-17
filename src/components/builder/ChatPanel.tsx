"use client";

import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "./ChatWidget";

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Resume in-progress turn after page refresh.
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
        // swallow; user can send a new message
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
      <header className="border-b border-(--color-border) px-5 py-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-(--color-muted)">
          Alta · Builder chat
        </h2>
        <p className="text-xs text-(--color-muted)">
          Tell Alta what to build. Anything you can do in the panel, you can ask for here.
          {activeJobId && (
            <span className="ml-2 text-(--color-accent)">working…</span>
          )}
        </p>
      </header>

      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
        {turns.length === 0 && !streaming && (
          <div className="text-sm text-(--color-muted) space-y-1">
            <p>Try one of:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li className="italic">&quot;Use a calm female voice and slow her down a bit.&quot;</li>
              <li className="italic">&quot;Crawl https://docs.example.com (limit 12) into the knowledge base.&quot;</li>
              <li className="italic">&quot;Create an in-call tool that looks up an order by id via POST to https://api.example.com/orders/lookup.&quot;</li>
              <li className="italic">&quot;Extract order_number and resolved (boolean) from every call.&quot;</li>
              <li className="italic">&quot;Place an outbound test call to +1 555-123-4567.&quot;</li>
            </ul>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            role={turn.role}
            content={turn.content}
            agentId={agentId}
          />
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
  agentId,
}: {
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  streaming?: boolean;
  agentId?: string;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";
  if (isSystem) {
    const text = content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join(" ");
    return (
      <div className="flex justify-center">
        <div className="rounded-full bg-(--color-panel-soft) px-3 py-1 text-[10px] uppercase tracking-wider text-(--color-muted)">
          {text || "system"}
        </div>
      </div>
    );
  }
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
          <ContentBlockView key={i} block={block} agentId={agentId} />
        ))}
        {streaming && <span className="inline-block animate-pulse">▍</span>}
      </div>
    </div>
  );
}

function ContentBlockView({
  block,
  agentId,
}: {
  block: ContentBlock;
  agentId?: string;
}) {
  const widgets = useAgentStore((s) => s.widgets);
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap leading-relaxed">{block.text}</div>;
  }
  if (block.type === "tool_use") {
    // Interactive widget rendering: when the agent calls request_user_action,
    // show the matching interactive widget instead of raw tool_use JSON.
    if (block.name === "mcp__alta__request_user_action" && agentId) {
      const input = block.input as { kind?: string; payload?: unknown } | undefined;
      // Find the widget by scanning all widgets for one whose kind matches
      // and whose payload was emitted around this tool call. The
      // widget_inserted event carries the canonical action_id; we match on
      // kind+payload as a best-effort fallback if event arrived first.
      const widget = Object.values(widgets).find(
        (w) =>
          w.kind === input?.kind &&
          JSON.stringify(w.payload) === JSON.stringify(input?.payload),
      );
      if (widget) return <ChatWidget agentId={agentId} widget={widget} />;
    }
    return (
      <div className="rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-3 py-2 font-mono text-xs">
        <div className="text-(--color-muted)">→ {humanToolName(block.name)}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    const text =
      typeof block.output === "string"
        ? block.output
        : Array.isArray(block.output)
          ? (block.output as Array<{ type?: string; text?: string }>)
              .map((b) => b.text ?? "")
              .join("")
          : JSON.stringify(block.output);
    return (
      <div
        className={`rounded-lg border px-3 py-2 font-mono text-xs ${
          block.is_error
            ? "border-(--color-danger) bg-(--color-danger)/10"
            : "border-(--color-success)/40 bg-(--color-success)/10"
        }`}
      >
        <div className="text-(--color-muted)">{block.is_error ? "✖ error" : "✓ done"}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
          {text.slice(0, 1200)}
          {text.length > 1200 ? "…" : ""}
        </pre>
      </div>
    );
  }
  return null;
}

function humanToolName(raw: string): string {
  const t = raw.replace(/^mcp__alta__/, "").replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
