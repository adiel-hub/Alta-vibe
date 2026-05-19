import { createLogger } from "@/lib/logger";

export const log = createLogger("voice-provider");

/**
 * Truncate a stringified payload so we can safely splat it into logs
 * without filling Vercel/Railway with megabytes of system_prompt copy.
 * Returns `value` for objects/arrays unchanged when small enough, or a
 * truncated string when over the limit.
 */
export function logTrunc(value: unknown, limit = 4_000): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > limit ? `${value.slice(0, limit)}… [truncated ${value.length - limit} chars]` : value;
  }
  try {
    const s = JSON.stringify(value);
    if (s.length <= limit) return value;
    return `${s.slice(0, limit)}… [truncated ${s.length - limit} chars]`;
  } catch {
    return String(value);
  }
}
