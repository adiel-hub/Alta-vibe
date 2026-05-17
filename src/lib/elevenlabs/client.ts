import { deepMergeConfig } from "./patchConfig";
import type {
  AgentConfigCache,
  KnowledgeBaseDocument,
  RuntimeTool,
  McpIntegration,
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

  let attempt = 0;
  while (true) {
    const res = await fetch(`${BASE_URL}${path}`, { ...rest, headers });
    if (res.status === 429 && attempt < 3) {
      const delay = 2 ** attempt * 500;
      await new Promise((r) => setTimeout(r, delay));
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
        `ElevenLabs ${section} request failed (${res.status})`;
      throw new ElevenLabsError(res.status, section, message, body);
    }
    return res;
  }
}

// --- Voices -----------------------------------------------------------------

export type ElevenVoice = {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
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

// --- Agent CRUD -------------------------------------------------------------

type ElevenAgent = {
  agent_id: string;
  name?: string;
  conversation_config?: {
    agent?: {
      first_message?: string;
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
          type: "webhook" | "client";
          description?: string;
        }>;
        mcp_server_ids?: string[];
      };
    };
    tts?: { voice_id?: string };
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
        prompt: { prompt: seed.system_prompt, llm: "gemini-2.0-flash" },
      },
      tts: { voice_id: seed.voice_id },
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

export async function getAgent(agentId: string): Promise<ElevenAgent> {
  const res = await elFetch(`/v1/convai/agents/${agentId}`, {
    method: "GET",
    section: "read",
  });
  return (await res.json()) as ElevenAgent;
}

/**
 * Partial update. Builds a deep-merged conversation_config so sibling fields
 * stay intact. Caller passes only the slice they want to change.
 */
export async function patchAgent(
  agentId: string,
  patch: {
    name?: string;
    first_message?: string;
    system_prompt?: string;
    voice_id?: string;
    llm?: string;
    temperature?: number;
    knowledge_base?: Array<{ id: string; name: string; type: "url" | "file" | "text" }>;
    tools?: Array<{
      id?: string;
      name: string;
      type: "webhook" | "client";
      description?: string;
    }>;
    mcp_server_ids?: string[];
  },
): Promise<ElevenAgent> {
  const current = await getAgent(agentId);
  const incoming: Record<string, unknown> = {};
  if (patch.name !== undefined) incoming.name = patch.name;

  const agentSlice: Record<string, unknown> = {};
  if (patch.first_message !== undefined) agentSlice.first_message = patch.first_message;
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

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agentSlice).length > 0) conversationConfig.agent = agentSlice;
  if (Object.keys(ttsSlice).length > 0) conversationConfig.tts = ttsSlice;
  if (Object.keys(conversationConfig).length > 0) {
    incoming.conversation_config = deepMergeConfig(
      (current.conversation_config ?? {}) as Record<string, unknown>,
      conversationConfig,
    );
  }

  const res = await elFetch(`/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    section: "update",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(incoming),
  });
  return (await res.json()) as ElevenAgent;
}

// --- Knowledge base ---------------------------------------------------------

export type ElevenKbDoc = {
  id: string;
  name: string;
};

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

export async function deleteKbDocument(documentId: string): Promise<void> {
  await elFetch(`/v1/convai/knowledge-base/${documentId}`, {
    method: "DELETE",
    section: "knowledge_base",
  });
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

// --- Projection back into our cache shape -----------------------------------

export function projectAgentConfig(
  el: ElevenAgent,
  fallback: AgentConfigCache,
): AgentConfigCache {
  const a = el.conversation_config?.agent;
  const p = a?.prompt;
  const kb: KnowledgeBaseDocument[] =
    p?.knowledge_base?.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      source: d.name,
    })) ?? fallback.knowledge_base;
  const tools: RuntimeTool[] =
    p?.tools?.map((t) => ({
      id: t.id ?? t.name,
      name: t.name,
      type: t.type,
      description: t.description ?? "",
    })) ?? fallback.tools;
  const mcp: McpIntegration[] =
    p?.mcp_server_ids?.map((id) => ({ id, name: id, url: "" })) ??
    fallback.mcp_servers;

  return {
    name: el.name ?? fallback.name,
    first_message: a?.first_message ?? fallback.first_message,
    system_prompt: p?.prompt ?? fallback.system_prompt,
    voice_id: el.conversation_config?.tts?.voice_id ?? fallback.voice_id,
    llm: p?.llm ?? fallback.llm,
    temperature: p?.temperature ?? fallback.temperature,
    knowledge_base: kb,
    tools,
    mcp_servers: mcp,
  };
}
