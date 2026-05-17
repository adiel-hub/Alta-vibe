"use client";

import { nanoid } from "nanoid";
import type { SSEEvent } from "@/types/agent";
import { SECTION_FOR_TOOL, useAgentStore } from "./agentStore";

/**
 * POSTs the user message to the chat SSE endpoint and dispatches every parsed
 * event into the Zustand store. Resolves when the stream finishes.
 */
export async function streamChat(agentId: string, userText: string): Promise<void> {
  const store = useAgentStore.getState();
  const userTurnId = nanoid();
  const assistantTurnId = nanoid();
  store.appendUserTurn(userTurnId, userText);
  store.appendAssistantDelta(assistantTurnId, "");

  const secret = process.env.NEXT_PUBLIC_APP_SHARED_SECRET;
  const res = await fetch(`/api/agents/${agentId}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-app-secret": secret } : {}),
    },
    body: JSON.stringify({ text: userText }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Chat stream failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleBlock(assistantTurnId, block);
    }
  }
  useAgentStore.getState().finalizeAssistantTurn();
}

function handleBlock(assistantTurnId: string, block: string) {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let event: SSEEvent;
  try {
    event = JSON.parse(data) as SSEEvent;
  } catch {
    return;
  }
  const s = useAgentStore.getState();
  switch (event.type) {
    case "assistant_delta":
      s.appendAssistantDelta(assistantTurnId, event.text);
      break;
    case "tool_call_start": {
      const section = SECTION_FOR_TOOL[event.name];
      if (section) s.setInFlight(section, true);
      s.appendToolCallStart(assistantTurnId, event.tool_use_id, event.name, event.input);
      break;
    }
    case "tool_call_result":
      s.appendToolCallResult(
        assistantTurnId,
        event.tool_use_id,
        event.output,
        event.is_error,
      );
      break;
    case "state_patch":
      s.applyPatch(event.revision, event.patch);
      // best-effort: clear in-flight for sections touched by this patch
      for (const key of Object.keys(event.patch)) {
        const section = mapPatchKeyToSection(key);
        if (section) s.setInFlight(section, false);
      }
      break;
    case "state_error":
      s.setError(event.section, event.message);
      break;
    case "turn_aborted":
      break;
    case "turn_done":
      // clear any stuck in-flight markers
      for (const sec of Array.from(s.inFlight)) s.setInFlight(sec, false);
      break;
  }
}

import type { SectionKey } from "./agentStore";

function mapPatchKeyToSection(key: string): SectionKey | null {
  switch (key) {
    case "name":
      return "name";
    case "system_prompt":
      return "system_prompt";
    case "first_message":
      return "first_message";
    case "voice_id":
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
    default:
      return null;
  }
}
