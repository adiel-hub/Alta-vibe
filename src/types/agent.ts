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
  /** Human-readable title for UI display (e.g. "Order number"). Local-only —
   *  ElevenLabs has no label concept, so this is preserved across upstream
   *  projection by id lookup against the existing config_cache. */
  label?: string;
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
  /** Human-readable title for UI display (e.g. "Caller verified identity").
   *  Local-only — stripped before upstream PATCH and re-merged from the
   *  existing config on projection. */
  label?: string;
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

/**
 * Edge condition discriminated union. Matches ElevenLabs' four accepted
 * `forward_condition` / `backward_condition` variants:
 *   - "unconditional"  — always traverse
 *   - "llm"            — natural-language predicate evaluated by the LLM
 *   - "expression"     — deterministic AST evaluated against state (the
 *                        ASTNode shape is treated as an opaque JSON blob)
 *   - "result"         — branches on a `tool` node's success/failure
 */
export type WorkflowEdgeCondition =
  | { type: "unconditional"; label?: string }
  | { type: "llm"; condition: string; label?: string }
  | { type: "expression"; expression: unknown; label?: string }
  | { type: "result"; successful: boolean; label?: string };

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  /**
   * Legacy: free-text label rendered on the edge pill. New code should put
   * the label inside `forward_condition.label` so it matches the wire shape.
   * Kept here so cached agents authored before the structured condition
   * variants existed continue to render their pills.
   */
  label?: string;
  /**
   * Legacy: natural-language LLM condition. Equivalent to setting
   * `forward_condition: { type: "llm", condition }`. The serializer falls
   * back to this when `forward_condition` is absent.
   */
  condition?: string;
  forward_condition?: WorkflowEdgeCondition;
  /**
   * Backward edges enable loops without adding a flipped sibling edge —
   * the same physical edge is bi-directional, with two independent
   * conditions.
   */
  backward_condition?: WorkflowEdgeCondition;
};

/**
 * Tool binding. The workflow is the single source of truth for which tools
 * are attached to an agent — `config_cache.tools` is derived from these.
 *
 *   - provider: catalog tool from PROVIDERS (HubSpot, Slack, etc.)
 *   - custom:   tool synthesized by the builder (write_tool /
 *               create_custom_runtime_tool); persisted in `custom_tools`
 *
 * `elevenlabs_tool_id` is a registration receipt — cached so we don't
 * re-register on every save. Lifecycle bindings (pre/post-call) get a
 * `local_…` id since ElevenLabs never sees those tools.
 */
export type ToolBinding =
  | {
      kind: "provider";
      provider: string;
      /** Stable spec key on the provider (NOT the scoped wire name). */
      tool_key: string;
      phase: RuntimePhase;
      elevenlabs_tool_id: string;
      /**
       * Per-agent extra field mappings for pre-call enrichment tools that
       * declare `field_mapping` on their spec. Each entry pulls an extra
       * provider property (e.g. a custom HubSpot property) and projects it
       * into a dynamic variable. Local-only — never sent to ElevenLabs.
       */
      field_mappings?: Array<{ property: string; variable: string }>;
    }
  | {
      kind: "custom";
      custom_tool_id: string;
      phase: RuntimePhase;
      elevenlabs_tool_id: string;
    };

export type WorkflowState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /**
   * Tool bindings — the workflow's tool inventory. When set, this drives
   * `config_cache.tools` (derived). Undefined on legacy agents that
   * haven't been migrated yet; the agent GET route backfills on first
   * read by reverse-mapping the existing `config_cache.tools`.
   */
  bindings?: ToolBinding[];
  /**
   * Block sub-agent transfer cycles. Mirrors ElevenLabs'
   * `workflow.prevent_subagent_loops` top-level boolean — when true, a
   * `standalone_agent` transfer that would re-enter an agent already on
   * the transfer stack is rejected by the runtime.
   */
  prevent_subagent_loops?: boolean;
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
};

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0.0,
  use_speaker_boost: true,
  speed: 1.0,
};

export const DEFAULT_WORKFLOW: WorkflowState = {
  // id MUST be "start_node" — ElevenLabs' validator hardcodes that id as
  // the canonical start node. Any other id surfaces as the misleading
  // 422 "Workflow must contain a start node." from upstream.
  nodes: [{ id: "start_node", type: "start", label: "Call connects", data: {} }],
  edges: [],
};

