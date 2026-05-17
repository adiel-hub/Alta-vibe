import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import { createAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import { seedAgentFromDescription } from "@/lib/seedAgent";
import {
  DEFAULT_VOICE_SETTINGS,
  type AgentConfigCache,
  type AgentDocument,
} from "@/types/agent";

export const runtime = "nodejs";

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
    const seed = await seedAgentFromDescription(description);
    const { agent_id } = await createAgent(seed);

    const configCache: AgentConfigCache = {
      name: seed.name,
      first_message: seed.first_message,
      system_prompt: seed.system_prompt,
      voice_id: seed.voice_id,
      voice_settings: { ...DEFAULT_VOICE_SETTINGS },
      tts_model: "eleven_turbo_v2_5",
      language: "en",
      llm: "gemini-2.0-flash",
      temperature: 0.5,
      max_duration_seconds: 600,
      knowledge_base: [],
      tools: [],
      mcp_servers: [],
      data_collection: [],
      evaluation_criteria: [],
      phone_numbers: [],
    };

    const now = new Date();
    const col = await agentsCol();
    const insert = await col.insertOne({
      elevenlabs_agent_id: agent_id,
      name: seed.name,
      description,
      revision: 0,
      config_cache: configCache,
      last_error: null,
      created_at: now,
      updated_at: now,
    } as unknown as AgentDocument);

    return NextResponse.json({ id: insert.insertedId.toHexString() });
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
