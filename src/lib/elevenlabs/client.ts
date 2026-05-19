import { deepMergeConfig } from "./patchConfig";
import { createLogger } from "@/lib/logger";

const log = createLogger("voice-provider");
import {
  DEFAULT_VOICE_SETTINGS,
  type AgentConfigCache,
  type CallLogDetail,
  type CallLogSummary,
  type DataCollectionField,
  type EvaluationCriterion,
  type KnowledgeBaseDocument,
  type McpIntegration,
  type PhoneNumber,
  type RuntimePhase,
  type RuntimeTool,
  type VoiceSettings,
} from "@/types/agent";

const BASE_URL = "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  status: number;
  section: string;
  body: unknown;
  constructor(status: number, section: string, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.section = section;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

function extractErrorMessage(body: unknown): string | null {
  if (typeof body === "string" && body.length > 0) return body;
  if (typeof body !== "object" || body === null) return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  // FastAPI/Pydantic validation errors: detail is an array of
  //   { loc: ["body", "tool_config", "api_schema", ...], msg, type }.
  // Flatten to "field.path: msg; field.path: msg" so callers see exactly
  // which part of the request ElevenLabs rejected — critical for debugging
  // 422s out of /v1/convai/tools where the failure is almost always a
  // schema/shape problem on a specific field.
  if (Array.isArray(detail)) {
    const items = (detail as unknown[])
      .map((it) => {
        if (typeof it !== "object" || it === null) return null;
        const msg = (it as { msg?: unknown }).msg;
        if (typeof msg !== "string") return null;
        const loc = (it as { loc?: unknown }).loc;
        const path = Array.isArray(loc)
          ? loc
              .filter((p) => p !== "body" && (typeof p === "string" || typeof p === "number"))
              .join(".")
          : "";
        return path ? `${path}: ${msg}` : msg;
      })
      .filter((s): s is string => s !== null);
    if (items.length > 0) return items.join("; ");
  }
  if (typeof detail === "object" && detail !== null) {
    const msg = (detail as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  const topMsg = (body as { message?: unknown }).message;
  if (typeof topMsg === "string") return topMsg;
  return null;
}

/**
 * Truncate a stringified payload so we can safely splat it into logs
 * without filling Vercel/Railway with megabytes of system_prompt copy.
 * Returns `value` for objects/arrays unchanged when small enough, or a
 * truncated string when over the limit.
 */
function logTrunc(value: unknown, limit = 4_000): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}… [truncated ${value.length - limit} chars]` : value;
  }
  try {
    const s = JSON.stringify(value);
    if (s.length <= limit) return value;
    return `${s.slice(0, limit)}… [truncated ${s.length - limit} chars]`;
  } catch {
    return String(value);
  }
}

async function elFetch(
  path: string,
  init: RequestInit & { section: string },
): Promise<Response> {
  const { section, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("xi-api-key", apiKey());
  if (!headers.has("accept")) headers.set("accept", "application/json");

  const method = rest.method ?? "GET";
  // Snapshot the outgoing body so we can attach it to error logs. We always
  // log a truncated copy on non-2xx so the engineer can immediately see
  // exactly what shape we sent that the provider rejected — the #1 cause
  // of 422 debug-time loss.
  const reqBodyRaw = typeof rest.body === "string" ? rest.body : null;
  let reqBodyParsed: unknown = null;
  if (reqBodyRaw) {
    try {
      reqBodyParsed = JSON.parse(reqBodyRaw);
    } catch {
      reqBodyParsed = reqBodyRaw;
    }
  }

  let attempt = 0;
  const t0 = Date.now();
  while (true) {
    log.debug("request", {
      method,
      path,
      section,
      attempt,
      body: logTrunc(reqBodyParsed),
    });
    const res = await fetch(`${BASE_URL}${path}`, { ...rest, headers });
    if (res.status === 429 && attempt < 3) {
      const wait = 2 ** attempt * 500;
      log.warn("rate limited; backing off", { path, section, attempt, wait });
      await new Promise((r) => setTimeout(r, wait));
      attempt++;
      continue;
    }
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = await res.text().catch(() => "");
      }
      const message = extractErrorMessage(body) ??
        `Voice provider ${section} request failed (${res.status})`;
      // Always include the raw upstream body + the body we sent. The
      // extracted message can be a generic fallback when the upstream
      // shape doesn't match `detail[]` — having the raw body is what
      // lets us diagnose those cases without re-running with more logs.
      log.error("response error", {
        method,
        path,
        section,
        status: res.status,
        ms: Date.now() - t0,
        message,
        upstream_body: logTrunc(body),
        request_body: logTrunc(reqBodyParsed),
      });
      throw new ElevenLabsError(res.status, section, message, body);
    }
    log.debug("response ok", {
      method,
      path,
      section,
      status: res.status,
      ms: Date.now() - t0,
    });
    return res;
  }
}

// --- Voices -----------------------------------------------------------------

export type ElevenVoice = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
};

let voicesCache: { at: number; data: ElevenVoice[] } | null = null;

export async function listVoices(force = false): Promise<ElevenVoice[]> {
  const TTL = 5 * 60 * 1000;
  if (!force && voicesCache && Date.now() - voicesCache.at < TTL) {
    return voicesCache.data;
  }
  const res = await elFetch("/v1/voices", { method: "GET", section: "voice" });
  const json = (await res.json()) as { voices: ElevenVoice[] };
  voicesCache = { at: Date.now(), data: json.voices };
  return json.voices;
}

// --- Models -----------------------------------------------------------------

export type TTSModel = {
  model_id: string;
  name: string;
  languages?: Array<{ language_id: string; name: string }>;
};

let modelsCache: { at: number; data: TTSModel[] } | null = null;

export async function listTtsModels(): Promise<TTSModel[]> {
  const TTL = 10 * 60 * 1000;
  if (modelsCache && Date.now() - modelsCache.at < TTL) return modelsCache.data;
  const res = await elFetch("/v1/models", { method: "GET", section: "models" });
  const json = (await res.json()) as TTSModel[];
  modelsCache = { at: Date.now(), data: json };
  return json;
}

// --- Agent CRUD -------------------------------------------------------------

export type ElevenAgentRaw = {
  agent_id: string;
  name?: string;
  conversation_config?: {
    agent?: {
      first_message?: string;
      language?: string;
      prompt?: {
        prompt?: string;
        llm?: string;
        temperature?: number;
        knowledge_base?: Array<{
          id: string;
          name: string;
          type: "url" | "file" | "text";
        }>;
        tools?: Array<{
          id?: string;
          name: string;
          type: "webhook" | "client" | "system";
          description?: string;
          response_timeout_secs?: number;
        }>;
        mcp_server_ids?: string[];
      };
    };
    tts?: {
      voice_id?: string;
      model_id?: string;
      stability?: number;
      similarity_boost?: number;
      style?: number;
      use_speaker_boost?: boolean;
      speed?: number;
    };
    asr?: { quality?: string };
    turn?: { turn_timeout?: number };
    conversation?: { max_duration_seconds?: number };
  };
  platform_settings?: {
    data_collection?: Record<
      string,
      {
        type: "string" | "number" | "integer" | "boolean";
        description: string;
        /** Optional JSON-schema-style value constraint. */
        enum?: string[];
      }
    >;
    evaluation?: {
      criteria?: Array<{
        id: string;
        name: string;
        type?: "prompt";
        /** Upstream's source-of-truth field for the goal prompt. */
        conversation_goal_prompt?: string;
        /** Legacy alias some older configs use. */
        prompt?: string;
        use_knowledge_base?: boolean;
        scope?: "conversation" | "agent";
      }>;
    };
  };
  phone_numbers?: Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
  }>;
  /**
   * Workflow graph the runtime walks during a call. Lives at the TOP
   * LEVEL of the agent body (not under conversation_config) — putting
   * it under conversation_config is silently ignored upstream.
   */
  workflow?: {
    nodes?: Record<string, unknown>;
    edges?: Record<string, unknown>;
    prevent_subagent_loops?: boolean;
  };
};

export async function createAgent(seed: {
  name: string;
  first_message: string;
  system_prompt: string;
  voice_id: string;
}): Promise<{ agent_id: string }> {
  const body = {
    name: seed.name,
    conversation_config: {
      agent: {
        first_message: seed.first_message,
        language: "en",
        prompt: {
          prompt: seed.system_prompt,
          llm: "gemini-2.0-flash",
        },
      },
      tts: {
        voice_id: seed.voice_id,
        model_id: "eleven_v3_conversational",
        ...DEFAULT_VOICE_SETTINGS,
      },
      conversation: { max_duration_seconds: 600 },
    },
  };
  const res = await elFetch("/v1/convai/agents/create", {
    method: "POST",
    section: "create",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { agent_id: string };
}

export async function getAgent(agentId: string): Promise<ElevenAgentRaw> {
  const res = await elFetch(`/v1/convai/agents/${agentId}`, {
    method: "GET",
    section: "read",
  });
  return (await res.json()) as ElevenAgentRaw;
}

export async function deleteAgent(agentId: string): Promise<void> {
  await elFetch(`/v1/convai/agents/${agentId}`, {
    method: "DELETE",
    section: "delete",
  });
}

// ── ElevenAgents Workflow schema (conversation_config.workflow) ─────────
//
// Spec reference (Sep 2025): https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows
// Nodes and edges are object-keyed maps (not arrays), unlike our internal
// WorkflowState model.

export type ElevenForwardCondition =
  | { type: "unconditional" }
  | { type: "llm"; condition: string }
  | { type: "expression"; condition: string };

export type ElevenWorkflowNode = {
  /** Node type recognised by the agent runtime. */
  type:
    | "start"
    | "end"
    | "override_agent"
    | "say"
    | "tool"
    | "standalone_agent"
    | "phone_number"
    | "update_state"
    // Legacy names kept for parsing old agents that haven't been
    // re-saved since ElevenLabs renamed the enum:
    //   dispatch_tool      → tool
    //   agent_transfer     → standalone_agent
    //   transfer_to_number → phone_number
    | "dispatch_tool"
    | "agent_transfer"
    | "transfer_to_number";
  /** Human-readable label for the visual editor. */
  label?: string;
  /**
   * Prompt fragment appended to the agent's system prompt while this node
   * is active. Most commonly used on `override_agent` nodes to give them
   * scoped instructions (e.g. "Help with the support request, then move on").
   */
  additional_prompt?: string;
  /**
   * Ordered list of outgoing edge ids. The runtime evaluates each edge's
   * forward_condition in order; the first one that matches wins.
   */
  edge_order?: string[];
  /** Free-form per-type config (tool_id, target_agent_id, phone_number, …). */
  [extra: string]: unknown;
};

export type ElevenWorkflowEdge = {
  source: string;
  target: string;
  forward_condition: ElevenForwardCondition;
};

export type ElevenWorkflow = {
  nodes: Record<string, ElevenWorkflowNode>;
  edges: Record<string, ElevenWorkflowEdge>;
};

export type AgentPatch = {
  name?: string;
  first_message?: string;
  system_prompt?: string;
  voice_id?: string;
  voice_settings?: Partial<VoiceSettings>;
  tts_model?: string;
  language?: string;
  llm?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: "low" | "medium" | "high";
  thinking_budget?: number;
  timezone?: string;
  disable_first_message_interruptions?: boolean;
  max_conversation_duration_message?: string;
  dynamic_variables?: Record<string, string>;
  max_duration_seconds?: number;
  text_only?: boolean;
  source_attribution?: boolean;
  knowledge_base?: Array<{
    id: string;
    name: string;
    type: "url" | "file" | "text";
  }>;
  /** Preferred way to attach tools: pass workspace tool ids. */
  tool_ids?: string[];
  mcp_server_ids?: string[];
  native_mcp_server_ids?: string[];
  data_collection?: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean";
      description: string;
      enum?: string[];
    }
  >;
  evaluation_criteria?: Array<{
    id: string;
    name: string;
    prompt: string;
    use_knowledge_base?: boolean;
    scope?: "conversation" | "agent";
  }>;
  // ASR
  asr_quality?: "high" | "low";
  asr_provider?: "elevenlabs" | "deepgram";
  asr_keywords?: string[];
  // Turn detection
  turn_timeout?: number;
  initial_wait_time?: number;
  silence_end_call_timeout?: number;
  turn_eagerness?: "low" | "standard" | "high";
  speculative_turn?: boolean;
  // v3 expressive
  expressive_mode?: boolean;
  suggested_audio_tags?: string[];
  agent_output_audio_format?: string;
  optimize_streaming_latency?: number;
  text_normalisation_type?: "system_prompt" | "elevenlabs" | "off";
  /**
   * Structured workflow graph stored at conversation_config.workflow.
   * Object-keyed maps (not arrays) per the ElevenAgents schema:
   *   nodes: { [id]: { type, label?, additional_prompt?, edge_order: string[], ... } }
   *   edges: { [id]: { source, target, forward_condition: { type, condition? } } }
   *
   * When set, the agent's runtime follows the graph itself — no need to
   * inline the workflow as text in the system prompt.
   */
  workflow?: ElevenWorkflow;
};

/**
 * Whitelist of Conversational AI TTS fields. Anything our `voice_settings`
 * object carries that isn't in this list is silently dropped on patch — this
 * keeps legacy fields (`style`, `use_speaker_boost`) from polluting the wire
 * payload to the Conversational AI endpoint, which only accepts a subset of
 * the standalone TTS API's settings.
 */
const TTS_WIRE_FIELDS = new Set([
  "stability",
  "similarity_boost",
  "speed",
]);

/**
 * Pairs of fields ElevenLabs treats as mutually exclusive inside
 * `conversation_config.agent.prompt`. Sending both halves in the same PATCH
 * body produces "Cannot specify both X and Y" 422s — left side is the modern
 * reference-by-id form (the one we always want to send), right side is the
 * deprecated inline form that lingers in stored agent state.
 */
const PROMPT_CONFLICT_PAIRS: ReadonlyArray<[modern: string, deprecated: string]> = [
  ["tool_ids", "tools"],
  ["mcp_server_ids", "mcp_servers"],
  ["native_mcp_server_ids", "native_mcp_servers"],
];

/**
 * Drop deprecated halves from a prompt slice if the modern counterpart is
 * present. Defends against a future capability accidentally producing both —
 * logs + drops rather than throwing so production never gets blocked by this.
 */
function scrubPromptConflicts(promptSlice: Record<string, unknown>): void {
  for (const [modern, deprecated] of PROMPT_CONFLICT_PAIRS) {
    if (modern in promptSlice && deprecated in promptSlice) {
      log.warn("dropping deprecated prompt field to avoid conflict", {
        modern,
        deprecated,
      });
      delete promptSlice[deprecated];
    }
  }
}

export async function patchAgent(
  agentId: string,
  patch: AgentPatch,
): Promise<ElevenAgentRaw> {
  const incoming: Record<string, unknown> = {};
  if (patch.name !== undefined) incoming.name = patch.name;

  // --- agent.prompt -------------------------------------------------------
  // We send ONLY the fields the caller explicitly set. ElevenLabs deep-merges
  // PATCH bodies on `conversation_config` so we don't need to echo back any
  // current state to preserve siblings. Echoing was the source of the
  // "Cannot specify both tools and tool IDs" 422s, because GET responses on
  // legacy agents echo both the deprecated inline `tools` array and the
  // modern `tool_ids`, and re-sending that pair is what ElevenLabs rejects.
  const agentSlice: Record<string, unknown> = {};
  if (patch.first_message !== undefined) agentSlice.first_message = patch.first_message;
  if (patch.language !== undefined) agentSlice.language = patch.language;
  if (patch.disable_first_message_interruptions !== undefined)
    agentSlice.disable_first_message_interruptions = patch.disable_first_message_interruptions;
  if (patch.max_conversation_duration_message !== undefined)
    agentSlice.max_conversation_duration_message = patch.max_conversation_duration_message;
  if (patch.dynamic_variables !== undefined) {
    agentSlice.dynamic_variables = {
      dynamic_variable_placeholders: patch.dynamic_variables,
    };
  }

  const promptSlice: Record<string, unknown> = {};
  if (patch.system_prompt !== undefined) promptSlice.prompt = patch.system_prompt;
  if (patch.llm !== undefined) promptSlice.llm = patch.llm;
  if (patch.temperature !== undefined) promptSlice.temperature = patch.temperature;
  if (patch.max_tokens !== undefined) promptSlice.max_tokens = patch.max_tokens;
  if (patch.reasoning_effort !== undefined)
    promptSlice.reasoning_effort = patch.reasoning_effort;
  if (patch.thinking_budget !== undefined)
    promptSlice.thinking_budget = patch.thinking_budget;
  if (patch.timezone !== undefined) promptSlice.timezone = patch.timezone;
  if (patch.knowledge_base !== undefined) promptSlice.knowledge_base = patch.knowledge_base;
  // Modern schema: reference tools / MCP servers by id, never inline. The
  // legacy `tools` / `mcp_servers` / `native_mcp_servers` arrays are
  // deprecated upstream and never sourced from our patch surface — but the
  // guard below catches them if a future caller slips one in.
  if (patch.tool_ids !== undefined) promptSlice.tool_ids = patch.tool_ids;
  if (patch.mcp_server_ids !== undefined) promptSlice.mcp_server_ids = patch.mcp_server_ids;
  if (patch.native_mcp_server_ids !== undefined)
    promptSlice.native_mcp_server_ids = patch.native_mcp_server_ids;
  scrubPromptConflicts(promptSlice);
  if (Object.keys(promptSlice).length > 0) agentSlice.prompt = promptSlice;

  // --- tts ----------------------------------------------------------------
  const ttsSlice: Record<string, unknown> = {};
  if (patch.voice_id !== undefined) ttsSlice.voice_id = patch.voice_id;
  if (patch.tts_model !== undefined) ttsSlice.model_id = patch.tts_model;
  if (patch.voice_settings) {
    for (const [k, v] of Object.entries(patch.voice_settings)) {
      if (v !== undefined && TTS_WIRE_FIELDS.has(k)) ttsSlice[k] = v;
    }
  }
  if (patch.expressive_mode !== undefined) ttsSlice.expressive_mode = patch.expressive_mode;
  if (patch.suggested_audio_tags !== undefined)
    ttsSlice.suggested_audio_tags = patch.suggested_audio_tags;
  if (patch.agent_output_audio_format !== undefined)
    ttsSlice.agent_output_audio_format = patch.agent_output_audio_format;
  if (patch.optimize_streaming_latency !== undefined)
    ttsSlice.optimize_streaming_latency = patch.optimize_streaming_latency;
  if (patch.text_normalisation_type !== undefined)
    ttsSlice.text_normalisation_type = patch.text_normalisation_type;

  // --- asr ----------------------------------------------------------------
  const asrSlice: Record<string, unknown> = {};
  if (patch.asr_quality !== undefined) asrSlice.quality = patch.asr_quality;
  if (patch.asr_provider !== undefined) asrSlice.provider = patch.asr_provider;
  if (patch.asr_keywords !== undefined) asrSlice.keywords = patch.asr_keywords;

  // --- turn ---------------------------------------------------------------
  const turnSlice: Record<string, unknown> = {};
  if (patch.turn_timeout !== undefined) turnSlice.turn_timeout = patch.turn_timeout;
  if (patch.initial_wait_time !== undefined)
    turnSlice.initial_wait_time = patch.initial_wait_time;
  if (patch.silence_end_call_timeout !== undefined)
    turnSlice.silence_end_call_timeout = patch.silence_end_call_timeout;
  if (patch.turn_eagerness !== undefined) turnSlice.turn_eagerness = patch.turn_eagerness;
  if (patch.speculative_turn !== undefined)
    turnSlice.speculative_turn = patch.speculative_turn;

  // --- conversation -------------------------------------------------------
  const conversationSlice: Record<string, unknown> = {};
  if (patch.max_duration_seconds !== undefined)
    conversationSlice.max_duration_seconds = patch.max_duration_seconds;
  if (patch.text_only !== undefined) conversationSlice.text_only = patch.text_only;
  if (patch.source_attribution !== undefined)
    conversationSlice.source_attribution = patch.source_attribution;

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agentSlice).length > 0) conversationConfig.agent = agentSlice;
  if (Object.keys(ttsSlice).length > 0) conversationConfig.tts = ttsSlice;
  if (Object.keys(asrSlice).length > 0) conversationConfig.asr = asrSlice;
  if (Object.keys(turnSlice).length > 0) conversationConfig.turn = turnSlice;
  if (Object.keys(conversationSlice).length > 0)
    conversationConfig.conversation = conversationSlice;
  // ElevenLabs deep-merges PATCH bodies on `conversation_config`, so we ship
  // only the slices the caller actually populated. No GET-then-echo: that's
  // exactly what re-introduced deprecated fields (`tools`, `mcp_servers`,
  // `native_mcp_servers`) from stored legacy state and triggered the
  // "Cannot specify both X and Y" 422s.
  if (Object.keys(conversationConfig).length > 0) {
    incoming.conversation_config = conversationConfig;
  }

  // --- platform_settings --------------------------------------------------
  const platformSlice: Record<string, unknown> = {};
  if (patch.data_collection !== undefined) {
    platformSlice.data_collection = patch.data_collection;
  }
  if (patch.evaluation_criteria !== undefined) {
    // Upstream expects PromptEvaluationCriteria: `conversation_goal_prompt` is
    // the required goal field; `prompt` is our internal alias.
    // Use `!= null` (not `!== undefined`) so a stray `null` from older configs
    // doesn't survive into the payload — ElevenLabs's Pydantic models type
    // these as non-nullable, so `null` triggers "Input should be a valid
    // boolean" on any PATCH that re-sends the list (e.g. remove_call_outcome
    // touching a sibling criterion with use_knowledge_base: null).
    platformSlice.evaluation = {
      criteria: patch.evaluation_criteria.map((c) => ({
        id: c.id,
        name: c.name,
        type: "prompt" as const,
        conversation_goal_prompt: c.prompt,
        ...(c.use_knowledge_base != null
          ? { use_knowledge_base: c.use_knowledge_base }
          : {}),
        ...(c.scope != null ? { scope: c.scope } : {}),
      })),
    };
  }

  // Workflow + platform_settings still need GET-then-merge because their
  // sub-fields (`workflow.prevent_subagent_loops`, `platform_settings.*`)
  // are not the same shape as the partial we build — and we don't want to
  // clobber siblings we don't manage. Fetch lazily so patches that touch
  // neither pay zero network.
  let current: ElevenAgentRaw | null = null;
  if (patch.workflow !== undefined || Object.keys(platformSlice).length > 0) {
    current = await getAgent(agentId);
  }

  // NOTE: workflow lives at the TOP LEVEL of the agent body, not under
  // `conversation_config.workflow`. Setting it under conversation_config
  // is silently ignored upstream and the real top-level `workflow` stays
  // untouched (we found this by GETting an agent and seeing the
  // populated `workflow.nodes` field outside conversation_config).
  if (patch.workflow !== undefined) {
    // Merge so we don't blow away workflow-level settings like
    // `prevent_subagent_loops` that we don't manage here.
    incoming.workflow = deepMergeConfig(
      (current?.workflow ?? {}) as Record<string, unknown>,
      patch.workflow as unknown as Record<string, unknown>,
    );
  }

  if (Object.keys(platformSlice).length > 0) {
    incoming.platform_settings = deepMergeConfig(
      (current?.platform_settings ?? {}) as Record<string, unknown>,
      platformSlice,
    );
  }

  // High-level summary of what we're about to send. Helps correlate a
  // single patchAgent call with the lower-level elFetch logs and the
  // upstream error body when things go wrong.
  log.info("patchAgent → PATCH /v1/convai/agents/:id", {
    agent_id: agentId,
    patch_fields: Object.keys(patch),
    body_top_keys: Object.keys(incoming),
    workflow_node_count:
      (incoming.workflow as { nodes?: Record<string, unknown> } | undefined)
        ?.nodes
        ? Object.keys(
            (incoming.workflow as { nodes: Record<string, unknown> }).nodes,
          ).length
        : undefined,
    has_tool_ids: !!(
      (incoming.conversation_config as { agent?: { prompt?: { tool_ids?: unknown } } } | undefined)
        ?.agent?.prompt?.tool_ids
    ),
    has_inline_tools: !!(
      (incoming.conversation_config as { agent?: { prompt?: { tools?: unknown } } } | undefined)
        ?.agent?.prompt?.tools
    ),
  });
  const res = await elFetch(`/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    section: "update",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(incoming),
  });
  return (await res.json()) as ElevenAgentRaw;
}

