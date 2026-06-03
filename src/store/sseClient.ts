"use client";

import { nanoid } from "nanoid";
import type { SSEEvent } from "@/types/agent";
import {
  useAgentStore,
  type SectionKey,
} from "./agentStore";
import { appFetch } from "@/lib/apiClient";
import { friendlyForTool } from "@/lib/capabilities/toolDisplay";
import { createClientLogger } from "@/lib/clientLogger";
import { startPhoneCallMonitor } from "@/lib/callMonitor/startPhoneCallMonitor";

const log = createClientLogger("sse-client");

/**
 * Send a user message. Backend immediately persists the user turn + creates a
 * turn_job, then starts background processing. We attach to the turn's SSE
 * stream and drive the store from its events. If the user refreshes mid-turn,
 * the page can call `attachToTurn(jobId, since)` to rejoin from any seq.
 */
export async function sendMessage(
  agentId: string,
  userText: string,
  opts: { chatSessionId?: string } = {},
): Promise<string> {
  log.info("send", {
    agent_id: agentId,
    text_len: userText.length,
    chat_session_id: opts.chatSessionId,
  });
  const store = useAgentStore.getState();
  const userTurnId = nanoid();
  const assistantTurnId = nanoid();
  store.appendUserTurn(userTurnId, userText);
  store.appendAssistantDelta(assistantTurnId, "");

  const res = await appFetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: userText,
      ...(opts.chatSessionId ? { chat_session_id: opts.chatSessionId } : {}),
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    log.error("send failed", { status: res.status });
    throw new Error(body?.error ?? `Chat request failed (${res.status})`);
  }
  const { jobId } = (await res.json()) as { jobId: string };
  log.info("turn enqueued", { job_id: jobId });
  store.setActiveTurn(jobId, assistantTurnId);
  // Detached attach — caller awaits separately if needed
  void attachToTurn(agentId, jobId, 0, assistantTurnId);
  return jobId;
}

/**
 * Attach to (or re-attach to) a turn's SSE stream. Replays events from `since`,
 * then tails until the turn finishes. Idempotent w.r.t. seq because the server
 * stamps event ids and we only forward events we haven't seen.
 *
 * Cross-agent safety: the global Zustand store is shared across the whole
 * app, but a single user can have multiple active streams alive at once
 * (start agent A → navigate home → open agent B while A is still building).
 * Every store write here is gated on the store's current `agent.id` still
 * matching the agentId this attach was started for. The moment they diverge
 * we cancel the reader and stop touching the store so A's stream doesn't
 * spill into B's chat.
 *
 * Supersede safety: a liveness re-attach (tab refocus, network back online)
 * can fire while a prior attach loop is still alive. Each call bumps
 * `attachGeneration`; older loops notice they're no longer current, cancel
 * their reader, and bail without finalizing — so only the newest attach
 * writes to the store and exactly one loop owns finalization.
 */
let attachGeneration = 0;

