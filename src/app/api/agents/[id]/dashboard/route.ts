import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  ElevenLabsError,
  getConversationDetail,
  listConversations,
} from "@/lib/elevenlabs/client";
import { aggregate } from "@/lib/dashboard/aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES = ["24h", "7d", "30d", "all"] as const;
type Range = (typeof RANGES)[number];

// We always pull the upstream max and filter client-side because ElevenLabs'
// list endpoint doesn't support a date filter. 100 is the hard ceiling on
// page_size; longer windows on busy agents will see a truncated view.
const UPSTREAM_LIMIT = 100;

function cutoffMs(range: Range): number | null {
  const day = 24 * 60 * 60 * 1000;
  switch (range) {
    case "24h":
      return Date.now() - day;
    case "7d":
      return Date.now() - 7 * day;
    case "30d":
      return Date.now() - 30 * day;
    case "all":
      return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const rawRange = new URL(req.url).searchParams.get("range") ?? "all";
  const range: Range = (RANGES as readonly string[]).includes(rawRange)
    ? (rawRange as Range)
    : "all";

  const agent = await (await agentsCol()).findOne({ _id: new ObjectId(id) });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const allSummaries = await listConversations(
      agent.elevenlabs_agent_id,
      UPSTREAM_LIMIT,
    );
    const cutoff = cutoffMs(range);
    const summaries = cutoff
      ? allSummaries.filter((s) => new Date(s.start_time).getTime() >= cutoff)
      : allSummaries;
    // Fan out detail fetches in parallel. Soft-fail individual ones so a single
    // bad call doesn't take the whole dashboard down — the aggregation just
    // sees fewer evaluation rows for that conversation.
    const details = (
      await Promise.all(
        summaries.map((s) =>
          getConversationDetail(s.id).catch(() => null),
        ),
      )
    ).filter((d): d is NonNullable<typeof d> => d !== null);

    const outcomeCriteria = agent.config_cache.evaluation_criteria.map((c) => ({
      id: c.id,
      name: c.name,
      label: c.label,
    }));
    const dataFields = agent.config_cache.data_collection.map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      enum: f.enum,
    }));

    const metrics = aggregate({ summaries, details, outcomeCriteria, dataFields });
    return NextResponse.json({ metrics, range });
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
