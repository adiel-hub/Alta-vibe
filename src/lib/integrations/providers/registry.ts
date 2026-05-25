import type { IntegrationProvider, ProviderRuntimeToolSpec } from "./types";
import { HUBSPOT_PROVIDER } from "./hubspot";
import { SLACK_PROVIDER } from "./slack";
import { GOOGLE_CALENDAR_PROVIDER } from "./google";

export const PROVIDERS: IntegrationProvider[] = [
  HUBSPOT_PROVIDER,
  SLACK_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
];

export function getProvider(id: string): IntegrationProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Look up a tool spec on a provider by either its stable `key` or its
 * (possibly phase-prefixed) wire name. The proxy uses this to find specs
 * by the toolName segment of its URL; capabilities use it to find by key.
 */
export function findProviderTool(
  providerId: string,
  keyOrName: string,
): ProviderRuntimeToolSpec | undefined {
  const provider = getProvider(providerId);
  if (!provider) return undefined;
  return provider.runtime_tools.find(
    (t) =>
      t.key === keyOrName ||
      t.name === keyOrName ||
      `${t.phase}__${t.name}` === keyOrName,
  );
}

/**
 * Phase-scope a wire name the way ElevenLabs expects: in-call tools use
 * the bare name; pre/post-call get prefixed so the runtime knows which
 * lifecycle hook fires them.
 */
export function scopedToolName(spec: ProviderRuntimeToolSpec): string {
  return spec.phase === "in_call" ? spec.name : `${spec.phase}__${spec.name}`;
}