export async function attachToTurn(
  agentId: string,
  jobId: string,
  since: number,
  assistantTurnIdOverride?: string,
): Promise<void> {
  log.info("attach", { agent_id: agentId, job_id: jobId, since });
  const isLive = () => useAgentStore.getState().agent?.id === agentId;
  if (!isLive()) {
    log.warn("attach skipped — store holds a different agent", {
      attach_for: agentId,
      store_agent: useAgentStore.getState().agent?.id,
    });
    return;
  }

  const store = useAgentStore.getState();
  let assistantTurnId = assistantTurnIdOverride ?? store.activeAssistantTurnId;
  if (!assistantTurnId) {
    assistantTurnId = nanoid();
    store.appendAssistantDelta(assistantTurnId, "");
  }
  store.setActiveTurn(jobId, assistantTurnId);

  // This call's generation. If a newer attachToTurn starts, `live()` flips
  // false here and this loop stands down (see "Supersede safety" above).
  const myGeneration = ++attachGeneration;
  const live = () => isLive() && attachGeneration === myGeneration;

  // Highest seq applied so far. Survives reconnects so we resume the tail
  // exactly where we left off (server replays events with seq >= since).
  let lastSeq = since - 1;
  let abandoned = false;

  // One connection attempt. Returns whether it observed a terminal event
  // (turn_done/turn_aborted) — the only reliable signal that the turn truly
  // ended, as opposed to the socket merely dropping mid-turn (which Vercel's
  // edge does during the quiet gaps between events).
  const connectOnce = async (): Promise<{ sawTerminal: boolean }> => {
    const secret = process.env.NEXT_PUBLIC_APP_SHARED_SECRET;
    const res = await fetch(
      `/api/agents/${agentId}/turns/${jobId}/stream?since=${lastSeq + 1}`,
      { headers: secret ? { "x-app-secret": secret } : undefined },
    );
    if (!res.ok || !res.body) {
      log.warn("attach connect failed", { status: res.status });
      return { sawTerminal: false };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawTerminal = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!live()) {
        log.info("attach abandoned — superseded or agent switched", {
          attach_for: agentId,
        });
        void reader.cancel().catch(() => {});
        abandoned = true;
        return { sawTerminal: false };
      }
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseBlock(block);
        if (parsed && parsed.seq > lastSeq) {
          // Re-check per event (not just per chunk) so a superseded loop stops
          // applying the instant a newer attach takes over — otherwise it could
          // apply one more event and duplicate a tool card.
          if (!live()) {
            void reader.cancel().catch(() => {});
            abandoned = true;
            return { sawTerminal };
          }
          handleEvent(assistantTurnId, parsed.event);
          lastSeq = parsed.seq;
          useAgentStore.getState().setLastSeq(lastSeq);
          if (
            parsed.event.type === "turn_done" ||
            parsed.event.type === "turn_aborted"
          ) {
            sawTerminal = true;
          }
        }
      }
    }
    return { sawTerminal };
  };

  // Is THIS job still queued/running on the backend? Used to decide whether a
  // stream that ended without a terminal event was a transient drop (reconnect)
  // or a genuinely-finished/reaped job (stop). /turns/active also runs the
  // stuck-job reaper, so a crashed job resolves to "not active" here.
  const jobStillActive = async (): Promise<boolean> => {
    try {
      const r = await appFetch(`/api/agents/${agentId}/turns/active`);
      if (!r.ok) return false;
      const j = (await r.json()) as { active: { id: string } | null };
      return j.active?.id === jobId;
    } catch {
      return false;
    }
  };

  const MAX_RECONNECTS = 6;
  let attempts = 0;
  while (true) {
    const { sawTerminal } = await connectOnce();
    if (abandoned || !live()) return; // superseded or agent switched — leave store alone

    if (sawTerminal) break; // turn genuinely ended

    // Stream closed without a terminal event. Distinguish a dropped socket
    // from a finished/reaped job before deciding to finalize.
    if (!(await jobStillActive())) {
      log.info("stream ended; job no longer active — finalizing", {
        job_id: jobId,
        last_seq: lastSeq,
      });
      break;
    }
    if (abandoned || !live()) return;

    if (++attempts > MAX_RECONNECTS) {
      log.warn("reconnect attempts exhausted", { job_id: jobId, last_seq: lastSeq });
      useAgentStore
        .getState()
        .setError(
          "turn",
          "Lost the live update stream. Refresh to see the latest.",
        );
      break;
    }
    const backoffMs = Math.min(500 * 2 ** (attempts - 1), 4000);
    log.info("stream dropped mid-turn — reconnecting", {
      job_id: jobId,
      last_seq: lastSeq,
      attempt: attempts,
      backoff_ms: backoffMs,
    });
    await new Promise((r) => setTimeout(r, backoffMs));
    if (abandoned || !live()) return;
  }

  log.info("stream end", { job_id: jobId, last_seq: lastSeq });
  if (!live()) return;
  useAgentStore.getState().finalizeAssistantTurn();
  useAgentStore.getState().setActiveTurn(null, null);
}

function parseBlock(block: string): { seq: number; event: SSEEvent } | null {
  let seq = -1;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data || seq < 0) return null;
  try {
    return { seq, event: JSON.parse(data) as SSEEvent };
  } catch {
    return null;
  }
}

/**
 * Tracks the tool_use_id of the most recent tool that ran. If that tool
 * emits a `widget_inserted` event (request_user_action, setup_phone_number,
 * etc.), the SSE client stamps the widget with this id so ChatPanel can
 * O(1)-look it up next to the tool_use block. Tools that don't produce a
 * widget simply have their id overwritten by the next tool — harmless.
 *
 * Events arrive in order within a single attachToTurn call, so module-level
 * state is safe.
 */
