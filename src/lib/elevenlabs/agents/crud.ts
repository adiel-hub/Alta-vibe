import { DEFAULT_VOICE_SETTINGS } from "@/types/agent";
import { elFetch } from "../core/fetch";
import type { ElevenAgentRaw } from "./types";

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

export async function getAgent(
  agentId: string,
  opts?: { version_id?: string; branch_id?: string },
): Promise<ElevenAgentRaw> {
  const qs = new URLSearchParams();
  if (opts?.version_id) qs.set("version_id", opts.version_id);
  if (opts?.branch_id) qs.set("branch_id", opts.branch_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await elFetch(`/v1/convai/agents/${agentId}${suffix}`, {
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
