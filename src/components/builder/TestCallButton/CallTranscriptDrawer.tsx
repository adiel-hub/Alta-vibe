"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptLine } from "./types";
import { TypewriterText } from "./TypewriterText";
import { SendIcon } from "./icons/SendIcon";

// ── Right-side transcript drawer (visible during a live web call) ───────

export function CallTranscriptDrawer({
  transcript,
  isSpeaking,
  onEnd,
  onSendText,
}: {
  transcript: TranscriptLine[];
  isSpeaking: boolean;
  onEnd: () => void;
  onSendText: (text: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [transcript, scrollToBottom]);

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    onSendText(text);
    // The SDK echoes the text back via onMessage with source="user", so we
    // don't optimistically push into the transcript here — letting the
    // server-side acknowledgement be the single source of truth keeps the
    // ordering correct vs. agent replies.
    setDraft("");
  };

  return (
    <aside
      role="complementary"
      aria-label="Live call transcript"
      // position: fixed so the drawer escapes the header's containing
      // block and overlays the right edge of the viewport — sits ABOVE
      // the visual panel while the call is active, then unmounts.
      style={{
        animation: "vb-drawer-in 280ms cubic-bezier(0.2, 0.9, 0.3, 1.1) both",
      }}
      className="fixed right-0 top-0 bottom-0 z-40 flex w-[360px] flex-col border-l border-(--color-border) bg-(--color-panel) shadow-2xl"
    >
      <header className="flex items-center gap-2 border-b border-(--color-border) px-4 py-3">
        <span className="h-2 w-2 animate-pulse rounded-full bg-(--color-danger)" />
        <h3 className="flex-1 text-[13px] font-semibold text-(--color-foreground-strong)">
          Live call
        </h3>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
            isSpeaking
              ? "bg-(--color-accent)/10 text-(--color-accent)"
              : "bg-(--color-panel-soft) text-(--color-muted)"
          }`}
          title={isSpeaking ? "Agent is speaking" : "User is speaking"}
        >
          {isSpeaking ? "agent" : "user"}
        </span>
        <button
          type="button"
          onClick={onEnd}
          className="rounded-full border border-(--color-danger) px-3 py-1 text-[11px] font-semibold text-(--color-danger) hover:bg-(--color-danger)/10"
        >
          End
        </button>
      </header>

      <div
        ref={scrollerRef}
        className="flex-1 space-y-2 overflow-y-auto px-4 py-4"
      >
        {transcript.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-[12px] italic text-(--color-muted-soft)">
              Waiting for the conversation to begin…
              <br />
              Say hello or type below.
            </p>
          </div>
        ) : (
          transcript.map((t, i) => (
            <div
              key={i}
              className={
                t.role === "agent"
                  ? "flex justify-start"
                  : "flex justify-end"
              }
            >
              <div
                className={`max-w-[85%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed ${
                  t.role === "agent"
                    ? "bg-(--color-panel-soft) text-(--color-foreground-strong)"
                    : "bg-(--color-accent) text-(--color-accent-foreground)"
                }`}
              >
                {t.role === "agent" ? (
                  <TypewriterText text={t.text} onTick={scrollToBottom} />
                ) : (
                  <span dir="auto">{t.text}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-(--color-border) bg-(--color-panel) p-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-(--color-border) bg-(--color-panel) px-2.5 py-1.5 transition focus-within:border-(--color-accent) focus-within:shadow-[0_0_0_3px_rgba(79,70,229,0.08)]">
          <textarea
            dir="auto"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendDraft();
              }
            }}
            rows={1}
            placeholder="Type to speak…"
            aria-label="Type a message to the agent"
            className="flex-1 resize-none bg-transparent text-[13px] leading-relaxed text-(--color-foreground-strong) outline-none placeholder:text-(--color-muted-soft)"
          />
          <button
            type="button"
            onClick={sendDraft}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-(--color-accent) text-(--color-accent-foreground) transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </aside>
  );
}