let pendingWidgetToolUseId: string | null = null;

function handleEvent(assistantTurnId: string, event: SSEEvent): void {
  log.trace("event", { type: event.type });
  const s = useAgentStore.getState();
  switch (event.type) {
    case "assistant_delta":
      s.appendAssistantDelta(assistantTurnId, event.text);
      break;
    case "tool_input_partial":
      s.applyToolInputPartial(event.field, event.value);
      break;
    case "tool_call_start": {
      log.debug("tool_call_start", { name: event.name });
      // SDK internals: ToolSearch fires every turn to load our MCP tool
      // schemas. It's not a step the user cares about — swallow it so it
      // doesn't appear in the chat, in the live indicator, or in any
      // auto-switch decision.
      if (event.name === "ToolSearch") break;
      const bare = event.name.replace(/^mcp__alta__/, "");
      // Stash this tool's id so any `widget_inserted` event that follows
      // can be stamped with it. Multiple tools produce widgets now
      // (request_user_action, setup_phone_number, …) — instead of
      // hard-coding the list, we always track the most recent.
      pendingWidgetToolUseId = event.tool_use_id;
      const section = sectionForTool(bare);
      if (section) {
        s.setInFlight(section, true);
        // Auto-switch suppressions:
        //   - list_*/read_* are pure discovery; they shouldn't yank the panel.
        //   - scrape_* tools take ~30 s and the user is usually mid-thought
        //     on Persona; the KB tab can update silently in the background.
        //   - place_outbound_test_call: the call_started event switches to the
        //     Workflow tab for live tracking; don't flash the Phone tab first.
        const noAutoSwitch =
          /^(list_|read_|scrape_)/.test(bare) ||
          bare === "place_outbound_test_call";
        if (!noAutoSwitch) s.bumpActiveSection(section);
      }
      s.appendToolCallStart(assistantTurnId, event.tool_use_id, event.name, event.input);
      // Single morphing tool indicator in the chat.
      const friendly = friendlyForTool(event.name);
      s.setLiveTool({
        tool_use_id: event.tool_use_id,
        raw_name: event.name,
        emoji: friendly.emoji,
        label: friendly.label,
        status: "running",
      });
      break;
    }
    case "tool_call_result": {
      log.debug("tool_call_result", { is_error: event.is_error === true });
      s.appendToolCallResult(
        assistantTurnId,
        event.tool_use_id,
        event.output,
        event.is_error,
      );
      const cur = s.liveTool;
      if (cur && cur.tool_use_id === event.tool_use_id) {
        const errMsg = event.is_error
          ? typeof event.output === "string"
            ? event.output
            : extractErrorText(event.output)
          : undefined;
        s.setLiveTool({
          ...cur,
          status: event.is_error ? "error" : "success",
          error_message: errMsg,
          finished_at: Date.now(),
        });
      }
      break;
    }
    case "state_patch":
      log.debug("state_patch", {
        revision: event.revision,
        keys: Object.keys(event.patch),
      });
      // Workflow patches are a frequent suspect when the page hangs — they
      // can be large and they trigger the canvas's layout + reveal pipeline.
      // Surface size + duration at info-level so it shows up in the default
      // browser log without needing to bump NEXT_PUBLIC_LOG_LEVEL.
      if (event.patch.workflow) {
        const w = event.patch.workflow;
        const t0 =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        s.applyPatch(event.revision, event.patch);
        const t1 =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        log.info("workflow patch applied", {
          revision: event.revision,
          nodes: w.nodes.length,
          edges: w.edges.length,
          apply_ms: Math.round((t1 - t0) * 100) / 100,
        });
      } else {
        s.applyPatch(event.revision, event.patch);
      }
      for (const key of Object.keys(event.patch)) {
        const section = sectionForPatchKey(key);
        if (!section) continue;
        // Workflow + knowledge_base patches can be large; clearing inFlight
        // immediately re-enables the send button before the canvas / KB tab
        // has finished laying out. Let the bulk clear on turn_done handle
        // those so the spinner stays visible until paint completes.
        if (section === "workflow" || section === "knowledge_base") continue;
        s.setInFlight(section, false);
      }
      break;
    case "state_error":
      log.warn("state_error", { section: event.section, message: event.message });
      s.setError(event.section, event.message);
      break;
    case "call_started": {
      log.info("call_started", { conversation_id: event.conversation_id });
      // A tool placed a phone call. Attach to the monitor bridge so the
      // Workflow tab tracks it live (start() flips status→live → tab opens).
      const agentId = useAgentStore.getState().agent?.id;
      if (agentId) startPhoneCallMonitor(agentId, event.conversation_id);
      break;
    }
    case "widget_inserted": {
      log.info("widget_inserted", {
        action_id: event.action_id,
        kind: event.kind,
      });
      const toolUseId = pendingWidgetToolUseId ?? undefined;
      pendingWidgetToolUseId = null;
      s.upsertWidget({
        action_id: event.action_id,
        kind: event.kind,
        payload: event.payload,
        status: "pending",
        result: null,
        tool_use_id: toolUseId,
      });
      break;
    }
    case "widget_resolved":
      log.info("widget_resolved", {
        action_id: event.action_id,
        status: event.status,
      });
      s.resolveWidget(event.action_id, event.status, event.result);
      break;
    case "turn_aborted":
      log.warn("turn_aborted", { reason: event.reason });
      pendingWidgetToolUseId = null;
      for (const sec of Array.from(s.inFlight)) s.setInFlight(sec, false);
      s.setLiveTool(null);
      break;
    case "turn_done":
      log.info("turn_done", { revision: event.revision });
      pendingWidgetToolUseId = null;
      for (const sec of Array.from(s.inFlight)) s.setInFlight(sec, false);
      // Leave the last success badge visible briefly, then clear.
      setTimeout(() => {
        const cur = useAgentStore.getState().liveTool;
        if (cur && cur.status !== "running") {
          useAgentStore.getState().setLiveTool(null);
        }
      }, 1_200);
      break;
    default: {
      // Defensive: if the server adds an event type the client doesn't
      // know about, surface it so we notice during dev rather than
      // silently swallowing. Cast through unknown because the switch
      // exhausted the discriminated union.
      const unknownEvent = event as { type?: unknown };
      log.warn("unknown SSE event", { type: unknownEvent.type });
      break;
    }
  }
}

