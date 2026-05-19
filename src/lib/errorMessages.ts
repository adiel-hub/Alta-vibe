/**
 * Map raw server / SDK error strings into short, user-facing messages.
 *
 * The Agent SDK and our own routes return a grab-bag of phrasings:
 *   - "API Error: Repeated 529 Overloaded errors..."   (Claude capacity)
 *   - "rate_limit" / "429"                              (rate limited)
 *   - "Stream failed (5xx)" / "ECONNRESET"              (transient backend)
 *   - "Stream failed (401|403)" / "Unauthorized"        (auth)
 *   - "fetch failed" / "NetworkError" / "Failed to fetch" (offline / DNS)
 *   - "aborted" / "timeout"                             (cancelled)
 *
 * Anything we don't recognise falls through as-is so we never hide a
 * useful debug clue from the user.
 */
export function friendlyTurnError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const msg = raw.trim();
  if (!msg) return null;
  const lower = msg.toLowerCase();

  // Claude API capacity — by far the most common transient failure
  if (
    lower.includes("529") ||
    lower.includes("overloaded") ||
    lower.includes("at capacity")
  ) {
    return "Claude is overloaded right now — give it a moment and try again.";
  }

  // Rate limit
  if (lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("429")) {
    return "Hit a rate limit — wait a few seconds and retry.";
  }

  // Auth
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return "Authentication failed — your session may have expired. Reload the page.";
  }

  // Network / fetch
  if (
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound")
  ) {
    return "Lost connection to the server — check your network and try again.";
  }

  // Cancellation / timeout
  if (lower.includes("aborted") || lower.includes("timeout") || lower.includes("etimedout")) {
    return "The request timed out — try again.";
  }

  // Generic 5xx
  if (/\b5\d\d\b/.test(lower) || lower.includes("internal server")) {
    return "The server hit an unexpected error — try again in a moment.";
  }

  // Stream / SSE errors with no clearer signal
  if (lower.includes("stream failed")) {
    return "The streaming connection dropped — try again.";
  }

  return msg;
}
