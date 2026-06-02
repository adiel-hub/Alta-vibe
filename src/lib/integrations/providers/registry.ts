import type { IntegrationProvider, ProviderRuntimeToolSpec } from "./types";
import type { RuntimeTool } from "@/types/agent";
import { HUBSPOT_PROVIDER } from "./hubspot";
import { SLACK_PROVIDER } from "./slack";
import { GOOGLE_CALENDAR_PROVIDER } from "./google";
import { SALESFORCE_PROVIDER } from "./salesforce";
import { DYNAMICS365_PROVIDER } from "./dynamics365";
import { OUTLOOK_CALENDAR_PROVIDER } from "./outlook_calendar";
import { ALTA_PROVIDER } from "./alta";

export const PROVIDERS: IntegrationProvider[] = [
  HUBSPOT_PROVIDER,
  SLACK_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
  SALESFORCE_PROVIDER,
  DYNAMICS365_PROVIDER,
  OUTLOOK_CALENDAR_PROVIDER,
  ALTA_PROVIDER,
];

// Spec-load validation — pre-call tools must have exactly one of execute
// or build_body. Caught at module-load so a broken spec never reaches
// production. Throws on first violation to fail fast in dev / CI.
for (const provider of PROVIDERS) {
  for (const spec of provider.runtime_tools) {
    if (spec.phase !== "pre_call") continue;
    const hasExecute = typeof spec.execute === "function";
    const hasBuildBody = typeof spec.build_body === "function";
    if (hasExecute === hasBuildBody) {
      throw new Error(
        `Pre-call tool "${provider.id}.${spec.key}" must declare exactly one of ` +
          `\`execute\` or \`build_body\` (got ${hasExecute && hasBuildBody ? "both" : "neither"}).`,
      );
    }
  }
}

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

/** Find a spec across all providers by an installed tool's wire name. */
export function findSpecForInstalledTool(
  tool: RuntimeTool,
): ProviderRuntimeToolSpec | undefined {
  if (tool.provider) return findProviderTool(tool.provider, tool.name);
  // Fall back to scanning when provenance is missing (legacy installs).
  for (const p of PROVIDERS) {
    const spec = findProviderTool(p.id, tool.name);
    if (spec) return spec;
  }
  return undefined;
}

/** Find a spec by its scoped wire name without a known provider. */
export function findSpecByToolName(
  name: string,
): ProviderRuntimeToolSpec | undefined {
  for (const p of PROVIDERS) {
    const spec = findProviderTool(p.id, name);
    if (spec) return spec;
  }
  return undefined;
}

/**
 * Phase-scope a wire name the way ElevenLabs expects: in-call tools use
 * the bare name; pre/post-call get prefixed so the runtime knows which
 * lifecycle hook fires them.
 */
export function scopedToolName(spec: ProviderRuntimeToolSpec): string {
  return spec.phase === "in_call" ? spec.name : `${spec.phase}__${spec.name}`;
}