// --- Knowledge base ---------------------------------------------------------

export type ElevenKbDoc = { id: string; name: string };

export async function createKbFromUrl(input: {
  url: string;
  name?: string;
}): Promise<ElevenKbDoc> {
  const res = await elFetch("/v1/convai/knowledge-base/url", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: input.url, name: input.name ?? input.url }),
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function createKbFromFile(input: {
  file: Blob;
  filename: string;
  name?: string;
}): Promise<ElevenKbDoc> {
  const form = new FormData();
  form.append("file", input.file, input.filename);
  if (input.name) form.append("name", input.name);
  const res = await elFetch("/v1/convai/knowledge-base/file", {
    method: "POST",
    section: "knowledge_base",
    body: form,
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function createKbFromText(input: {
  text: string;
  name: string;
}): Promise<ElevenKbDoc> {
  const res = await elFetch("/v1/convai/knowledge-base/text", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: input.text, name: input.name }),
  });
  return (await res.json()) as ElevenKbDoc;
}

export async function deleteKbDocument(documentId: string): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}`, {
    method: "DELETE",
    section: "knowledge_base",
  });
}

export async function renameKbDocument(
  documentId: string,
  name: string,
): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}`, {
    method: "PATCH",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/**
 * Fetch the indexed text content of a KB document. Used by the UI to
 * preview what the agent will actually see when this doc is retrieved.
 */
export async function getKbDocumentContent(
  documentId: string,
): Promise<{ content: string }> {
  const res = await elFetch(
    `/v1/convai/knowledge-base/${documentId}/content`,
    { method: "GET", section: "knowledge_base", headers: { accept: "text/plain" } },
  );
  const content = await res.text();
  return { content };
}

/**
 * Refresh a URL-based KB document — re-fetch from the source URL and
 * re-index. Useful when the upstream content changes.
 */
export async function refreshKbDocument(documentId: string): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}/refresh`, {
    method: "POST",
    section: "knowledge_base",
  });
}

/**
 * Explicitly run RAG indexing on a document. Documents are auto-indexed but
 * this lets the user trigger a re-index manually after content changes.
 */
export async function ragIndexKbDocument(
  documentId: string,
  model: string = "e5_mistral_7b_instruct",
): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}/rag-index`, {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

/**
 * Semantic search across the entire workspace knowledge base.
 * Returns the top-K matching chunks across documents.
 */
export async function searchKnowledgeBase(input: {
  query: string;
  agent_id?: string;
  document_ids?: string[];
  top_k?: number;
}): Promise<{
  results: Array<{
    document_id: string;
    document_name: string;
    chunk_id: string;
    content: string;
    score: number;
  }>;
}> {
  const res = await elFetch("/v1/convai/knowledge-base/search", {
    method: "POST",
    section: "knowledge_base",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: input.query,
      agent_id: input.agent_id,
      document_ids: input.document_ids,
      top_k: input.top_k ?? 5,
    }),
  });
  return (await res.json()) as {
    results: Array<{
      document_id: string;
      document_name: string;
      chunk_id: string;
      content: string;
      score: number;
    }>;
  };
}

