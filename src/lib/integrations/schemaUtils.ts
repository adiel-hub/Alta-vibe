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

/** Fields that are part of JSON-Schema but rejected by ElevenLabs' Pydantic
 *  per-type validators. Scrubbed recursively from every nested object so a
 *  synthesizer that emits e.g. `additionalProperties: false` on a sub-field
 *  doesn't get rejected with "Extra inputs are not permitted" deep in the
 *  schema tree. */
const FORBIDDEN_KEYS = [
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "definitions",
  "$defs",
  "patternProperties",
  "unevaluatedProperties",
] as const;

function scrubNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(scrubNode);
  }
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(k)) continue;
    out[k] = scrubNode(v);
  }
  return out;
}

/**
 * Normalise a JSON-Schema object so ElevenLabs' /v1/convai/tools accepts
 * it. Returns `undefined` if the input is empty (the api_schema shape
 * forbids `null` / `{}` for body/query — omit the field entirely).
 *
 * Recurses into `properties` and `items` so forbidden keys are stripped at
 * every depth, not just the root.
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
  const scrubbed = scrubNode(raw) as Record<string, unknown>;
  if (kind === "body") {
    scrubbed.type = "object";
  } else {
    delete scrubbed.type;
  }
  return scrubbed;
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
