"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useAgentStore } from "@/store/agentStore";
import { appFetch } from "@/lib/apiClient";
import { createClientLogger } from "@/lib/clientLogger";
import { Button } from "@/components/ui/Button";

const log = createClientLogger("test-call");

/**
 * Header-anchored "Test call" button + minimal dropdown.
 *
 *   idle  → click opens a 2-item menu ("Web call" / "Outbound call")
 *           ↳ Web call:      starts WebRTC session immediately, dropdown closes
 *           ↳ Outbound call: swaps the dropdown to a compact dial form
 *   live  → button is the End-call control; click ends the session directly
 *
 * The Phone tab still owns *managing* attached numbers (listing, attaching);
 * this popover only reads them.
 */
export function TestCallButton({ agentId }: { agentId: string }) {
  return (
    <ConversationProvider>
      <TestCallButtonInner agentId={agentId} />
    </ConversationProvider>
  );
}

type View = "menu" | "outbound";

type TranscriptLine = { role: "agent" | "user"; text: string; ts: number };

function TestCallButtonInner({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const setLiveNode = useAgentStore((s) => s.setLiveWorkflowNode);
  const liveNode = useAgentStore((s) => s.liveWorkflowNodeId);

  const conversation = useConversation({
    onError: (e: unknown) => {
      log.error("conversation error", {
        error: typeof e === "string" ? e : String(e),
      });
      setError(typeof e === "string" ? e : "Conversation error");
    },
    onMessage: (msg: { message?: string; source?: string }) => {
      if (!msg.message || !msg.source) return;
      log.trace("transcript", { role: msg.source, len: msg.message.length });
      setTranscript((t) => [
        ...t,
        {
          role: msg.source === "ai" ? "agent" : "user",
          text: msg.message ?? "",
          ts: Date.now(),
        },
      ]);
    },
    onDisconnect: () => {
      log.info("conversation disconnected");
      setLiveNode(null);
    },
    clientTools: {
      report_workflow_state: async ({
        node_id,
      }: {
        node_id?: string;
      }): Promise<string> => {
        if (typeof node_id === "string") setLiveNode(node_id);
        return "tracked";
      },
    },
  });
  const isActive = conversation.status === "connected";

  // Close on outside-click and Escape. Reset view when closing.
  useEffect(() => {
    if (!open) {
      // Defer the view reset so the close animation doesn't snap content.
      const t = window.setTimeout(() => setView("menu"), 150);
      return () => clearTimeout(t);
    }
    const onDocDown = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const startWebCall = async () => {
    log.info("starting web test call", { agent_id: agentId });
    setError(null);
    setStarting(true);
    setLiveNode(null);
    setTranscript([]);
    setOpen(false);
    try {
      const tokenRes = await appFetch(
        `/api/agents/${agentId}/conversation-token`,
      );
      if (!tokenRes.ok) throw new Error(`Token failed (${tokenRes.status})`);
      const json = (await tokenRes.json()) as { signed_url: string };
      await conversation.startSession({ signedUrl: json.signed_url });
      log.info("web call connected");
    } catch (err) {
      log.error("start failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  const endCall = async () => {
    log.info("ending web test call");
    await conversation.endSession();
    setLiveNode(null);
  };

  const onButtonClick = () => {
    if (isActive) {
      void endCall();
      return;
    }
    setOpen((v) => !v);
  };

  // ── Button label / status ────────────────────────────────────────────
  const label = isActive ? "End call" : starting ? "Connecting…" : "Test call";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onButtonClick}
        disabled={starting}
        className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-1.5 text-[12px] font-semibold transition disabled:opacity-60 ${
          isActive
            ? "border-(--color-danger) bg-(--color-danger)/10 text-(--color-danger)"
            : open
              ? "border-(--color-accent) bg-(--color-accent)/80 text-(--color-accent-foreground)"
              : "border-(--color-accent) bg-(--color-accent) text-(--color-accent-foreground) hover:opacity-90"
        }`}
        aria-expanded={open && !isActive}
        aria-label={label}
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isActive
              ? "animate-pulse bg-(--color-danger)"
              : starting
                ? "animate-pulse bg-(--color-accent-foreground)"
                : "bg-(--color-accent-foreground)/70"
          }`}
        />
        <PhoneIcon />
        {label}
      </button>

      {open && !isActive && (
        <div
          role="menu"
          aria-label="Test call options"
          className="animate-scale-in absolute right-0 top-[calc(100%+6px)] z-30 w-[240px] overflow-hidden rounded-xl border border-(--color-border) bg-(--color-panel) shadow-lg"
        >
          {view === "menu" && (
            <div className="py-1">
              <MenuItem
                icon={<MicIcon />}
                label="Web call"
                hint="Talk via browser (WebRTC)"
                onClick={() => void startWebCall()}
              />
              <MenuItem
                icon={<PhoneIcon />}
                label="Outbound call"
                hint="Dial a phone number"
                onClick={() => setView("outbound")}
              />
            </div>
          )}
          {view === "outbound" && (
            <OutboundForm
              agentId={agentId}
              onBack={() => setView("menu")}
              onSuccess={() => setOpen(false)}
            />
          )}
        </div>
      )}

      {error && !open && (
        <p className="absolute right-0 top-[calc(100%+6px)] z-30 max-w-[240px] rounded-md bg-(--color-danger)/10 px-2 py-1 text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}

      {isActive && (
        <CallTranscriptDrawer
          transcript={transcript}
          isSpeaking={conversation.isSpeaking}
          liveNode={liveNode}
          onEnd={() => void endCall()}
          onSendText={(text) => {
            log.debug("sending text to call", { len: text.length });
            conversation.sendUserMessage(text);
          }}
        />
      )}
    </div>
  );
}

// ── Menu item ────────────────────────────────────────────────────────────

function MenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-(--color-panel-soft)"
    >
      <span
        className="grid h-7 w-7 place-items-center rounded-md bg-(--color-panel-soft) text-(--color-foreground-strong)"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-(--color-foreground-strong)">
          {label}
        </span>
        <span className="block truncate text-[11px] text-(--color-muted)">
          {hint}
        </span>
      </span>
    </button>
  );
}

// ── Outbound dial form (shown inside the dropdown) ───────────────────────

function OutboundForm({
  agentId,
  onBack,
  onSuccess,
}: {
  agentId: string;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const config = useAgentStore((s) => s.config);
  const phoneNumbers = config?.phone_numbers ?? [];
  const [selectedPhoneId, setSelectedPhoneId] = useState<string>(
    phoneNumbers[0]?.id ?? "",
  );
  const [toNumber, setToNumber] = useState("");
  const [dialing, setDialing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPhoneId && phoneNumbers[0]?.id) {
      setSelectedPhoneId(phoneNumbers[0].id);
    }
  }, [phoneNumbers, selectedPhoneId]);

  const dial = async () => {
    if (!selectedPhoneId || !toNumber.trim()) return;
    setDialing(true);
    setResult(null);
    setError(null);
    try {
      const res = await appFetch(`/api/agents/${agentId}/outbound-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to_number: toNumber.trim(),
          agent_phone_number_id: selectedPhoneId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Call failed (${res.status})`);
      }
      setResult("Call placed.");
      // Close after a beat so the operator sees confirmation.
      window.setTimeout(onSuccess, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Call failed");
    } finally {
      setDialing(false);
    }
  };

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="grid h-6 w-6 place-items-center rounded text-(--color-muted) hover:bg-(--color-panel-soft) hover:text-(--color-foreground-strong)"
        >
          <ChevronLeftIcon />
        </button>
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-(--color-muted)">
          Outbound call
        </h3>
      </div>

      {phoneNumbers.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-(--color-muted)">
          No phone numbers attached. Ask in chat to attach one.
        </p>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-(--color-muted-soft)">
              From
            </label>
            <select
              value={selectedPhoneId}
              onChange={(e) => setSelectedPhoneId(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-2.5 py-1.5 text-xs"
            >
              {phoneNumbers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-(--color-muted-soft)">
              To
            </label>
            <input
              type="tel"
              placeholder="+15551234567"
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              className="mt-0.5 w-full rounded-lg border border-(--color-border) bg-(--color-panel-soft) px-2.5 py-1.5 text-xs"
            />
          </div>
          <Button
            block
            size="sm"
            onClick={dial}
            disabled={dialing || !toNumber.trim()}
          >
            {dialing ? "Dialing…" : "Call"}
          </Button>
          {result && (
            <p className="text-[11px] text-(--color-success)">{result}</p>
          )}
          {error && (
            <p className="text-[11px] text-(--color-danger)">{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Right-side transcript drawer (visible during a live web call) ───────

function CallTranscriptDrawer({
  transcript,
  isSpeaking,
  liveNode,
  onEnd,
  onSendText,
}: {
  transcript: TranscriptLine[];
  isSpeaking: boolean;
  liveNode: string | null;
  onEnd: () => void;
  onSendText: (text: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  // Auto-scroll to the bottom whenever a new line lands so the latest
  // utterance is always in view.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

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

      {liveNode && (
        <div className="border-b border-(--color-border) bg-(--color-panel-soft) px-4 py-1.5 text-[11px] text-(--color-muted)">
          workflow node:{" "}
          <span className="font-mono text-(--color-foreground-strong)">
            {liveNode}
          </span>
        </div>
      )}

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
                <span dir="auto">{t.text}</span>
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

// ── Icons ────────────────────────────────────────────────────────────────

function PhoneIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