/**
 * List the dependent agents currently referencing a KB document. Useful
 * before removing a document so we can warn the user it'll affect other
 * agents in the workspace.
 */
export async function getKbDependentAgents(
  documentId: string,
): Promise<{ agent_id: string; agent_name: string }[]> {
  const res = await elFetch(
    `/v1/convai/knowledge-base/${documentId}/dependent-agents`,
    { method: "GET", section: "knowledge_base" },
  );
  const json = (await res.json()) as {
    dependent_agents?: Array<{ agent_id: string; agent_name?: string }>;
  };
  return (json.dependent_agents ?? []).map((a) => ({
    agent_id: a.agent_id,
    agent_name: a.agent_name ?? a.agent_id,
  }));
}

// --- Batch calling ----------------------------------------------------------

export type BatchCallRecipient = {
  phone_number: string;
  dynamic_variables?: Record<string, string>;
};

export async function submitBatchCall(input: {
  call_name: string;
  agent_id: string;
  agent_phone_number_id: string;
  recipients: BatchCallRecipient[];
  scheduled_time_unix?: number;
  target_concurrency_limit?: number;
}): Promise<{ id: string }> {
  const res = await elFetch("/v1/convai/batch-calling/submit", {
    method: "POST",
    section: "batch_calling",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      call_name: input.call_name,
      agent_id: input.agent_id,
      agent_phone_number_id: input.agent_phone_number_id,
      recipients: input.recipients,
      scheduled_time_unix: input.scheduled_time_unix,
      target_concurrency_limit: input.target_concurrency_limit,
    }),
  });
  return (await res.json()) as { id: string };
}

