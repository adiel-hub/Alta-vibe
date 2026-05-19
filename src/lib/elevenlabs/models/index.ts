import { elFetch } from "../core/fetch";

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
