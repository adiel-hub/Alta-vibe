import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  addRules,
  createDictionaryFromRules,
  patchAgent,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type {
  PronunciationDictionary,
  PronunciationRule,
} from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z
  .object({
    word: z.string().min(1).max(120),
    type: z.enum(["alias", "phoneme"]).default("alias"),
    alias: z.string().min(1).max(200).optional(),
    phoneme: z.string().min(1).max(200).optional(),
    alphabet: z.enum(["ipa", "cmu"]).optional(),
  })
  .refine((b) => (b.type === "alias" ? !!b.alias : !!b.phoneme), {
    message: "alias is required for alias rules; phoneme for phoneme rules",
  });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { word, type, alias, phoneme, alphabet } = parsed.data;

  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rule: PronunciationRule = {
    id: crypto.randomUUID(),
    type,
    string_to_replace: word,
    ...(type === "alias"
      ? { alias }
      : { phoneme, alphabet: alphabet ?? "ipa" }),
  };

  try {
    const existing = agent.config_cache.pronunciation_dictionary;
    let next: PronunciationDictionary;
    if (!existing) {
      const created = await createDictionaryFromRules({
        name: `${agent.config_cache.name || "Agent"} pronunciations`,
        rules: [rule],
      });
      next = {
        id: created.id,
        version_id: created.version_id,
        name: created.name,
        rules: [rule],
      };
    } else {
      const { version_id } = await addRules(existing.id, [rule]);
      next = { ...existing, version_id, rules: [...existing.rules, rule] };
    }

    await patchAgent(agent.elevenlabs_agent_id, {
      pronunciation_dictionary_locators: [
        { pronunciation_dictionary_id: next.id, version_id: next.version_id },
      ],
    });

    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      {
        $set: {
          "config_cache.pronunciation_dictionary": next,
          revision: agent.revision + 1,
          updated_at: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    return NextResponse.json({
      revision: updated?.revision ?? agent.revision + 1,
      patch: { pronunciation_dictionary: next },
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
