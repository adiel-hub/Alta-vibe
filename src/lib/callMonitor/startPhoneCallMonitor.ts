/**
 * Client-side driver that makes a PHONE call track live in the Workflow tab,
 * mirroring the in-browser web call lifecycle in TestCallButton.
 *
 * The web call freezes the graph with `callMonitorStore.start()` then feeds
 * `ingest()` from the `@elevenlabs/react` SDK's `onAgentToolResponse`. A phone
 * call has no browser SDK session, so we instead attach to the server-side SSE
 * bridge (which forwards ElevenLabs' monitoring socket) and pipe its frames
 * into the SAME store. Everything downstream — node/edge highlight, camera
 * follow, and the Workflow-tab auto-open on idle→live (VisualPanel) — is reused
 * unchanged.
 */
import { appFetch } from "@/lib/apiClient";
import { useAgentStore } from "@/store/agentStore";
import { useCallMonitorStore } from "@/store/callMonitorStore";
import type { EngineEvent } from "@/lib/callMonitor/types";

/**
 * Begin live-tracking `conversationId`. No-ops (returns a noop stopper) if the
 * agent has no workflow to track. Returns a `stop()` that detaches the stream.
 */
export function startPhoneCallMonitor(
  agentId: string,
  conversationId: string,
): () => void {
  const workflow = useAgentStore.getState().config?.workflow;
  if (!workflow) return () => {};

  const store = useCallMonitorStore.getState();
  store.start(workflow); // freeze graph + flip status to "live" (opens the tab)
  store.setConversationId(conversationId);

  const controller = new AbortController();

  void (async () => {
    try {
      const res = await appFetch(
        `/api/agents/${agentId}/calls/${encodeURIComponent(
          conversationId,
        )}/monitor/stream`,
        { signal: controller.signal },
      );
      if (!res.ok || !res.body) {
        throw new Error(`monitor stream failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = parseBlock(block);
          if (ev) useCallMonitorStore.getState().ingest(ev);
        }
      }
    } catch {
      // aborted or network error — fall through to mark the call ended
    } finally {
      useCallMonitorStore.getState().ingest({ kind: "disconnect" });
    }
  })();

  return () => controller.abort();
}

/** Parse one SSE block into an EngineEvent, or null for comments/heartbeats. */
function parseBlock(block: string): EngineEvent | null {
  let data: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) return null; // heartbeat comment
    if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as EngineEvent;
    if (
      parsed &&
      (parsed.kind === "tool_response" ||
        parsed.kind === "disconnect" ||
        parsed.kind === "connect")
    ) {
      return parsed;
    }
  } catch {
    /* malformed frame */
  }
  return null;
}