function extractErrorText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return (output as Array<{ type?: string; text?: string }>)
      .map((b) => b.text ?? "")
      .filter(Boolean)
      .join(" ");
  }
  if (output && typeof output === "object") return JSON.stringify(output);
  return String(output ?? "");
}

/** Map a bare (un-prefixed) tool name to its UI section. The caller is
 *  responsible for stripping `mcp__alta__` before calling — keep the
 *  prefix-handling in one place. */
function sectionForTool(t: string): SectionKey | null {
  if (t.includes("workflow")) return "workflow";
  if (t.includes("voice")) return "voice";
  if (t.includes("language") || t.includes("tts_model")) return "voice";
  if (t.includes("llm") || t.includes("temperature")) return "llm";
  if (t.includes("knowledge_base") || t.includes("scrape")) return "knowledge_base";
  if (t.includes("data_collection")) return "data";
  // `*_call_outcome` lives in the post-call-analysis capability and surfaces
  // under the "Call outcomes" tab. The route must be matched BEFORE the
  // generic `tool` substring rule below, otherwise add_call_outcome would
  // get routed to the Tools tab.
  if (t.includes("call_outcome") || t.includes("evaluation")) return "evaluation";
  if (t.includes("phone") || t.includes("outbound_call")) return "phone";
  if (t.includes("mcp")) return "mcp";
  if (t.includes("tool")) return "tools";
  if (t.includes("name")) return "name";
  if (t.includes("first_message")) return "first_message";
  if (t.includes("system_prompt")) return "system_prompt";
  if (t.includes("max_duration")) return "limits";
  return null;
}

function sectionForPatchKey(key: string): SectionKey | null {
  switch (key) {
    case "name":
      return "name";
    case "system_prompt":
      return "system_prompt";
    case "first_message":
      return "first_message";
    case "voice_id":
    case "voice_settings":
    case "tts_model":
    case "language":
      return "voice";
    case "llm":
    case "temperature":
      return "llm";
    case "knowledge_base":
      return "knowledge_base";
    case "tools":
      return "tools";
    case "mcp_servers":
      return "mcp";
    case "data_collection":
      return "data";
    case "evaluation_criteria":
      return "evaluation";
    case "phone_numbers":
      return "phone";
    case "max_duration_seconds":
      return "limits";
    default:
      return null;
  }
}
