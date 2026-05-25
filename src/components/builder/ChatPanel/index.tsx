"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAgentStore } from "@/store/agentStore";
import { attachToTurn, sendMessage } from "@/store/sseClient";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import { friendlyTurnError } from "@/lib/errorMessages";
import { VersionHistoryPanel } from "../VersionHistoryPanel";
import { EditableAgentName } from "./Header/EditableAgentName";
import { BackArrowIcon, HistoryIcon } from "./Header/icons";
import { TurnView } from "./Turn";
import { ChatWidget } from "../ChatWidget";

const log = createClientLogger("chat");

export function ChatPanel({
  agentId,
  embedded = false,
  sessionId,
}: {
  agentId: string;
  /**
   * Hide the top header (back-arrow, agent-name, version-history). Used when
   * the chat is embedded inside another shell that already provides
   * navigation chrome (e.g. /audiences/build, where the layout supplies
   * the masthead + sidebar).
   */
  embedded?: boolean;
  /**
   * Audience-builder only: scopes both the send-message turn and the
   * resume-on-mount lookup to a specific chat_session row. Voice agents
   * pass nothing and behave exactly as before.
   */
  sessionId?: string;
}) {
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
  // Server-emitted turn-level errors (state_error events with section "turn")
  // land here via the SSE client. We surface them in the same banner as local
  // send/resume failures.
  const turnError = useAgentStore((s) => s.errors["turn"] ?? null);
  const clearStoreError = useAgentStore((s) => s.setError);
  // Orphan widgets (those not tied to a tool_use block in a turn) — e.g. the
  // CSV the user attached via the paperclip — render at the bottom of the
  // scroller. Tool-driven widgets keep rendering adjacent to their tool_use
  // block; this only catches the user-initiated path.
  const widgets = useAgentStore((s) => s.widgets);
  const upsertWidget = useAgentStore((s) => s.upsertWidget);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const error = friendlyTurnError(localError ?? turnError);
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
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("resume failed", { error: msg });
        // First-turn failures (e.g. Claude API 529) reach us only through the
        // resume effect. Surface the message so the user isn't left staring
        // at an empty chat.
        setLocalError(msg);
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
  }, [turns, streaming, widgets]);

  const onAttachFile = async (file: File) => {
    if (attaching || sending) return;
    setLocalError(null);
    setAttaching(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await appFetch(`/api/agents/${agentId}/widgets/csv-attach`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }
      const json = (await res.json()) as {
        widget: {
          action_id: string;
          kind: "csv_upload";
          payload: unknown;
          status: "pending";
          result: null;
        };
      };
      // Anchor the widget to whatever turn is currently last, so subsequent
      // user messages render BELOW it at the true bottom of the chat.
      const currentTurns = useAgentStore.getState().turns;
      const anchorId =
        currentTurns.length > 0
          ? currentTurns[currentTurns.length - 1].id
          : undefined;
      upsertWidget({ ...json.widget, after_turn_id: anchorId });
      log.info("csv attached", {
        action_id: json.widget.action_id,
        name: file.name,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      log.warn("attach failed", { error: msg });
      setLocalError(msg);
    } finally {
      setAttaching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    log.debug("user send", { text_len: text.length });
    setInput("");
    setSending(true);
    setLocalError(null);
    // Clear any prior server-side turn error so retries start with a clean banner.
    clearStoreError("turn", null);
    try {
      await sendMessage(agentId, text, sessionId ? { chatSessionId: sessionId } : {});
    } catch (err) {
      log.error("send error", {
        error: err instanceof Error ? err.message : String(err),
      });
      setLocalError(err instanceof Error ? err.message : "Stream failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {!embedded && (
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
      )}

      {historyOpen && !embedded ? (
        <VersionHistoryPanel agentId={agentId} />
      ) : (
      <>
      <div
        ref={scrollerRef}
        className={`flex-1 space-y-4 overflow-y-auto px-5 py-5 text-(--color-foreground) ${
          embedded ? "mx-auto w-full max-w-4xl" : ""
        }`}
      >
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
        {(() => {
          // Group orphan widgets (no tool_use_id) by their anchor turn so
          // we can render each one immediately below the turn that was
          // last when it was created. Widgets whose anchor turn is no
          // longer in the list (or that have no anchor) fall through to
          // a "leading" bucket and render at the top — the only place
          // they can go without disrupting the chronological flow.
          const turnIds = new Set(turns.map((t) => t.id));
          const orphans = Object.values(widgets).filter((w) => !w.tool_use_id);
          const orphansByAnchor = new Map<string, typeof orphans>();
          const leading: typeof orphans = [];
          for (const w of orphans) {
            if (w.after_turn_id && turnIds.has(w.after_turn_id)) {
              const arr = orphansByAnchor.get(w.after_turn_id) ?? [];
              arr.push(w);
              orphansByAnchor.set(w.after_turn_id, arr);
            } else {
              leading.push(w);
            }
          }
          return (
            <>
              {leading.map((w) => (
                <ChatWidget key={w.action_id} agentId={agentId} widget={w} />
              ))}
              {turns.map((turn, i) => {
                // When the SDK emits text → tool → text, the post-tool
                // deltas keep filling `streaming` with the SAME id as the
                // turn that was already pushed into `turns` by
                // appendToolCallStart. Render those deltas INSIDE the
                // existing turn so the user sees one "Alex" bubble that
                // grows, not a second header that appears during
                // streaming and merges back in on turn_done.
                const isStreamingThis =
                  !!streaming && streaming.id === turn.id;
                const content =
                  isStreamingThis && streaming.text
                    ? [
                        ...turn.content,
                        { type: "text" as const, text: streaming.text },
                      ]
                    : turn.content;
                // Show "thinking…" at the end of the turn when we're
                // streaming into it but there's no new prose yet and no
                // tool currently running — e.g. the gap between one tool
                // finishing and the model deciding what to do next.
                // `liveTool` keeps the last tool's success/error badge
                // visible until turn_done, so we explicitly require
                // `running` here — a completed tool means the model has
                // handed control back and is thinking again.
                const showHint =
                  isStreamingThis &&
                  !streaming.text &&
                  (!liveTool || liveTool.status !== "running");
                const anchoredHere = orphansByAnchor.get(turn.id) ?? [];
                return (
                  <div key={turn.id} className="space-y-4">
                    <TurnView
                      role={turn.role}
                      content={content}
                      agentId={agentId}
                      live={isStreamingThis}
                      isLast={i === turns.length - 1 && !streaming}
                      streamingHint={showHint}
                    />
                    {anchoredHere.map((w) => (
                      <ChatWidget
                        key={w.action_id}
                        agentId={agentId}
                        widget={w}
                      />
                    ))}
                  </div>
                );
              })}
              {streaming && !turns.some((t) => t.id === streaming.id) && (
                <TurnView
                  role="assistant"
                  content={[{ type: "text", text: streaming.text || "" }]}
                  agentId={agentId}
                  live
                  isLast
                  // Suppress the "thinking…" dots when a tool is
                  // mid-flight; the tool pill below already shows running
                  // state. Showing both duplicates the "something is
                  // happening" signal.
                  streamingHint={!streaming.text && !liveTool}
                />
              )}
            </>
          );
        })()}
      </div>

      {error && (
        <div
          role="alert"
          className={`flex items-start gap-2 border-t border-(--color-danger) bg-(--color-danger)/10 px-5 py-2 text-xs text-(--color-danger) animate-fade-in ${
            embedded ? "mx-auto w-full max-w-4xl" : ""
          }`}
        >
          <span className="flex-1 leading-snug">{error}</span>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              clearStoreError("turn", null);
            }}
            aria-label="Dismiss error"
            className="shrink-0 rounded px-1.5 text-(--color-danger)/70 transition hover:bg-(--color-danger)/15 hover:text-(--color-danger)"
          >
            ✕
          </button>
        </div>
      )}

      <footer
        className={
          embedded
            ? "mx-auto w-full max-w-4xl p-3"
            : "border-t border-(--color-border) bg-(--color-panel) p-3"
        }
      >
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
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onAttachFile(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attaching || sending || activeJobId !== null}
              title="Attach CSV"
              aria-label="Attach CSV file"
              className="grid h-7 w-7 place-items-center rounded-md text-(--color-muted) transition hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong) disabled:cursor-not-allowed disabled:text-(--color-muted-soft) disabled:hover:bg-transparent"
            >
              {attaching ? (
                <span
                  className="block h-3 w-3 rounded-full border-[1.5px] border-(--color-accent)/30 border-t-(--color-accent)"
                  style={{ animation: "vask-spin 0.8s linear infinite" }}
                  aria-hidden
                />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              )}
            </button>
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
