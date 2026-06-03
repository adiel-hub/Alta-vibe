import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  patchAgent,
  removeRules,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import type { PronunciationDictionary } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; ruleId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, ruleId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const dict = agent.config_cache.pronunciation_dictionary;
  const target = dict?.rules.find((r) => r.id === ruleId);
  if (!dict || !target) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }

  try {
    const { version_id } = await removeRules(dict.id, [
      target.string_to_replace,
    ]);
    const remaining = dict.rules.filter((r) => r.id !== ruleId);
    const next: PronunciationDictionary = {
      ...dict,
      version_id,
      rules: remaining,
    };

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
