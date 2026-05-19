import { appFetch } from "@/lib/apiClient";
import type { InspectorVoice } from "./types";

// Module-level cache so opening the inspector on different nodes doesn't
// hit /api/voices every time. Mirrors what VoiceTab does, but kept here so
// we don't pull in that whole component.
let voicesPromise: Promise<InspectorVoice[]> | null = null;
export function loadVoicesCached(): Promise<InspectorVoice[]> {
  voicesPromise ??= appFetch(`/api/voices`).then(async (r) => {
    if (!r.ok) throw new Error(`Voices request failed (${r.status})`);
    const j = (await r.json()) as { voices: InspectorVoice[] };
    return j.voices;
  });
  return voicesPromise;
}
