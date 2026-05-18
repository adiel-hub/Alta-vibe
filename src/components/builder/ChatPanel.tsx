"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import type { ContentBlock } from "@/types/agent";
import { ChatWidget } from "./ChatWidget";
import { Typewriter } from "./Typewriter";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";

const log = createClientLogger("chat");

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  // Used to suppress the "thinking…" dots when a tool pill is already
  // visible — otherwise we show two activity indicators side by side.
  const liveTool = useAgentStore((s) => s.liveTool);
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
        <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-lg bg-(--color-violet-100)">
          <Image
            src="/alta-avatar.png"
            alt=""
            width={28}
            height={28}
            className="h-full w-full object-cover"
          />
        </span>
        <span className="text-[13px] font-semibold text-(--color-foreground-strong)">
          Alex
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
            // Suppress the "thinking…" dots when a tool is mid-flight; the
            // tool pill below already shows running state. Showing both
            // duplicates the "something is happening" signal.
            streamingHint={!streaming.text && !liveTool}
          />
        )}
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

  // Build a tool_use_id → tool_result map so each inline ToolCard knows
  // its own outcome without scanning the full block list per render.
  const toolResults = new Map<
    string,
    Extract<ContentBlock, { type: "tool_result" }>
  >();
  for (const b of content) {
    if (b.type === "tool_result") toolResults.set(b.tool_use_id, b);
  }

  // Drop empty assistant bubbles. A turn is visible if it has any non-empty
  // text, a non-result tool block, or we're showing the streaming hint.
  if (role === "assistant" && !streamingHint) {
    const hasVisible = content.some((b) => {
      if (b.type === "text" && b.text.trim().length > 0) return true;
      if (b.type === "tool_use") return true;
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
            : "max-w-[92%] space-y-3 px-1 py-1 text-sm text-(--color-foreground)"
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
            result={
              block.type === "tool_use" ? toolResults.get(block.id) : undefined
            }
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
  result,
}: {
  block: ContentBlock;
  agentId?: string;
  live: boolean;
  isLast: boolean;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const widgets = useAgentStore((s) => s.widgets);

  if (block.type === "text") {
    return (
      <div dir="auto" className="leading-relaxed">
        <Typewriter text={block.text} live={live && isLast} />
      </div>
    );
  }
  if (block.type === "tool_use") {
    // Widgets render as their own interactive component, not a tool card.
    if (block.name === "mcp__alta__request_user_action" && agentId) {
      const input = block.input as { kind?: string; payload?: unknown } | undefined;
      const widget = Object.values(widgets).find(
        (w) =>
          w.kind === input?.kind &&
          JSON.stringify(w.payload) === JSON.stringify(input?.payload),
      );
      if (widget) return <ChatWidget agentId={agentId} widget={widget} />;
    }
    // Hide SDK internals from the chat. ToolSearch is the Claude Agent
    // SDK's deferred-tool loader — it fires every turn to bring our MCP
    // tool schemas into the model's context. It's machinery, not a step
    // the user cares about.
    if (block.name === "ToolSearch") return null;
    return <ToolCard block={block} result={result} />;
  }
  // tool_result blocks are rendered INSIDE the matching tool_use card.
  return null;
}

/**
 * Inline card that represents one tool call in the assistant's response.
 * Renders a one-line summary (spinner | ✓ | ✗  +  emoji  +  friendly label).
 * Click to expand → shows the input args and the tool's text output.
 */
function ToolCard({
  block,
  result,
}: {
  block: Extract<ContentBlock, { type: "tool_use" }>;
  result?: Extract<ContentBlock, { type: "tool_result" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const friendly = friendlyForTool(block.name);
  const status: "running" | "success" | "error" = !result
    ? "running"
    : result.is_error
      ? "error"
      : "success";

  const indicator =
    status === "running" ? (
      <span className="vb-tool-spin" aria-hidden />
    ) : status === "success" ? (
      <span
        className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-success)"
        aria-hidden
      >
        ✓
      </span>
    ) : (
      <span
        className="grid h-3.5 w-3.5 place-items-center text-[10px] font-bold text-(--color-danger)"
        aria-hidden
      >
        ✕
      </span>
    );

  const resultText = (() => {
    if (!result) return null;
    const out = result.output;
    if (typeof out === "string") return out;
    if (Array.isArray(out)) {
      return out
        .map((x) =>
          x && typeof x === "object" && "type" in x && (x as { type?: string }).type === "text"
            ? (x as { text?: string }).text ?? ""
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(out, null, 2);
  })();

  return (
    <div className="vb-tool-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="vb-tool-card-head"
        aria-expanded={expanded}
      >
        {indicator}
        <span className="vb-tool-card-emoji" aria-hidden>
          {friendly.emoji}
        </span>
        <span
          className={`vb-tool-card-label ${
            status === "running" ? "vb-tool-card-label-shimmer" : ""
          }`}
        >
          {friendly.label}
        </span>
        <span className="vb-tool-card-chev" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="vb-tool-card-body">
          {block.input !== undefined && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">Input</div>
              <pre dir="auto" className="vb-tool-card-pre">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
          )}
          {resultText !== null && (
            <div className="vb-tool-card-section">
              <div className="vb-tool-card-section-label">
                {status === "error" ? "Error" : "Result"}
              </div>
              <pre
                dir="auto"
                className={`vb-tool-card-pre ${
                  status === "error" ? "vb-tool-card-pre-error" : ""
                }`}
              >
                {resultText || "(empty)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
