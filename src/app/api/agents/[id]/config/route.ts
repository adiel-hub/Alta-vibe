/**
 * Direct config-patch endpoint backing the right-panel interactive editors.
 * Goes through the same provider helpers the chat tools use, so UI edits
 * stay consistent with chat-driven ones. Emits a synthetic chat message so
 * the conversation reflects panel-driven changes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import {
  patchAgent,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type { AgentConfigCache } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VoiceSettingsPatch = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarity_boost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    use_speaker_boost: z.boolean().optional(),
    speed: z.number().min(0.5).max(2).optional(),
  })
  .strict();

const Body = z
  .object({
    name: z.string().min(1).max(80).optional(),
    first_message: z.string().min(1).max(500).optional(),
    system_prompt: z.string().min(10).max(20_000).optional(),
    voice_id: z.string().min(1).optional(),
    voice_settings: VoiceSettingsPatch.optional(),
    tts_model: z.string().optional(),
    language: z.string().optional(),
    llm: z.string().optional(),
    temperature: z.number().min(0).max(1).optional(),
    max_duration_seconds: z.number().int().min(30).max(7200).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "empty patch");

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }

  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await patchAgent(agent.elevenlabs_agent_id, parsed.data);

    const next: AgentConfigCache = { ...agent.config_cache };
    if (parsed.data.name !== undefined) next.name = parsed.data.name;
    if (parsed.data.first_message !== undefined)
      next.first_message = parsed.data.first_message;
    if (parsed.data.system_prompt !== undefined)
      next.system_prompt = parsed.data.system_prompt;
    if (parsed.data.voice_id !== undefined) next.voice_id = parsed.data.voice_id;
    if (parsed.data.voice_settings) {
      next.voice_settings = { ...next.voice_settings, ...parsed.data.voice_settings };
    }
    if (parsed.data.tts_model !== undefined) next.tts_model = parsed.data.tts_model;
    if (parsed.data.language !== undefined) next.language = parsed.data.language;
    if (parsed.data.llm !== undefined) next.llm = parsed.data.llm;
    if (parsed.data.temperature !== undefined) next.temperature = parsed.data.temperature;
    if (parsed.data.max_duration_seconds !== undefined)
      next.max_duration_seconds = parsed.data.max_duration_seconds;

    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          config_cache: next,
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    const newRevision = updated?.revision ?? agent.revision + 1;

    const fields = Object.keys(parsed.data).join(", ");
    await (await messagesCol()).insertOne({
      agent_id: _id,
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Updated ${fields} from the panel.`,
        },
      ],
      revision_before: agent.revision,
      revision_after: newRevision,
      created_at: new Date(),
    } as never);

    return NextResponse.json({
      revision: newRevision,
      patch: parsed.data,
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
