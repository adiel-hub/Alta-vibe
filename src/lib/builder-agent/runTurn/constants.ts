/**
 * Number of most-recent turns rendered verbatim into the prompt. Anything
 * older is folded into `conversationSummary` by the summariser. Keep in sync
 * with LIVE_WINDOW in `summarizer.ts`.
 */
export const MAX_HISTORY_TURNS = 15;
export const HARD_TIMEOUT_MS = 360_000;
