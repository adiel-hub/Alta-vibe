import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import type { TurnStats } from "../types";

export function handleResultMessage(
  message: SDKMessage,
  log: ReturnType<typeof createLogger>,
  stats: TurnStats,
): void {
  const rm = message as unknown as {
    subtype?: string;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    stop_reason?: string | null;
    total_cost_usd?: number;
    usage?: Record<string, unknown>;
    is_error?: boolean;
  };
  if (typeof rm.duration_api_ms === "number") stats.api_ms = rm.duration_api_ms;
  if (typeof rm.total_cost_usd === "number") stats.cost_usd = rm.total_cost_usd;
  if (rm.usage) stats.usage = rm.usage;
  if (rm.stop_reason) stats.last_stop_reason = rm.stop_reason;
  log.info("sdk result", {
    subtype: rm.subtype,
    is_error: rm.is_error,
    num_turns: rm.num_turns,
    duration_ms: rm.duration_ms,
    duration_api_ms: rm.duration_api_ms,
    stop_reason: rm.stop_reason,
    total_cost_usd: rm.total_cost_usd,
    usage: rm.usage,
  });
}
