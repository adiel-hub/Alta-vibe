import type { ObjectId } from "mongodb";

export type KnowledgeBaseDocument = {
  id: string;
  name: string;
  type: "url" | "file" | "text";
  source: string;
};

export type RuntimePhase = "pre_call" | "in_call" | "post_call";

export type RuntimeTool = {
  id: string;
  name: string;
  type: "webhook" | "client" | "system";
  description: string;
  phase: RuntimePhase;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  url?: string;
  parameters?: unknown;
};

export type McpIntegration = {
  id: string;
  name: string;
  url: string;
};

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
};

export type DataCollectionField = {
  id: string;
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
};

export type EvaluationCriterion = {
  id: string;
  name: string;
  prompt: string;
};

export type PhoneNumber = {
  id: string;
  number: string;
  provider: string;
  label?: string;
};

export type AgentConfigCache = {
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
  voice_settings: VoiceSettings;
  tts_model: string;
  language: string;
  llm: string;
  temperature: number;
  max_duration_seconds: number;
  knowledge_base: KnowledgeBaseDocument[];
  tools: RuntimeTool[];
  mcp_servers: McpIntegration[];
  data_collection: DataCollectionField[];
  evaluation_criteria: EvaluationCriterion[];
  phone_numbers: PhoneNumber[];
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0.0,
  use_speaker_boost: true,
  speed: 1.0,
};

export type AgentLastError = {
  at: string;
  op: string;
  status: number;
  message: string;
} | null;

export type AgentDocument = {
  _id: ObjectId;
  elevenlabs_agent_id: string;
  name: string;
  description: string;
  revision: number;
  config_cache: AgentConfigCache;
  last_error: AgentLastError;
  created_at: Date;
  updated_at: Date;
};

export type AgentDTO = Omit<AgentDocument, "_id" | "created_at" | "updated_at"> & {
  id: string;
  created_at: string;
  updated_at: string;
};

// --- Anthropic content blocks (persisted verbatim)
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  output: unknown;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type ChatMessageDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  role: "user" | "assistant";
  content: ContentBlock[];
  turn_job_id?: ObjectId;
  revision_before: number;
  revision_after: number;
  created_at: Date;
};

export type ChatMessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  turn_job_id?: string;
  revision_before: number;
  revision_after: number;
  created_at: string;
};

// --- SSE event vocabulary
export type SSEEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call_start"; tool_use_id: string; name: string; input: unknown }
  | {
      type: "tool_call_result";
      tool_use_id: string;
      output: unknown;
      is_error?: boolean;
    }
  | {
      type: "state_patch";
      revision: number;
      patch: Partial<AgentConfigCache>;
    }
  | { type: "state_error"; section: string; message: string }
  | { type: "turn_aborted"; reason: string }
  | { type: "turn_done"; revision: number };

// --- Backend-persistent turn jobs (refresh-safe streaming)
export type TurnJobStatus = "queued" | "running" | "done" | "failed";

export type StoredTurnEvent = {
  seq: number;
  at: Date;
  event: SSEEvent;
};

export type TurnJobDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  status: TurnJobStatus;
  user_message: string;
  events: StoredTurnEvent[];
  next_seq: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
};

export type TurnJobSummary = {
  id: string;
  agent_id: string;
  status: TurnJobStatus;
  user_message: string;
  next_seq: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

// --- Call logs (proxied from voice provider)
export type CallLogSummary = {
  id: string;
  agent_id: string;
  start_time: string;
  duration_seconds: number;
  status: string;
  outcome: string | null;
  call_successful: boolean | null;
  caller: string | null;
  has_recording: boolean;
};

export type CallLogDetail = CallLogSummary & {
  transcript: Array<{
    role: "user" | "agent" | "system";
    message: string;
    time_in_call_seconds?: number;
  }>;
  recording_url: string | null;
  analysis: {
    summary?: string;
    evaluation?: Array<{ name: string; passed: boolean; rationale?: string }>;
    data_collection?: Array<{ name: string; value: unknown }>;
  };
};
