/**
 * GET /api/agents/[id]/versions
 *
 * Returns the version history for the agent's `main` branch — surfaced in
 * the builder's Version History panel. Lazy-backfills `main_branch_id` if
 * an older agent doc doesn't have it cached.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol } from "@/lib/mongodb";
import {
  getAgentBranch,
  listAgentBranches,
  ElevenLabsError,
  type ElevenAgentVersion,
} from "@/lib/elevenlabs/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    // 1. List branches to locate `main` (summary endpoint — no versions).
    const branches = await listAgentBranches(agent.elevenlabs_agent_id);
    const mainSummary =
      branches.find((b) => b.name === "main") ?? branches[0];
    if (!mainSummary) {
      return NextResponse.json({ versions: [], current_version_id: null });
    }

    if (mainSummary.id !== agent.main_branch_id) {
      await agents.updateOne(
        { _id },
        { $set: { main_branch_id: mainSummary.id, updated_at: new Date() } },
      );
    }

    // 2. GET the single branch to read `most_recent_versions` — that field
    //    lives on AgentBranchResponse (single-branch GET) only, NOT on
    //    AgentBranchSummary (list response).
    const mainBranch = await getAgentBranch(
      agent.elevenlabs_agent_id,
      mainSummary.id,
    );
    const versions: ElevenAgentVersion[] = mainBranch.most_recent_versions ?? [];

    return NextResponse.json({
      versions,
      current_version_id: agent.current_version_id ?? null,
      branch_id: mainSummary.id,
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