export async function getBatchCall(batchId: string): Promise<unknown> {
  const res = await elFetch(`/v1/convai/batch-calling/${batchId}`, {
    method: "GET",
    section: "batch_calling",
  });
  return res.json();
}

export async function cancelBatchCall(batchId: string): Promise<void> {
  await elFetch(`/v1/convai/batch-calling/${batchId}/cancel`, {
    method: "POST",
    section: "batch_calling",
  });
}

// --- Workspace secrets ------------------------------------------------------

export async function createWorkspaceSecret(input: {
  name: string;
  value: string;
}): Promise<{ id: string; name: string }> {
  const res = await elFetch("/v1/convai/secrets", {
    method: "POST",
    section: "secrets",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, value: input.value, type: "new" }),
  });
  return (await res.json()) as { id: string; name: string };
}

export async function listWorkspaceSecrets(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await elFetch("/v1/convai/secrets", {
    method: "GET",
    section: "secrets",
  });
  const json = (await res.json()) as {
    secrets: Array<{ secret_id: string; name: string }>;
  };
  return json.secrets.map((s) => ({ id: s.secret_id, name: s.name }));
}

// --- Agent simulation -------------------------------------------------------

export async function simulateConversation(input: {
  agent_id: string;
  simulation_specification: {
    simulated_user_config: { first_message?: string; prompt: string };
  };
}): Promise<unknown> {
  const res = await elFetch(
    `/v1/convai/agents/${input.agent_id}/simulate-conversation`,
    {
      method: "POST",
      section: "simulation",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        simulation_specification: input.simulation_specification,
      }),
    },
  );
  return res.json();
}

