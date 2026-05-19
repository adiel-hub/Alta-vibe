import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { createLogger } from "@/lib/logger";
import { truncate } from "../utils/log";

export function handleSystemMessage(
  message: SDKMessage,
  log: ReturnType<typeof createLogger>,
): void {
  const sm = message as unknown as {
    subtype?: string;
    [k: string]: unknown;
  };
  log.info("sdk system", {
    subtype: sm.subtype,
    payload: truncate(JSON.stringify(sm), 400),
  });
}
