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

const log = createClientLogger("sse-client");

/**
 * Send a user message. Backend immediately persists the user turn + creates a
 * turn_job, then starts background processing. We attach to the turn's SSE
 * stream and drive the store from its events. If the user refreshes mid-turn,
 * the page can call `attachToTurn(jobId, since)` to rejoin from any seq.
 */
export async function sendMessage(agentId: string, userText: string): Promise<string> {
  log.info("send", { agent_id: agentId, text_len: userText.length });
  const store = useAgentStore.getState();
  const userTurnId = nanoid();
  const assistantTurnId = nanoid();
  store.appendUserTurn(userTurnId, userText);
  store.appendAssistantDelta(assistantTurnId, "");

  const res = await appFetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: userText }),
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
 */
export async function attachToTurn(
  agentId: string,
  jobId: string,
  since: number,
  assistantTurnIdOverride?: string,
): Promise<void> {
  log.info("attach", { agent_id: agentId, job_id: jobId, since });
  const store = useAgentStore.getState();
  let assistantTurnId = assistantTurnIdOverride ?? store.activeAssistantTurnId;
  if (!assistantTurnId) {
    assistantTurnId = nanoid();
    store.appendAssistantDelta(assistantTurnId, "");
  }
  store.setActiveTurn(jobId, assistantTurnId);

  const secret = process.env.NEXT_PUBLIC_APP_SHARED_SECRET;
  const res = await fetch(
    `/api/agents/${agentId}/turns/${jobId}/stream?since=${since}`,
    {
      headers: secret ? { "x-app-secret": secret } : undefined,
    },
  );
  if (!res.ok || !res.body) {
    log.error("attach failed", { status: res.status });
    store.setActiveTurn(null, null);
    throw new Error(`Stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastSeq = since - 1;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseBlock(block);
      if (parsed && parsed.seq > lastSeq) {
        handleEvent(assistantTurnId, parsed.event);
        lastSeq = parsed.seq;
        useAgentStore.getState().setLastSeq(lastSeq);
      }
    }
  }
  log.info("stream end", { job_id: jobId, last_seq: lastSeq });
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

function handleEvent(assistantTurnId: string, event: SSEEvent): void {
  log.trace("event", { type: event.type });
  const s = useAgentStore.getState();
  switch (event.type) {
    case "assistant_delta":
      s.appendAssistantDelta(assistantTurnId, event.text);
      break;
    case "tool_call_start": {
      log.debug("tool_call_start", { name: event.name });
      // SDK internals: ToolSearch fires every turn to load our MCP tool
      // schemas. It's not a step the user cares about — swallow it so it
      // doesn't appear in the chat, in the live indicator, or in any
      // auto-switch decision.
      if (event.name === "ToolSearch") break;
      const section = sectionForTool(event.name);
      if (section) {
        s.setInFlight(section, true);
        // Auto-switch suppressions:
        //   - list_*/read_* are pure discovery; they shouldn't yank the panel.
        //   - scrape_* tools take ~30 s and the user is usually mid-thought
        //     on Persona; the KB tab can update silently in the background.
        const bare = event.name.replace(/^mcp__alta__/, "");
        const noAutoSwitch =
          /^(list_|read_|scrape_)/.test(bare);
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
      s.applyPatch(event.revision, event.patch);
      for (const key of Object.keys(event.patch)) {
        const section = sectionForPatchKey(key);
        if (section) s.setInFlight(section, false);
      }
      break;
    case "state_error":
      log.warn("state_error", { section: event.section, message: event.message });
      s.setError(event.section, event.message);
      break;
    case "widget_inserted":
      log.info("widget_inserted", {
        action_id: event.action_id,
        kind: event.kind,
      });
      s.upsertWidget({
        action_id: event.action_id,
        kind: event.kind,
        payload: event.payload,
        status: "pending",
        result: null,
      });
      break;
    case "widget_resolved":
      log.info("widget_resolved", {
        action_id: event.action_id,
        status: event.status,
      });
      s.resolveWidget(event.action_id, event.status, event.result);
      break;
    case "turn_aborted":
      log.warn("turn_aborted", { reason: event.reason });
      for (const sec of Array.from(s.inFlight)) s.setInFlight(sec, false);
      s.setLiveTool(null);
      break;
    case "turn_done":
      log.info("turn_done", { revision: event.revision });
      for (const sec of Array.from(s.inFlight)) s.setInFlight(sec, false);
      // Leave the last success badge visible briefly, then clear.
      setTimeout(() => {
        const cur = useAgentStore.getState().liveTool;
        if (cur && cur.status !== "running") {
          useAgentStore.getState().setLiveTool(null);
        }
      }, 1_200);
      break;
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

function sectionForTool(toolName: string): SectionKey | null {
  const t = toolName.replace(/^mcp__alta__/, "");
  if (t.includes("workflow")) return "workflow";
  if (t.includes("voice") || t === "list_available_voices") return "voice";
  if (t.includes("language") || t.includes("tts_model")) return "voice";
  if (t.includes("llm") || t.includes("temperature")) return "llm";
  if (t.includes("knowledge_base") || t.includes("scrape")) return "knowledge_base";
  if (t.includes("data_collection")) return "data";
  if (t.includes("evaluation")) return "evaluation";
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
