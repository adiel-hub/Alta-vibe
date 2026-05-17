/**
 * Create a voice agent and immediately start the first builder turn with the
 * user's description as the conversational seed.
 *
 * Flow on Continue click:
 *   1. Validate description.
 *   2. Create the voice-provider agent with deterministic defaults
 *      (no LLM seeding pass — keeps click → redirect to ~1s and removes
 *      a failure mode).
 *   3. Insert the agent doc with revision=0.
 *   4. Enqueue a builder turn with `description` as the first user message
 *      and kick the job off in the background via after().
 *   5. Return { id, jobId } — the client redirects to /agents/[id], which
 *      auto-attaches to the running turn so Alta starts shaping the agent
 *      the moment the page mounts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { createAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import { defaultAgentConfig } from "@/lib/capabilities";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import type { AgentDocument } from "@/types/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Hardcoded fallback voice (Rachel — ElevenLabs default) avoids a /voices roundtrip. */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const STARTER_NAME = "New voice agent";
const STARTER_FIRST_MESSAGE = "Hi! How can I help today?";
const STARTER_SYSTEM_PROMPT =
  "You are a helpful voice agent. Be friendly, concise, and proactive.";

const Body = z.object({
  description: z.string().min(10).max(4_000),
});

export async function POST(req: NextRequest) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { description } = parsed.data;

  try {
    const configCache = defaultAgentConfig();
    configCache.name = STARTER_NAME;
    configCache.first_message = STARTER_FIRST_MESSAGE;
    configCache.system_prompt = STARTER_SYSTEM_PROMPT;
    configCache.voice_id = DEFAULT_VOICE_ID;

    const { agent_id } = await createAgent({
      name: STARTER_NAME,
      first_message: STARTER_FIRST_MESSAGE,
      system_prompt: STARTER_SYSTEM_PROMPT,
      voice_id: DEFAULT_VOICE_ID,
    });

    const now = new Date();
    const col = await agentsCol();
    const insert = await col.insertOne({
      elevenlabs_agent_id: agent_id,
      name: STARTER_NAME,
      description,
      revision: 0,
      config_cache: configCache,
      last_error: null,
      created_at: now,
      updated_at: now,
    } as unknown as AgentDocument);

    // Kick off the first builder turn so Alta starts shaping the agent
    // immediately. The user's landing-page description becomes the
    // conversational seed.
    const jobId = await enqueueTurnJob(insert.insertedId, description, "user");
    after(async () => {
      try {
        await processTurnJob(jobId);
      } catch {
        // job runner persists its own failure state
      }
    });

    return NextResponse.json({
      id: insert.insertedId.toHexString(),
      jobId: jobId.toHexString(),
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
