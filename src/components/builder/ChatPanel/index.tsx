"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import { VersionHistoryPanel } from "../VersionHistoryPanel";
import { TodoListCard } from "../TodoListCard";
import { EditableAgentName } from "./Header/EditableAgentName";
import { BackArrowIcon, HistoryIcon } from "./Header/icons";
import { TurnView } from "./Turn";

const log = createClientLogger("chat");

export function ChatPanel({ agentId }: { agentId: string }) {
  const turns = useAgentStore((s) => s.turns);
  const streaming = useAgentStore((s) => s.streaming);
  const agentName = useAgentStore((s) => s.config?.name);
  // Used to suppress the "thinking…" dots when a tool pill is already
  // visible — otherwise we show two activity indicators side by side.
  const liveTool = useAgentStore((s) => s.liveTool);
  // True for the whole duration of the agent's turn (from kickoff through
  // SSE end), not just while sendMessage is in flight. Drives the spinner
  // on the send button.
  const activeJobId = useAgentStore((s) => s.activeJobId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-(--color-border) px-4 animate-fade-in">
        {historyOpen ? (
          <button
            type="button"
            onClick={() => setHistoryOpen(false)}
            aria-label="Back to chat"
            title="Back to chat"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            <BackArrowIcon />
          </button>
        ) : (
          <Link
            href="/"
            aria-label="Back to home"
            title="Back to home"
            className="grid h-8 w-8 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
          >
            <BackArrowIcon />
          </Link>
        )}
        {historyOpen ? (
          <span className="truncate px-1.5 py-0.5 text-[13px] font-semibold text-(--color-foreground-strong)">
            Version history
          </span>
        ) : (
          <EditableAgentName agentId={agentId} value={agentName ?? ""} />
        )}
        <div className="ml-auto flex items-center gap-2">
          {activeJobId && (
            <span
              className="flex items-center gap-1 text-(--color-accent) animate-fade-in"
              role="status"
              aria-label="Agent is working"
              title="Agent is working"
            >
              <span className="dot-flash" />
              <span className="dot-flash" style={{ animationDelay: "120ms" }} />
              <span className="dot-flash" style={{ animationDelay: "240ms" }} />
            </span>
          )}
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            title={historyOpen ? "Back to chat" : "Version history"}
            aria-pressed={historyOpen}
            className={`grid h-8 w-8 place-items-center rounded-md transition ${
              historyOpen
                ? "bg-(--color-accent)/10 text-(--color-accent)"
                : "text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
            }`}
          >
            <HistoryIcon />
          </button>
        </div>
      </header>

      {historyOpen ? (
        <VersionHistoryPanel agentId={agentId} />
      ) : (
      <>
      <div ref={scrollerRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5 text-(--color-foreground)">
        <TodoListCard />
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
            {(() => {
              const running = sending || activeJobId !== null;
              return (
                <button
                  onClick={send}
                  disabled={running || !input.trim()}
                  // While the agent is running we keep the button visually
                  // "live" (accent bg, no greying) and just swap the icon
                  // for a spinner — that's a clearer signal than dimming it.
                  className={
                    running
                      ? "grid h-7 w-7 place-items-center rounded-md bg-(--color-accent) text-white"
                      : "grid h-7 w-7 place-items-center rounded-md bg-(--color-accent) text-white transition hover:brightness-110 disabled:bg-(--color-border) disabled:text-(--color-muted-soft) disabled:hover:brightness-100"
                  }
                  aria-label={running ? "Agent is running" : "Send"}
                >
                  {running ? (
                    <span
                      className="block h-3 w-3 rounded-full border-[1.5px] border-white/40 border-t-white"
                      style={{ animation: "vask-spin 0.8s linear infinite" }}
                      aria-hidden
                    />
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  )}
                </button>
              );
            })()}
          </div>
        </div>
      </footer>
      </>
      )}
    </div>
  );
}
