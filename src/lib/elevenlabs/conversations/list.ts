import type { CallLogSummary } from "@/types/agent";
import { elFetch } from "../core/fetch";

export async function listConversations(
  agentId: string,
  limit = 30,
): Promise<CallLogSummary[]> {
  const url = `/v1/convai/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=${limit}`;
  const res = await elFetch(url, { method: "GET", section: "call_logs" });
  const json = (await res.json()) as {
    conversations: Array<{
      conversation_id: string;
      agent_id: string;
      start_time_unix_secs: number;
      call_duration_secs: number;
      status: string;
      call_successful?: boolean | null;
      message_count?: number;
      transcript_summary?: string;
      direction?: string;
      from_number?: string;
      has_audio?: boolean;
      text_only?: boolean;
      phone_call?: { external_number?: string } | null;
    }>;
  };
  return json.conversations.map((c) => ({
    id: c.conversation_id,
    agent_id: c.agent_id,
    start_time: new Date(c.start_time_unix_secs * 1000).toISOString(),
    duration_seconds: c.call_duration_secs,
    status: c.status,
    outcome: c.transcript_summary ?? null,
    call_successful: c.call_successful ?? null,
    caller: c.phone_call?.external_number ?? c.from_number ?? null,
    has_recording: !c.text_only && (c.has_audio ?? false),
  }));
}
