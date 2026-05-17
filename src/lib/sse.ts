import type { SSEEvent } from "@/types/agent";

const encoder = new TextEncoder();

export function encodeSSE(event: SSEEvent): Uint8Array {
  const lines = [`event: ${event.type}`, `data: ${JSON.stringify(event)}`, "", ""];
  return encoder.encode(lines.join("\n"));
}

export function encodeComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export const SSE_HEADERS: HeadersInit = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
