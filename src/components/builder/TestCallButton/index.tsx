"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { useCallMonitorStore } from "@/store/callMonitorStore";
import { createClientLogger } from "@/lib/clientLogger";
import type { TranscriptLine, View } from "./types";
import { MenuItem } from "./MenuItem";
import { OutboundForm } from "./OutboundForm";
import { CallTranscriptDrawer } from "./CallTranscriptDrawer";
import { PhoneIcon } from "./icons/PhoneIcon";
import { MicIcon } from "./icons/MicIcon";

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

function TestCallButtonInner({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const conversation = useConversation({
    onConnect: ({ conversationId }: { conversationId: string }) => {
      log.info("web call connected", { conversationId });
      useCallMonitorStore.getState().setConversationId(conversationId);
    },
    // Drives live workflow-node tracking. ElevenLabs emits a workflow tool
    // `notify_condition_<N>_met` on every edge traversal and a system
    // `end_call` at the end node; the engine maps those to the active node.
    onAgentToolResponse: (e: {
      tool_name?: string;
      tool_type?: string;
      is_error?: boolean;
    }) => {
      if (!e.tool_name || !e.tool_type) return;
      useCallMonitorStore.getState().ingest({
        kind: "tool_response",
        toolName: e.tool_name,
        toolType: e.tool_type,
        isError: !!e.is_error,
      });
    },
    onError: (e: unknown) => {
      log.error("conversation error", {
        error: typeof e === "string" ? e : String(e),
      });
      setError(typeof e === "string" ? e : "Conversation error");
    },
    onMessage: (msg: { message?: string; source?: string }) => {
      if (!msg.message || !msg.source) return;
      log.trace("transcript", { role: msg.source, len: msg.message.length });
      const role: "agent" | "user" = msg.source === "ai" ? "agent" : "user";
      const text = msg.message;
      setTranscript((t) => {
        // Dedupe user echoes: if we just optimistically pushed the same
        // text from sendDraft, ignore the SDK's echo to avoid duplicates.
        const last = t[t.length - 1];
        if (role === "user" && last?.role === "user" && last.text === text) {
          return t;
        }
        return [...t, { role, text, ts: Date.now() }];
      });
    },
    onDisconnect: () => {
      log.info("conversation disconnected");
      useCallMonitorStore.getState().ingest({ kind: "disconnect" });
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
    setTranscript([]);
    setOpen(false);
    // Seed live node-tracking from a frozen snapshot of the current workflow
    // graph, so the Workflow canvas can highlight the call's position.
    const workflow = useAgentStore.getState().config?.workflow;
    if (workflow) useCallMonitorStore.getState().start(workflow);
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
      useCallMonitorStore.getState().reset();
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  };

  const endCall = async () => {
    log.info("ending web test call");
    await conversation.endSession();
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
          onEnd={() => void endCall()}
          onSendText={(text) => {
            log.debug("sending text to call", { len: text.length });
            // Optimistically render the user bubble — the SDK doesn't echo
            // typed messages back via onMessage, so without this the text
            // never appears on screen. onMessage dedupes if it does echo.
            setTranscript((t) => [
              ...t,
              { role: "user", text, ts: Date.now() },
            ]);
            conversation.sendUserMessage(text);
          }}
        />
      )}
    </div>
  );
}
