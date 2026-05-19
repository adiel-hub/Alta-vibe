/**
 * Shared helpers for building tool specs that ElevenLabs' /v1/convai/tools
 * accepts. ElevenLabs is picky about schema shapes: `request_body_schema`
 * MUST carry outer `type: "object"`, while `query_params_schema` MUST NOT.
 * Both shapes reject standard JSON-Schema noise like `additionalProperties`
 * and `$schema`. These helpers normalise either side and stay the single
 * source of truth — used by `write_tool`, `runtime_tools`, and the provider
 * integration registrar.
 */
import type { RuntimePhase } from "@/types/agent";

const SECRET_REF_REGEX = /\{\{secret:([a-z0-9_]+)\}\}/g;

/**
 * Normalise a JSON-Schema object so ElevenLabs' /v1/convai/tools accepts
 * it. Returns `undefined` if the input is empty (the api_schema shape
 * forbids `null` / `{}` for body/query — omit the field entirely).
 */
export function normalizeElevenlabsSchema(
  schema: unknown,
  kind: "body" | "query",
): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const raw = schema as Record<string, unknown>;
  if (Object.keys(raw).length === 0) return undefined;
  const s: Record<string, unknown> = { ...raw };
  if (kind === "body") {
    s.type = "object";
  } else {
    delete s.type;
  }
  delete s.additionalProperties;
  delete s.$schema;
  return s;
}

/**
 * Phase-scope a wire name the way ElevenLabs expects: in-call tools use
 * the bare name; pre/post-call get prefixed so the runtime knows which
 * lifecycle hook fires them. Mirror this everywhere a tool is registered
 * so the proxy can route by URL segment.
 */
export function scopeToolName(name: string, phase: RuntimePhase): string {
  return phase === "in_call" ? name : `${phase}__${name}`;
}

/**
 * Pull every secret name referenced as `{{secret:<name>}}` inside the
 * given strings. Used to cross-check against agent_secrets before
 * publishing a tool, and to surface dependencies to the UI.
 */
export function extractSecretRefs(strings: Iterable<string>): string[] {
  const refs = new Set<string>();
  for (const s of strings) {
    if (typeof s !== "string") continue;
    for (const m of s.matchAll(SECRET_REF_REGEX)) refs.add(m[1]);
  }
  return Array.from(refs);
}
