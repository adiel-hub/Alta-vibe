import { elFetch } from "../core/fetch";

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
