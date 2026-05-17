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

async function elFetch(
  path: string,
  init: RequestInit & { section: string },
): Promise<Response> {
  const { section, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("xi-api-key", apiKey());
  if (!headers.has("accept")) headers.set("accept", "application/json");

  const method = rest.method ?? "GET";
  let attempt = 0;
  const t0 = Date.now();
  while (true) {
    log.debug("request", { method, path, section, attempt });
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
      const message =
        (typeof body === "object" &&
          body !== null &&
          "detail" in body &&
          String((body as { detail: unknown }).detail)) ||
        `Voice provider ${section} request failed (${res.status})`;
      log.error("response error", {
        method,
        path,
        section,
        status: res.status,
        ms: Date.now() - t0,
        message,
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
      { type: "string" | "number" | "boolean"; description: string }
    >;
    evaluation?: {
      criteria?: Array<{ id: string; name: string; prompt: string }>;
    };
  };
  phone_numbers?: Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
  }>;
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
        model_id: "eleven_turbo_v2_5",
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
  max_duration_seconds?: number;
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
  }>;
  mcp_server_ids?: string[];
  data_collection?: Record<
    string,
    { type: "string" | "number" | "boolean"; description: string }
  >;
  evaluation_criteria?: Array<{ id: string; name: string; prompt: string }>;
};

export async function patchAgent(
  agentId: string,
  patch: AgentPatch,
): Promise<ElevenAgentRaw> {
  const current = await getAgent(agentId);
  const incoming: Record<string, unknown> = {};
  if (patch.name !== undefined) incoming.name = patch.name;

  const agentSlice: Record<string, unknown> = {};
  if (patch.first_message !== undefined) agentSlice.first_message = patch.first_message;
  if (patch.language !== undefined) agentSlice.language = patch.language;
  const promptSlice: Record<string, unknown> = {};
  if (patch.system_prompt !== undefined) promptSlice.prompt = patch.system_prompt;
  if (patch.llm !== undefined) promptSlice.llm = patch.llm;
  if (patch.temperature !== undefined) promptSlice.temperature = patch.temperature;
  if (patch.knowledge_base !== undefined) promptSlice.knowledge_base = patch.knowledge_base;
  if (patch.tools !== undefined) promptSlice.tools = patch.tools;
  if (patch.mcp_server_ids !== undefined) promptSlice.mcp_server_ids = patch.mcp_server_ids;
  if (Object.keys(promptSlice).length > 0) agentSlice.prompt = promptSlice;

  const ttsSlice: Record<string, unknown> = {};
  if (patch.voice_id !== undefined) ttsSlice.voice_id = patch.voice_id;
  if (patch.tts_model !== undefined) ttsSlice.model_id = patch.tts_model;
  if (patch.voice_settings) {
    for (const [k, v] of Object.entries(patch.voice_settings)) {
      if (v !== undefined) ttsSlice[k] = v;
    }
  }

  const conversationSlice: Record<string, unknown> = {};
  if (patch.max_duration_seconds !== undefined)
    conversationSlice.max_duration_seconds = patch.max_duration_seconds;

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agentSlice).length > 0) conversationConfig.agent = agentSlice;
  if (Object.keys(ttsSlice).length > 0) conversationConfig.tts = ttsSlice;
  if (Object.keys(conversationSlice).length > 0)
    conversationConfig.conversation = conversationSlice;
  if (Object.keys(conversationConfig).length > 0) {
    incoming.conversation_config = deepMergeConfig(
      (current.conversation_config ?? {}) as Record<string, unknown>,
      conversationConfig,
    );
  }

  const platformSlice: Record<string, unknown> = {};
  if (patch.data_collection !== undefined) {
    platformSlice.data_collection = patch.data_collection;
  }
  if (patch.evaluation_criteria !== undefined) {
    platformSlice.evaluation = { criteria: patch.evaluation_criteria };
  }
  if (Object.keys(platformSlice).length > 0) {
    incoming.platform_settings = deepMergeConfig(
      (current.platform_settings ?? {}) as Record<string, unknown>,
      platformSlice,
    );
  }

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

export async function createRuntimeTool(
  spec: RuntimeToolSpec,
): Promise<{ id: string; name: string }> {
  const body = {
    tool_config: {
      name: spec.name,
      description: spec.description,
      type: spec.type,
      ...(spec.api_schema ? { api_schema: spec.api_schema } : {}),
    },
  };
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

export async function listPhoneNumbers(): Promise<PhoneNumber[]> {
  const res = await elFetch("/v1/convai/phone-numbers", {
    method: "GET",
    section: "phone",
  });
  const json = (await res.json()) as Array<{
    phone_number_id: string;
    phone_number: string;
    provider: string;
    label?: string;
  }>;
  return json.map((p) => ({
    id: p.phone_number_id,
    number: p.phone_number,
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

export async function initiateOutboundCall(input: {
  agentId: string;
  agentPhoneNumberId: string;
  toNumber: string;
}): Promise<{ conversation_id: string }> {
  const res = await elFetch(`/v1/convai/twilio/outbound-call`, {
    method: "POST",
    section: "outbound_call",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: input.agentId,
      agent_phone_number_id: input.agentPhoneNumberId,
      to_number: input.toNumber,
    }),
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
    caller: c.from_number ?? null,
    has_recording: c.has_audio ?? false,
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
  return {
    id: json.conversation_id,
    agent_id: json.agent_id,
    start_time: new Date(json.metadata.start_time_unix_secs * 1000).toISOString(),
    duration_seconds: json.metadata.call_duration_secs,
    status: json.status,
    outcome: json.analysis?.transcript_summary ?? null,
    call_successful: json.analysis?.call_successful ?? null,
    caller: json.metadata.from_number ?? null,
    has_recording: json.has_audio ?? false,
    transcript:
      json.transcript?.map((t) => ({
        role: t.role,
        message: t.message,
        time_in_call_seconds: t.time_in_call_secs,
      })) ?? [],
    recording_url: json.has_audio
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
      }))
    : fallback.data_collection;
  const evalCriteria: EvaluationCriterion[] =
    el.platform_settings?.evaluation?.criteria?.map((c) => ({
      id: c.id,
      name: c.name,
      prompt: c.prompt,
    })) ?? fallback.evaluation_criteria;
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
    // Workflow + integrations are platform-side metadata (we own them, not
    // the voice provider). Carry forward whatever's in the agent doc.
    workflow: fallback.workflow,
    integrations: fallback.integrations,
  };
}

function phaseFor(name: string, type: string): RuntimePhase {
  const n = name.toLowerCase();
  if (n.startsWith("pre_") || n.includes("pre_call")) return "pre_call";
  if (n.startsWith("post_") || n.includes("after_call") || n.includes("post_call"))
    return "post_call";
  if (type === "system") return "in_call";
  return "in_call";
}
