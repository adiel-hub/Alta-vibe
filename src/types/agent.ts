import type { ObjectId } from "mongodb";

// --- Voice agent configuration ---------------------------------------------

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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  parameters?: unknown;
  /** Optional provenance: which integration provider registered this tool. */
  provider?: string;
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

export type DataCollectionFieldType = "string" | "number" | "integer" | "boolean";

export type DataCollectionField = {
  id: string;
  name: string;
  type: DataCollectionFieldType;
  description: string;
  /** When set, the extracted value must be exactly one of these. Treated as
   *  a JSON-schema-style enum constraint: sent on the wire to ElevenLabs and
   *  ALSO baked into the description ("Must be exactly one of: …") so the
   *  LLM extractor respects it even if upstream ignores the enum field. */
  enum?: string[];
};

/**
 * A "Call Outcome" / "Success Criterion" — a yes/no goal scored against the
 * transcript after the call. Maps 1:1 to ElevenLabs' `PromptEvaluationCriteria`
 * inside `platform_settings.evaluation.criteria` (their UI labels these "Call
 * Outcomes" / "Success Criteria"). `prompt` is the conversation_goal_prompt on
 * the wire — kept named `prompt` in our cache for back-compat with older docs.
 */
export type EvaluationCriterion = {
  id: string;
  name: string;
  prompt: string;
  use_knowledge_base?: boolean;
  /** "conversation" uses the full transcript; "agent" only the active portion. */
  scope?: "conversation" | "agent";
};

export type PhoneNumber = {
  id: string;
  number: string;
  provider: string;
  label?: string;
};

// --- Workflow graph --------------------------------------------------------

export type WorkflowNodeType =
  | "start"
  | "speak"
  | "collect"
  | "tool_call"
  | "condition"
  | "transfer"
  | "end";

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  label: string;
  /** Free-form data per node type (prompt, tool_id, collect_field, condition, etc). */
  data: Record<string, unknown>;
  /** Layout hint; consumed by the right-panel renderer. Auto-laid-out by default. */
  position?: { x: number; y: number };
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  label?: string;
  condition?: string;
};

export type WorkflowState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

// --- Connected integrations (third-party providers) -----------------------

export type ConnectedIntegration = {
  id: string;
  provider: string;
  display_name: string;
  status: "connected" | "disconnected" | "expired";
  connected_at: string | null;
};

// --- Aggregate config ------------------------------------------------------

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
  workflow: WorkflowState;
  integrations: ConnectedIntegration[];
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0.0,
  use_speaker_boost: true,
  speed: 1.0,
};

export const DEFAULT_WORKFLOW: WorkflowState = {
  nodes: [{ id: "start", type: "start", label: "Call connects", data: {} }],
  edges: [],
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
  /**
   * Cached id of the upstream `main` branch — lazily backfilled the first
   * time we hit ElevenLabs' branches endpoint for this agent. Old documents
   * keep working with this null (we just look it up on demand).
   */
  main_branch_id?: string | null;
  /**
   * Opaque `agtvrsn_…` id of the version we last synced from upstream.
   * Best-effort: we update it from PATCH responses where it's present, but
   * the version-history UI doesn't depend on this — it always pulls fresh
   * from ElevenLabs and treats the topmost (newest) entry as current.
   */
  current_version_id?: string | null;
  /** Rolling summary of conversation turns older than the live window. */
  conversation_summary?: string | null;
  /** Most recent chat_message _id covered by conversation_summary. */
  summary_through_message_id?: ObjectId | null;
  created_at: Date;
  updated_at: Date;
};

export type AgentDTO = Omit<AgentDocument, "_id" | "created_at" | "updated_at"> & {
  id: string;
  created_at: string;
  updated_at: string;
};

// --- Anthropic content blocks (persisted verbatim) ------------------------

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
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  turn_job_id?: ObjectId;
  revision_before: number;
  revision_after: number;
  created_at: Date;
};

export type ChatMessageDTO = {
  id: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  turn_job_id?: string;
  revision_before: number;
  revision_after: number;
  created_at: string;
};

// --- SSE event vocabulary --------------------------------------------------

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
  | {
      type: "widget_inserted";
      action_id: string;
      kind: WidgetKind;
      payload: unknown;
    }
  | {
      type: "widget_resolved";
      action_id: string;
      status: "done" | "cancelled" | "failed";
      result: unknown;
    }
  | { type: "state_error"; section: string; message: string }
  | { type: "turn_aborted"; reason: string }
  | { type: "turn_done"; revision: number };