// --- Runtime tools (generic create) ----------------------------------------

export type RuntimeToolSpec = {
  name: string;
  description: string;
  type: "webhook" | "client" | "system";
  phase: RuntimePhase;
  api_schema?: {
    url: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    request_headers?: Record<string, string>;
    request_body_schema?: unknown;
    query_params_schema?: unknown;
  };
};

/**
 * True when `v` is an actual JSON-Schema-shaped object the upstream API
 * will accept. We send body / query schemas only when they're real objects;
 * null and empty objects produce 422s on /v1/convai/tools.
 */
function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as Record<string, unknown>).length > 0
  );
}

export async function createRuntimeTool(
  spec: RuntimeToolSpec,
): Promise<{ id: string; name: string }> {
  let api_schema: Record<string, unknown> | undefined;
  if (spec.api_schema) {
    api_schema = {
      url: spec.api_schema.url,
      method: spec.api_schema.method,
    };
    if (
      spec.api_schema.request_headers &&
      Object.keys(spec.api_schema.request_headers).length > 0
    ) {
      api_schema.request_headers = spec.api_schema.request_headers;
    }
    if (isNonEmptyObject(spec.api_schema.request_body_schema)) {
      api_schema.request_body_schema = spec.api_schema.request_body_schema;
    }
    if (isNonEmptyObject(spec.api_schema.query_params_schema)) {
      api_schema.query_params_schema = spec.api_schema.query_params_schema;
    }
  }
  const body = {
    tool_config: {
      name: spec.name,
      description: spec.description,
      type: spec.type,
      ...(api_schema ? { api_schema } : {}),
    },
  };
  // Log the whole tool_config we're about to send. /v1/convai/tools
  // returns 422 on subtle schema shape issues (e.g. `type: "object"` at
  // the outer schema level, unknown JSON-Schema fields) — having the
  // exact body in logs lets us tell synthesizer bugs from upstream
  // schema drift without re-running with debug toggles.
  log.info("createRuntimeTool → POST /v1/convai/tools", {
    name: spec.name,
    type: spec.type,
    method: api_schema?.method,
    has_request_body_schema: "request_body_schema" in (api_schema ?? {}),
    has_query_params_schema: "query_params_schema" in (api_schema ?? {}),
    tool_config: logTrunc(body.tool_config),
  });
  const res = await elFetch("/v1/convai/tools", {
    method: "POST",
    section: "tools",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { id: string; tool_config?: { name?: string } };
  return { id: json.id, name: json.tool_config?.name ?? spec.name };
}

export async function deleteRuntimeTool(toolId: string): Promise<void> {
  await elFetch(`/v1/convai/tools/${toolId}`, {
    method: "DELETE",
    section: "tools",
  });
}

// --- Phone numbers + outbound calls -----------------------------------------

/**
 * Workspace phone number row as returned by `GET /v1/convai/phone-numbers`.
 * Carries the `assigned_agent` field so callers can tell which agent (if
 * any) currently owns each number — needed to render the per-agent
 * "Attached phone numbers" list correctly without trusting the agent GET
 * response (which doesn't always echo `phone_numbers`).
 */
export type WorkspacePhoneNumber = PhoneNumber & {
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
};

export async function listPhoneNumbers(): Promise<WorkspacePhoneNumber[]> {
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "GET",
    section: "phone",
  });
  const json = (await res.json()) as Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
    assigned_agent?: {
      agent_id?: string;
      agent_name?: string;
    } | null;
  }>;
  return json.map((p) => ({
    id: p.phone_number_id,
    number: p.phone_number,
    provider: p.provider,
    label: p.label,
    assigned_agent_id: p.assigned_agent?.agent_id ?? null,
    assigned_agent_name: p.assigned_agent?.agent_name ?? null,
  }));
}

