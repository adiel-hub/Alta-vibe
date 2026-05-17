type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

/**
 * Deep-merge `patch` on top of `base`. Arrays are replaced wholesale (matching
 * ElevenLabs' PATCH semantics: any field you provide replaces at that level).
 * Use this to build the partial body for `PATCH /v1/convai/agents/{id}` so
 * sibling fields under `conversation_config` aren't wiped.
 */
export function deepMergeConfig<T extends Plain>(base: T, patch: Plain): T {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (isPlainObject(v) && isPlainObject(existing)) {
      out[k] = deepMergeConfig(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