// --- Backend-persistent turn jobs (refresh-safe streaming) ----------------

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
  /** Updated on every event push; watchdog reaps jobs idle > N seconds. */
  last_event_at: Date;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
};

// --- Widget actions (interactive chat components) ------------------------

export type WidgetKind =
  | "connect_integration"
  | "confirm"
  | "pick_option"
  | "collect_secret"
  | "phone_number_setup";

export type WidgetActionDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  turn_job_id: ObjectId | null;
  kind: WidgetKind;
  payload: unknown;
  status: "pending" | "done" | "cancelled" | "failed";
  result: unknown | null;
  created_at: Date;
  resolved_at: Date | null;
};

// --- Agent secrets (free-form per-agent credentials, not tied to a provider) -

/**
 * An arbitrary credential the agent collected from the user (API key,
 * webhook URL, signing secret, etc.). Distinct from `IntegrationDocument`,
 * which is tied to a known provider in PROVIDERS. Generated runtime tools
 * reference these by `name`; the actual ciphertext is decrypted at use
 * time via `getAgentSecret`.
 */
export type AgentSecretDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  /** Stable handle the agent uses in tool code (e.g. "closepush_api_key"). */
  name: string;
  /** Free-text description the agent wrote when requesting the secret. */
  description: string;
  /** Encrypted blob — produced by encryptToken(). Never returned over the API. */
  ciphertext: string;
  created_at: Date;
  updated_at: Date;
};

// --- Custom tools (agent-generated runtime tools for unknown services) ---

/**
 * Spec for an agent-generated runtime tool that targets a service not in
 * PROVIDERS. ElevenLabs sees a thin webhook pointing at our proxy with
 * only a `proxy_secret` bearer; the proxy reads this doc and reconstructs
 * the upstream request, substituting `{{secret:<name>}}` placeholders with
 * decrypted values from `agent_secrets` at call time.
 *
 * The point of this indirection: a leak of the ElevenLabs tool config
 * never exposes the user's third-party credentials.
 */
export type CustomToolDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  /** Scoped name as registered on ElevenLabs (matches RuntimeTool.name). */
  name: string;
  description: string;
  phase: RuntimePhase;
  /** Bearer the proxy verifies before forwarding upstream. */
  proxy_secret: string;
  /** ElevenLabs tool id (returned from createRuntimeTool). */
  elevenlabs_tool_id: string;
  /** Synthesized upstream spec. */
  upstream: {
    url: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** Header template; values may contain `{{secret:<name>}}` placeholders. */
    headers: Record<string, string>;
    /** Optional request body JSON schema (forwarded as-is). */
    body_schema?: unknown;
    /** Optional query params JSON schema. */
    query_schema?: unknown;
  };
  /** Names of secrets referenced in the headers (for fast pre-flight checks). */
  secret_refs: string[];
  created_at: Date;
  updated_at: Date;
};

// --- Integrations (per-agent credentials) --------------------------------

export type IntegrationDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  provider: string;
  status: "connected" | "disconnected" | "expired";
  credentials: Record<string, unknown>;
  metadata: Record<string, unknown>;
  connected_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// --- Call logs --------------------------------------------------------------

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

/**
 * Chronological event in a call, derived from the ElevenLabs transcript.
 * `time_in_call_seconds` is the same clock the transcript uses, so events
 * can be interleaved with bubble messages on a single timeline.
 */
export type CallEvent =
  | {
      kind: "message";
      time_in_call_seconds: number;
      role: "user" | "agent" | "system";
      message: string;
      interrupted?: boolean;
    }
  | {
      kind: "tool_call";
      time_in_call_seconds: number;
      tool_name: string;
      params: unknown;
      request_id?: string;
      tool_type?: string;
    }
  | {
      kind: "tool_result";
      time_in_call_seconds: number;
      tool_name?: string;
      request_id?: string;
      is_error: boolean;
      result: unknown;
      tool_type?: string;
    };

export type CallLogDetail = CallLogSummary & {
  transcript: Array<{
    role: "user" | "agent" | "system";
    message: string;
    time_in_call_seconds?: number;
  }>;
  /** Chronological tool + message events for the monitoring view. */
  events: CallEvent[];
  recording_url: string | null;
  analysis: {
    summary?: string;
    evaluation?: Array<{ name: string; passed: boolean; rationale?: string }>;
    data_collection?: Array<{ name: string; value: unknown }>;
  };
};
