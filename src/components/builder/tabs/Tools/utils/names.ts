import type { RuntimePhase } from "@/types/agent";

const UPPER_TOKENS = new Set([
  "id",
  "ids",
  "url",
  "api",
  "crm",
  "sms",
  "sql",
  "ai",
]);

/**
 * Strip phase prefix (e.g. `in_call__`) from the wire name and title-case
 * what's left, mirroring `friendlyToolName` but without a provider prefix.
 */
export function prettifyCustomName(wireName: string): string {
  let stripped = wireName;
  for (const prefix of ["pre_call__", "in_call__", "post_call__"]) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break;
    }
  }
  return stripped
    .split("_")
    .filter(Boolean)
    .map((w) =>
      UPPER_TOKENS.has(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

export function friendlyToolName(
  wireName: string,
  providerId: string,
  phase: RuntimePhase,
): string {
  let stripped = wireName;
  // The catalog phase-scopes wire names as `<phase>__<name>`; drop that prefix
  // because the tool is already shown under the active phase tab.
  const phasePrefix = `${phase}__`;
  if (stripped.startsWith(phasePrefix)) {
    stripped = stripped.slice(phasePrefix.length);
  }
  // Drop the provider prefix (e.g. `hubspot_`) — the tool sits inside the
  // provider's drawer, so prefixing every tile with the provider name is noise.
  const providerPrefix = `${providerId}_`;
  if (stripped.startsWith(providerPrefix)) {
    stripped = stripped.slice(providerPrefix.length);
  }
  return stripped
    .split("_")
    .filter(Boolean)
    .map((w) =>
      UPPER_TOKENS.has(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}
