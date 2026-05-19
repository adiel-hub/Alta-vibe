import type { CallEvent, CallLogDetail } from "@/types/agent";
import { BASE_URL } from "../core/constants";
import { elFetch } from "../core/fetch";

export async function getConversationDetail(
  conversationId: string,
): Promise<CallLogDetail> {
  const res = await elFetch(`/v1/convai/conversations/${conversationId}`, {
    method: "GET",
    section: "call_detail",
  });
  const json = (await res.json()) as {
    conversation_id: string;
    agent_id: string;
    metadata: {
      start_time_unix_secs: number;
      call_duration_secs: number;
      from_number?: string;
      text_only?: boolean;
      phone_call?: { external_number?: string } | null;
    };
    status: string;
    transcript?: Array<{
      role: "user" | "agent" | "system";
      message: string | null;
      time_in_call_secs?: number;
      interrupted?: boolean;
      tool_calls?: Array<{
        tool_name?: string;
        request_id?: string;
        type?: string;
        params_as_json?: string;
        tool_details?: unknown;
      }>;
      tool_results?: Array<{
        tool_name?: string;
        request_id?: string;
        type?: string;
        is_error?: boolean;
        result_value?: unknown;
        tool_has_been_called?: boolean;
      }>;
    }>;
    analysis?: {
      transcript_summary?: string;
      call_successful?: boolean;
      evaluation_criteria_results?: Record<
        string,
        { result: string; rationale?: string }
      >;
      data_collection_results?: Record<string, { value: unknown }>;
    };
    has_audio?: boolean;
    has_user_audio?: boolean;
    has_response_audio?: boolean;
  };
  const evaluation = json.analysis?.evaluation_criteria_results
    ? Object.entries(json.analysis.evaluation_criteria_results).map(([name, v]) => ({
        name,
        passed: v.result === "success",
        rationale: v.rationale,
      }))
    : [];
  const dataCollection = json.analysis?.data_collection_results
    ? Object.entries(json.analysis.data_collection_results).map(([name, v]) => ({
        name,
        value: v.value,
      }))
    : [];
  const isTextOnly = json.metadata.text_only === true;
  const hasRealAudio = !isTextOnly && (json.has_audio ?? false);
  return {
    id: json.conversation_id,
    agent_id: json.agent_id,
    start_time: new Date(json.metadata.start_time_unix_secs * 1000).toISOString(),
    duration_seconds: json.metadata.call_duration_secs,
    status: json.status,
    outcome: json.analysis?.transcript_summary ?? null,
    call_successful: json.analysis?.call_successful ?? null,
    caller:
      json.metadata.phone_call?.external_number ??
      json.metadata.from_number ??
      null,
    has_recording: hasRealAudio,
    transcript:
      json.transcript?.map((t) => ({
        role: t.role,
        message: t.message ?? "",
        time_in_call_seconds: t.time_in_call_secs,
      })) ?? [],
    events: buildCallEvents(json.transcript),
    recording_url: hasRealAudio
      ? `${BASE_URL}/v1/convai/conversations/${conversationId}/audio`
      : null,
    analysis: {
      summary: json.analysis?.transcript_summary,
      evaluation,
      data_collection: dataCollection,
    },
  };
}

/**
 * Flatten ElevenLabs' nested transcript into a chronological event log.
 * Each transcript item can carry a message, an array of tool_calls, AND
 * an array of tool_results. We emit one CallEvent per leaf so the events
 * tab can render them in order on a single timeline. params_as_json is
 * parsed best-effort; if it isn't valid JSON we surface the raw string
 * so debugging never loses the upstream payload.
 */
function buildCallEvents(
  transcript:
    | Array<{
        role: "user" | "agent" | "system";
        message: string | null;
        time_in_call_secs?: number;
        interrupted?: boolean;
        tool_calls?: Array<{
          tool_name?: string;
          request_id?: string;
          type?: string;
          params_as_json?: string;
          tool_details?: unknown;
        }>;
        tool_results?: Array<{
          tool_name?: string;
          request_id?: string;
          type?: string;
          is_error?: boolean;
          result_value?: unknown;
          tool_has_been_called?: boolean;
        }>;
      }>
    | undefined,
): CallEvent[] {
  if (!transcript) return [];
  const events: CallEvent[] = [];
  for (const item of transcript) {
    const t = item.time_in_call_secs ?? 0;
    const trimmed = (item.message ?? "").trim();
    if (trimmed.length > 0) {
      events.push({
        kind: "message",
        time_in_call_seconds: t,
        role: item.role,
        message: trimmed,
        interrupted: item.interrupted,
      });
    }
    for (const call of item.tool_calls ?? []) {
      let params: unknown = call.params_as_json ?? null;
      if (typeof call.params_as_json === "string") {
        try {
          params = JSON.parse(call.params_as_json);
        } catch {
          params = call.params_as_json;
        }
      }
      events.push({
        kind: "tool_call",
        time_in_call_seconds: t,
        tool_name: call.tool_name ?? "unknown",
        params,
        request_id: call.request_id,
        tool_type: call.type,
      });
    }
    for (const result of item.tool_results ?? []) {
      events.push({
        kind: "tool_result",
        time_in_call_seconds: t,
        tool_name: result.tool_name,
        request_id: result.request_id,
        is_error: !!result.is_error,
        result: result.result_value,
        tool_type: result.type,
      });
    }
  }
  return events;
}