/**
 * Subset of `listPhoneNumbers` filtered to numbers currently assigned to a
 * specific ElevenLabs agent id. We can't trust the GET-agent response to
 * include `phone_numbers` — depending on workspace settings ElevenLabs
 * omits it — so the workspace list is the source of truth.
 */
export async function listPhoneNumbersForAgent(
  elevenlabsAgentId: string,
): Promise<PhoneNumber[]> {
  const all = await listPhoneNumbers();
  return all
    .filter((p) => p.assigned_agent_id === elevenlabsAgentId)
    .map((p) => ({
      id: p.id,
      number: p.number,
      provider: p.provider,
      label: p.label,
    }));
}

export async function assignPhoneNumberToAgent(
  phoneNumberId: string,
  agentId: string,
): Promise<void> {
  await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "PATCH",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
}

// --- Phone number import / CRUD ---------------------------------------------
//
// Spec: https://elevenlabs.io/docs/api-reference/phone-numbers
// POST /v1/convai/phone-numbers accepts either a Twilio config or a SIP-trunk
// config (oneOf). Below we expose typed helpers for each shape so callers
// can't mix fields from both branches and trip a 422.

export type TwilioRegionId = "us1" | "ie1" | "au1";
export type TwilioEdgeLocation =
  | "ashburn"
  | "dublin"
  | "frankfurt"
  | "sao-paulo"
  | "singapore"
  | "sydney"
  | "tokyo"
  | "umatilla"
  | "roaming";

export type ImportTwilioPhoneNumberInput = {
  phone_number: string;
  label: string;
  sid: string;
  token: string;
  region_config?: {
    region_id: TwilioRegionId;
    token: string;
    edge_location: TwilioEdgeLocation;
  };
};

export type SIPMediaEncryption = "disabled" | "allowed" | "required";
export type SIPTransport = "auto" | "udp" | "tcp" | "tls";

export type SIPTrunkCredentials = {
  username: string;
  password?: string | null;
};

export type InboundSIPTrunkConfig = {
  allowed_addresses?: string[] | null;
  allowed_numbers?: string[] | null;
  media_encryption?: SIPMediaEncryption;
  credentials?: SIPTrunkCredentials | null;
  remote_domains?: string[] | null;
  attributes_to_headers?: Record<string, string>;
};

