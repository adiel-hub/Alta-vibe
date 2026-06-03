/**
 * SSE bridge for live workflow tracking of a PHONE call.
 *
 * Opens ElevenLabs' real-time monitoring WebSocket for `conversationId` and
 * forwards each `agent_tool_response` to the browser as a `monitor` SSE frame
 * carrying the position-engine event shape
 * (`{kind:"tool_response", toolName, toolType, isError}`). When the monitor
 * socket ends we emit `{kind:"disconnect"}` and close the stream.
 *
 * The web call drives the same engine entirely client-side via the
 * `@elevenlabs/react` SDK; this route is the server-side equivalent for calls
 * the browser isn't party to. Lifetime tracks the SSE connection — when the
 * browser navigates away we tear the upstream socket down too (matching the
 * web call, which dies on disconnect).
 */
import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { encodeComment, SSE_HEADERS } from "@/lib/sse";
import { openConversationMonitor } from "@/lib/elevenlabs/client";
import { createLogger, newRequestId } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 800;

const enc = new TextEncoder();
function frame(payload: unknown): Uint8Array {
  return enc.encode(`event: monitor\ndata: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; conversationId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, conversationId } = await params;
  if (!ObjectId.isValid(id)) {
    return new Response(JSON.stringify({ error: "Invalid id" }), { status: 400 });
  }
  const log = createLogger("sse", {
    route: "GET /calls/[conversationId]/monitor/stream",
    req_id: newRequestId(),
    agent_id: id,
    conversation_id: conversationId,
  });

  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }
  log.info("attach");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let ping: ReturnType<typeof setInterval> | undefined;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const monitor = openConversationMonitor(conversationId, {
        onToolResponse: (r) =>
          safeEnqueue(
            frame({
              kind: "tool_response",
              toolName: r.toolName,
              toolType: r.toolType,
              isError: r.isError,
            }),
          ),
        onClose: ({ code }) => {
          log.info("monitor closed; ending stream", { code });
          safeEnqueue(frame({ kind: "disconnect" }));
          closeStream();
        },
      });

      function closeStream() {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        monitor.close();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      // Prime + keep the socket warm through the quiet gaps between tool
      // signals; comments are inert to the client parser.
      safeEnqueue(encodeComment("ping"));
      ping = setInterval(() => safeEnqueue(encodeComment("ping")), 15000);

      req.signal.addEventListener("abort", () => {
        log.debug("client disconnected");
        closeStream();
      });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