export type AgentLastError = {
  at: string;
  op: string;
  status: number;
  message: string;
} | null;

/**
 * Distinguishes ordinary voice agents (the ones the user builds + tests + dials
 * with) from the workspace-singleton "audience_builder" agent that hosts the
 * /audiences chat. The audience_builder agent reuses the same chat / tool /
 * widget infrastructure but is excluded from the agent picker UI everywhere.
 * Older docs without this field are treated as "voice_agent".
 */
export type AgentKind = "voice_agent" | "audience_builder";

export type AgentDocument = {
  _id: ObjectId;
  elevenlabs_agent_id: string;
  name: string;
  description: string;
  revision: number;
  /** Defaults to "voice_agent" when unset. */
  kind?: AgentKind;
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

/**
 * Per-version metadata we generate ourselves (ElevenLabs' upstream
 * `version_description` is a meaningless "New version of your agent."
 * placeholder for every auto-version). A cheap Haiku call summarises the
 * recent chat + the patch's top-level keys into a short title +
 * description, persisted here so the version-history panel can show
 * something useful instead of the boilerplate.
 *
 * Keyed by (`elevenlabs_agent_id`, `version_id`). Backfilled lazily on
 * each successful PATCH — older versions that pre-date this feature have
 * no row and the UI falls back to "Version N".
 */
export type AgentVersionMetaDocument = {
  _id: ObjectId;
  elevenlabs_agent_id: string;
  version_id: string;
  title: string;
  description: string;
  /** Top-level fields the producing PATCH touched. Useful for debugging. */
  patch_keys: string[];
  generated_at: Date;
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
  /**
   * Set by panel-edit endpoints (workflow / config / KB / outcomes /
   * data-collection) so the chat UI can hide these synthetic messages
   * while the agent still receives them in its transcript on the next
   * turn. The user already sees the panel mutation directly in the UI,
   * so echoing it as a chat bubble is noise.
   */
  panel_action?: boolean;
  /**
   * Set only on messages belonging to the singleton `audience_builder`
   * agent. Splits its message log into independent chat threads so the
   * user can hold multiple audience-build conversations in parallel.
   * Voice-agent messages leave this unset and continue to share one
   * timeline per agent_id, exactly like before.
   */
  chat_session_id?: ObjectId;
};

/**
 * One audience-builder chat thread. The audience_builder agent itself is a
 * workspace singleton; sessions slice its message log so each chat has its
 * own transcript and can be resumed independently from the sidebar.
 */
export type AudienceChatSessionDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  /** First user message excerpt, used as the sidebar label. Updated lazily. */
  title: string;
  created_at: Date;
  updated_at: Date;
  /** Timestamp of the most recent message in this session — drives sidebar sort. */
  last_message_at: Date;
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
  | {
      /** Streamed mid-tool-call: the LLM is in the middle of writing one of
       *  the three persona-tab fields (`update_agent_name`,
       *  `update_first_message`, `update_system_prompt`) and we've extracted
       *  the in-progress value from the partial JSON. Lets the frontend show
       *  Alta typing the field out live instead of waiting for the tool to
       *  return a single state_patch with the finished string. */
      type: "tool_input_partial";
      tool_use_id: string;
      field: "name" | "first_message" | "system_prompt";
      value: string;
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
  | "phone_number_setup"
  | "select_prospects"
  | "audience_source_picker"
  | "csv_upload"
  | "launch_campaign";

export type WidgetActionDocument = {
  _id: ObjectId;
  agent_id: ObjectId;
  turn_job_id: ObjectId | null;
  kind: WidgetKind;
  payload: unknown;
  status: "pending" | "done" | "cancelled" | "failed";
  result: unknown | null;
  /** tool_use_id of the assistant tool_use block that produced this widget.
   * Stamped server-side during turn forwarding (user.ts) by parsing the
   * widget tool's result text for `action_id=...`. Hydration reads this
   * back so the ChatPanel renders the widget inline next to its tool_use
   * block instead of as an orphan at the top of the chat. */
  tool_use_id?: string | null;
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
  /**
   * Pre-call only: variable names this tool requires in the merged context
   * before it can run. Drives the wave dispatcher's topological ordering.
   * Undefined / empty array = wave 1 (depends only on baseline CallerContext).
   */
  needs?: string[];
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

// --- Prospects / Audiences / Campaigns ----------------------------------
// Workspace-global outbound calling primitives, sourced from People Data Labs.
// Prospects are deduped by their PDL id; an audience is just an ordered list
// of prospect ids; a campaign is one execution of an audience against one
// agent + phone number.

export type ProspectDocument = {
  _id: ObjectId;
  /** PDL person id — unique across the workspace. */
  pdl_id: string;
  full_name: string;
  job_title: string | null;
  job_company_name: string | null;
  location_name: string | null;
  /** E.164 mobile number when present — required to be dialable. */
  mobile_phone: string | null;
  /** Any other phone numbers PDL returned (work, home, etc.). */
  phone_numbers: string[];
  email: string | null;
  linkedin_url: string | null;
  /** Full raw PDL record stored for future re-enrichment / debugging. */
  raw: Record<string, unknown>;
  /**
   * User-tagged custom fields from CSV imports — e.g. {"Lead Score": "42"}.
   * Distinct from `raw`: only columns the user explicitly mapped as
   * "Custom" in the upload UI land here. Undefined for PDL / HubSpot rows.
   */
  custom_fields?: Record<string, string>;
  created_at: Date;
};

export type AudienceDocument = {
  _id: ObjectId;
  name: string;
  description: string;
  /** Stable order — newest-added prospects last. Treated as a set on write. */
  prospect_ids: ObjectId[];
  created_at: Date;
  updated_at: Date;
};

export type CallCampaignStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type CampaignItemStatus =
  | "queued"
  | "calling"
  | "done"
  | "failed"
  | "skipped";

export type CampaignItem = {
  prospect_id: ObjectId;
  /** Snapshot of the dialed number — prospects can be edited later. */
  to_number: string;
  status: CampaignItemStatus;
  conversation_id: string | null;
  error: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  /**
   * Flattened `data_collection` from ElevenLabs' post-call webhook. Stored
   * here so future pre-call enrichment (e.g. `alta_last_call_summary`) can
   * query the previous interaction with one Mongo round-trip.
   */
  data_collection?: Record<string, string | number | boolean | null>;
  completed_at?: Date | null;
};

export type CampaignEvent = {
  seq: number;
  at: Date;
  /** Discriminated event for the SSE tail. */
  event:
    | { type: "campaign_started"; total: number }
    | { type: "item_started"; prospect_id: string; to_number: string }
    | { type: "item_done"; prospect_id: string; conversation_id: string }
    | { type: "item_failed"; prospect_id: string; error: string }
    | { type: "item_skipped"; prospect_id: string; reason: string }
    | { type: "pre_call_aborted"; prospect_id: string; tool: string; reason: string }
    | { type: "pre_call_tool_failed"; prospect_id: string; tool: string; error: string }
    | { type: "campaign_done"; status: CallCampaignStatus };
};

/**
 * Audit trail for one pre-call dispatch. Records which tools ran, which
 * were skipped (and why), how long it took, and whether the call was
 * aborted before dial. Used for debugging enrichment regressions without
 * digging through log lines.
 */
export type PreCallExecutionDoc = {
  _id: ObjectId;
  agent_id: ObjectId;
  campaign_id: ObjectId | null;
  prospect_id: ObjectId | null;
  to_number: string;
  conversation_id: string | null;
  status: "ok" | "aborted";
  abort_reason: string | null;
  executed: string[];
  skipped: Array<{ tool: string; reason: string }>;
  variables_count: number;
  duration_ms: number;
  started_at: Date;
  ended_at: Date;
};

export type CallCampaignDocument = {
  _id: ObjectId;
  audience_id: ObjectId;
  agent_id: ObjectId;
  agent_phone_number_id: string;
  status: CallCampaignStatus;
  /** How many prospects we're willing to be on the phone with at once. */
  concurrency: number;
  items: CampaignItem[];
  events: CampaignEvent[];
  next_seq: number;
  /** Heartbeat — bumped whenever the runner makes progress. */
  last_event_at: Date;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
};