export type OutboundSIPTrunkConfig = {
  address: string;
  transport?: SIPTransport;
  media_encryption?: SIPMediaEncryption;
  headers?: Record<string, string>;
  attributes_to_headers?: Record<string, string>;
  credentials?: SIPTrunkCredentials | null;
};

export type ImportSIPTrunkPhoneNumberInput = {
  phone_number: string;
  label: string;
  inbound_trunk_config?: InboundSIPTrunkConfig | null;
  outbound_trunk_config?: OutboundSIPTrunkConfig | null;
};

export async function importTwilioPhoneNumber(
  input: ImportTwilioPhoneNumberInput,
): Promise<{ phone_number_id: string }> {
  const body = {
    provider: "twilio" as const,
    phone_number: input.phone_number,
    label: input.label,
    sid: input.sid,
    token: input.token,
    ...(input.region_config ? { region_config: input.region_config } : {}),
  };
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "POST",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { phone_number_id: string };
}

export async function importSIPTrunkPhoneNumber(
  input: ImportSIPTrunkPhoneNumberInput,
): Promise<{ phone_number_id: string }> {
  const body: Record<string, unknown> = {
    provider: "sip_trunk",
    phone_number: input.phone_number,
    label: input.label,
  };
  if (input.inbound_trunk_config !== undefined) {
    body.inbound_trunk_config = input.inbound_trunk_config;
  }
  if (input.outbound_trunk_config !== undefined) {
    body.outbound_trunk_config = input.outbound_trunk_config;
  }
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "POST",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { phone_number_id: string };
}

export async function getPhoneNumber(phoneNumberId: string): Promise<unknown> {
  const res = await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "GET",
    section: "phone",
  });
  return res.json();
}

export async function deletePhoneNumber(phoneNumberId: string): Promise<void> {
  await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "DELETE",
    section: "phone",
  });
}

/**
 * PATCH /v1/convai/phone-numbers/{id}. The endpoint also handles agent
 * assignment (see `assignPhoneNumberToAgent`); this helper exposes the
 * other mutable fields (label, region config, sip configs).
 */
export type UpdatePhoneNumberInput = {
  label?: string;
  agent_id?: string | null;
  region_config?: ImportTwilioPhoneNumberInput["region_config"] | null;
  inbound_trunk_config?: InboundSIPTrunkConfig | null;
  outbound_trunk_config?: OutboundSIPTrunkConfig | null;
};

