/**
 * Chat turn endpoint. SSE event vocabulary (one event per server-sent chunk):
 *   assistant_delta · tool_call_start · tool_call_result ·
 *   state_patch · state_error · turn_aborted · turn_done
 *
 * Each `state_patch` carries a monotonic `revision`; the client refetches
 * `GET /api/agents/[id]` if it ever sees a gap.
 *
 * Path: per the locked plan we keep the Agent SDK in Vercel Sandbox in
 * production. In dev / when sandbox env isn't configured we call the SDK
 * directly in-process (Node runtime; this works on Vercel too once the
 * `claude` CLI binary is bundled in the function's dependencies).
 */
import { ObjectId } from "mongodb";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import { runTurn } from "@/lib/builder-agent/runTurn";
import { encodeSSE, encodeComment, SSE_HEADERS } from "@/lib/sse";
import type {
  AgentConfigCache,
  ContentBlock,
  SSEEvent,
} from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 800;

const Body = z.object({ text: z.string().min(1).max(4_000) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return new Response(JSON.stringify({ error: "Invalid id" }), { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400 });
  }
  const { text: userText } = parsed.data;
  const _id = new ObjectId(id);

  const agents = await agentsCol();
  const messages = await messagesCol();
  const agent = await agents.findOne({ _id });
  if (!agent) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  const history = await messages
    .find({ agent_id: _id })
    .sort({ created_at: 1 })
    .toArray();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encodeComment("keepalive"));
        } catch {
          /* closed */
        }
      }, 15_000);

      const patches: Array<{ revision: number; patch: Partial<AgentConfigCache> }> = [];

      const emit = (event: SSEEvent) => {
        if (event.type === "state_patch") patches.push(event);
        try {
          controller.enqueue(encodeSSE(event));
        } catch {
          /* downstream closed */
        }
      };

      try {
        const result = await runTurn(
          {
            elevenlabsAgentId: agent.elevenlabs_agent_id,
            currentConfig: agent.config_cache,
            startingRevision: agent.revision,
            transcript: history.map((m) => ({ role: m.role, content: m.content })),
            userMessage: userText,
          },
          emit,
        );

        // Persist user turn + assistant turn
        const now = new Date();
        const userBlocks: ContentBlock[] = [{ type: "text", text: userText }];
        await messages.insertOne({
          agent_id: _id,
          role: "user",
          content: userBlocks,
          revision_before: agent.revision,
          revision_after: agent.revision,
          created_at: now,
          // _id assigned by Mongo
        } as never);

        await messages.insertOne({
          agent_id: _id,
          role: "assistant",
          content: result.assistantContent,
          revision_before: agent.revision,
          revision_after: result.endingRevision,
          created_at: new Date(),
        } as never);

        // Commit final config + revision via optimistic lock
        if (result.endingRevision !== agent.revision) {
          await agents.updateOne(
            { _id, revision: agent.revision },
            {
              $set: {
                config_cache: result.finalConfig,
                revision: result.endingRevision,
                updated_at: new Date(),
              },
            },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Turn failed";
        emit({ type: "state_error", section: "turn", message });
        emit({ type: "turn_aborted", reason: message });
      } finally {
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