export async function updatePhoneNumber(
  phoneNumberId: string,
  input: UpdatePhoneNumberInput,
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.agent_id !== undefined) body.agent_id = input.agent_id;
  if (input.region_config !== undefined) body.region_config = input.region_config;
  if (input.inbound_trunk_config !== undefined)
    body.inbound_trunk_config = input.inbound_trunk_config;
  if (input.outbound_trunk_config !== undefined)
    body.outbound_trunk_config = input.outbound_trunk_config;
  const res = await elFetch(`/v1/convai/phone-numbers/${phoneNumberId}`, {
    method: "PATCH",
    section: "phone",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * GET /v1/convai/phone-numbers/{id}/sip-messages — only valid for
 * sip_trunk-provider numbers. Returns the recent SIP signalling log so
 * operators can diagnose call setup / auth issues.
 */
export async function getPhoneNumberSipMessages(
  phoneNumberId: string,
): Promise<unknown> {
  const res = await elFetch(
    `/v1/convai/phone-numbers/${phoneNumberId}/sip-messages`,
    { method: "GET", section: "phone" },
  );
  return res.json();
}

export async function initiateOutboundCall(input: {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
  /**
   * Per-call dynamic variable values, populated from CRM pre-call
   * enrichment. The agent's system prompt references these as
   * `{{caller_name}}`, `{{caller_company}}` etc.; ElevenLabs substitutes
   * them at conversation start. Empty/missing values render as empty
   * strings (the agent treats the caller as new).
   */
  dynamicVariables?: Record<string, string>;
}): Promise<{ conversation_id: string }> {
  const body: Record<string, unknown> = {
    agent_id: input.agentId,
    agent_phone_number_id: input.agentPhoneNumberId,
    to_number: input.toNumber,
  };
  if (input.dynamicVariables && Object.keys(input.dynamicVariables).length > 0) {
    body.conversation_initiation_client_data = {
      dynamic_variables: input.dynamicVariables,
    };
  }
  const res = await elFetch(`/v1/convai/twilio/outbound-call`, {
    method: "POST",
    section: "outbound_call",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { conversation_id: string };
}

// --- Test-call signed URL ---------------------------------------------------

export async function getConversationSignedUrl(
  agentId: string,
): Promise<{ signed_url: string }> {
  const res = await elFetch(
    `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
    { method: "GET", section: "conversation_token" },
  );
  return (await res.json()) as { signed_url: string };
}

// --- Conversations (call logs) ----------------------------------------------

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
      message: string;
      time_in_call_secs?: number;
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
        message: t.message,
        time_in_call_seconds: t.time_in_call_secs,
      })) ?? [],
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

export async function fetchConversationAudio(
  conversationId: string,
): Promise<Response> {
  return elFetch(`/v1/convai/conversations/${conversationId}/audio`, {
    method: "GET",
    section: "recording",
    headers: { accept: "audio/mpeg" },
  });
}

// --- Projection back into our cache shape -----------------------------------

export function projectAgentConfig(
  el: ElevenAgentRaw,
  fallback: AgentConfigCache,
): AgentConfigCache {
  const a = el.conversation_config?.agent;
  const p = a?.prompt;
  const t = el.conversation_config?.tts;
  const kb: KnowledgeBaseDocument[] =
    p?.knowledge_base?.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      source: d.name,
    })) ?? fallback.knowledge_base;
  const tools: RuntimeTool[] =
    p?.tools?.map((tool) => ({
      id: tool.id ?? tool.name,
      name: tool.name,
      type: tool.type,
      description: tool.description ?? "",
      phase: phaseFor(tool.name, tool.type),
    })) ?? fallback.tools;
  const mcp: McpIntegration[] =
    p?.mcp_server_ids?.map((id) => ({ id, name: id, url: "" })) ??
    fallback.mcp_servers;
  const dataCollection: DataCollectionField[] = el.platform_settings?.data_collection
    ? Object.entries(el.platform_settings.data_collection).map(([name, v]) => ({
        id: name,
        name,
        type: v.type,
        description: v.description,
        ...(Array.isArray(v.enum) && v.enum.length > 0
          ? { enum: v.enum }
          : {}),
      }))
    : fallback.data_collection;
  // Filter out criteria that upstream stored with a missing/empty goal prompt
  // or id. We previously coerced `prompt` to `""` here, but that's an unsafe
  // round-trip: any subsequent PATCH of evaluation_criteria (including an
  // unrelated remove_call_outcome on a SIBLING criterion) re-sends the broken
  // entry with `conversation_goal_prompt: ""`, which ElevenLabs rejects with a
  // bare "Invalid platform settings: Field required" 422. Dropping broken
  // entries at read time means our in-memory state is always serialisable —
  // tools never see them, and we never echo them back upstream.
  const rawCriteria = el.platform_settings?.evaluation?.criteria ?? null;
  let evalCriteria: EvaluationCriterion[];
  if (rawCriteria === null) {
    evalCriteria = fallback.evaluation_criteria;
  } else {
    const accepted: EvaluationCriterion[] = [];
    for (const c of rawCriteria) {
      const prompt = c.conversation_goal_prompt ?? c.prompt ?? "";
      if (!c.id || !c.name || prompt.trim().length === 0) {
        console.warn(
          "[elevenlabs] dropping malformed evaluation criterion from agent config",
          { id: c.id, name: c.name, has_prompt: prompt.trim().length > 0 },
        );
        continue;
      }
      // Coerce nullish flags to undefined so they never round-trip back into a
      // PATCH payload as `null`. Upstream's PromptEvaluationCriteria types
      // these as non-nullable, so leaking a `null` here turns the next PATCH
      // — even an unrelated sibling change like remove_call_outcome — into a
      // "Input should be a valid boolean" failure.
      accepted.push({
        id: c.id,
        name: c.name,
        prompt,
        use_knowledge_base: c.use_knowledge_base ?? undefined,
        scope: c.scope ?? undefined,
      });
    }
    evalCriteria = accepted;
  }
  const phoneNumbers: PhoneNumber[] =
    el.phone_numbers?.map((p) => ({
      id: p.phone_number_id,
      number: p.phone_number,
      provider: p.provider,
      label: p.label,
    })) ?? fallback.phone_numbers;

  const voiceSettings: VoiceSettings = {
    stability: t?.stability ?? fallback.voice_settings.stability,
    similarity_boost: t?.similarity_boost ?? fallback.voice_settings.similarity_boost,
    style: t?.style ?? fallback.voice_settings.style,
    use_speaker_boost: t?.use_speaker_boost ?? fallback.voice_settings.use_speaker_boost,
    speed: t?.speed ?? fallback.voice_settings.speed,
  };

  return {
    name: el.name ?? fallback.name,
    first_message: a?.first_message ?? fallback.first_message,
    system_prompt: p?.prompt ?? fallback.system_prompt,
    voice_id: t?.voice_id ?? fallback.voice_id,
    voice_settings: voiceSettings,
    tts_model: t?.model_id ?? fallback.tts_model,
    language: a?.language ?? fallback.language,
    llm: p?.llm ?? fallback.llm,
    temperature: p?.temperature ?? fallback.temperature,
    max_duration_seconds:
      el.conversation_config?.conversation?.max_duration_seconds ??
      fallback.max_duration_seconds,
    knowledge_base: kb,
    tools,
    mcp_servers: mcp,
    data_collection: dataCollection,
    evaluation_criteria: evalCriteria,
    phone_numbers: phoneNumbers,
    // Workflow lives at the TOP LEVEL of the agent (not under
    // conversation_config). Keep the conversation_config path as a
    // fallback for any legacy/stub responses.
    workflow: projectWorkflow(
      (el.workflow ??
        (el.conversation_config as Record<string, unknown> | undefined)
          ?.workflow) as ElevenWorkflow | undefined,
      fallback.workflow,
    ),
    // Integrations are platform-side metadata; carry forward.
    integrations: fallback.integrations,
  };
}

/**
 * Translate ElevenLabs' `conversation_config.workflow` back into our
 * internal WorkflowState. We can't perfectly recover the speak/collect/
 * condition distinction (all three project as `override_agent` on their
 * side), so we default to `speak` for those.
 */
function projectWorkflow(
  remote: ElevenWorkflow | undefined,
  fallback: AgentConfigCache["workflow"],
): AgentConfigCache["workflow"] {
  if (!remote || !remote.nodes) return fallback;
  const ourTypeFor = (
    t: ElevenWorkflowNode["type"],
  ): AgentConfigCache["workflow"]["nodes"][number]["type"] => {
    switch (t) {
      case "start":
        return "start";
      case "end":
        return "end";
      case "tool":
      case "dispatch_tool":
        return "tool_call";
      case "standalone_agent":
      case "agent_transfer":
      case "phone_number":
      case "transfer_to_number":
        return "transfer";
      case "say":
      case "override_agent":
      case "update_state":
      default:
        return "speak";
    }
  };
  const nodes = Object.entries(remote.nodes).map(([id, n]) => {
    const data: Record<string, unknown> = {};
    if (n.additional_prompt) data.prompt = n.additional_prompt;
    const extras = n as Record<string, unknown>;
    for (const k of ["tool_id", "target_agent_id", "phone_number"] as const) {
      if (extras[k] !== undefined) data[k] = extras[k];
    }
    return {
      id,
      type: ourTypeFor(n.type),
      label: n.label ?? id,
      data,
    };
  });
  const edges = Object.entries(remote.edges ?? {}).map(([id, e]) => {
    const cond = e.forward_condition;
    return {
      id,
      from: e.source,
      to: e.target,
      label: (e as Record<string, unknown>).label as string | undefined,
      condition:
        cond?.type === "llm" || cond?.type === "expression"
          ? cond.condition
          : undefined,
    };
  });
  return { nodes, edges };
}

function phaseFor(name: string, type: string): RuntimePhase {
  const n = name.toLowerCase();
  if (n.startsWith("pre_") || n.includes("pre_call")) return "pre_call";
  if (n.startsWith("post_") || n.includes("after_call") || n.includes("post_call"))
    return "post_call";
  if (type === "system") return "in_call";
  return "in_call";
}
