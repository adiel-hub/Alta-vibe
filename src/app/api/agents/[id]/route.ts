import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import {
  agentsCol,
  messagesCol,
  turnJobsCol,
  widgetActionsCol,
} from "@/lib/mongodb";
import { requireSharedSecret } from "@/lib/auth";
import {
  deleteAgent as deleteElevenAgent,
  getAgent,
  listAgentBranches,
  projectAgentConfig,
  ElevenLabsError,
} from "@/lib/elevenlabs/client";
import { backfillProviderToolsForAgent } from "@/lib/integrations/registerProviderTools";
import type { AgentDocument, AgentDTO } from "@/types/agent";

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
  const col = await agentsCol();

  // Workspace cascade backfill: ensure this agent has every default tool
  // from every workspace-connected integration before we serve its
  // config. Heals agents that pre-date the cascade or missed it on
  // connect (transient ElevenLabs failure on that agent). Idempotent and
  // cheap when there's nothing to install. A failure here must not block
  // the page — backfill will retry on the next load.
  await backfillProviderToolsForAgent(id).catch(() => {});

  const doc = await col.findOne({ _id: new ObjectId(id) });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let freshened = doc;
  try {
    const el = await getAgent(doc.elevenlabs_agent_id);
    const projected = projectAgentConfig(el, doc.config_cache);
    const $set: Record<string, unknown> = {};
    if (JSON.stringify(projected) !== JSON.stringify(doc.config_cache)) {
      $set.config_cache = projected;
    }
    // Update the cached upstream version id whenever the GET response
    // carries one (it does since the Jan 2026 versioning rollout). Used
    // by the version-history panel to highlight the current row without
    // an extra round trip on open.
    if (el.version_id && el.version_id !== doc.current_version_id) {
      $set.current_version_id = el.version_id;
    }
    if (Object.keys($set).length > 0) {
      $set.updated_at = new Date();
      const updated = await col.findOneAndUpdate(
        { _id: doc._id },
        { $set },
        { returnDocument: "after" },
      );
      if (updated) freshened = updated;
    }
  } catch (err) {
    // Keep serving cached config — ElevenLabs unreachable shouldn't kill the page.
    if (!(err instanceof ElevenLabsError)) throw err;
  }

  // Lazy backfill of `main_branch_id` for agents predating the versioning
  // rollout. Best-effort: a failure here doesn't block the page — the
  // version-history endpoint will retry the lookup when the panel opens.
  if (!freshened.main_branch_id) {
    try {
      const branches = await listAgentBranches(freshened.elevenlabs_agent_id);
      const main = branches.find((b) => b.name === "main") ?? branches[0];
      if (main) {
        const updated = await col.findOneAndUpdate(
          { _id: freshened._id },
          { $set: { main_branch_id: main.id, updated_at: new Date() } },
          { returnDocument: "after" },
        );
        if (updated) freshened = updated;
      }
    } catch (err) {
      if (!(err instanceof ElevenLabsError)) throw err;
    }
  }

  const dto: AgentDTO = {
    id: freshened._id.toHexString(),
    elevenlabs_agent_id: freshened.elevenlabs_agent_id,
    name: freshened.name,
    description: freshened.description,
    revision: freshened.revision,
    config_cache: freshened.config_cache,
    last_error: freshened.last_error,
    main_branch_id: freshened.main_branch_id ?? null,
    current_version_id: freshened.current_version_id ?? null,
    created_at: freshened.created_at.toISOString(),
    updated_at: freshened.updated_at.toISOString(),
  };
  return NextResponse.json(dto);
}

export type AgentRouteDoc = AgentDocument;

/**
 * DELETE /api/agents/[id]
 *
 * Removes the agent from ElevenLabs AND every related collection in our
 * Mongo (agents, messages, turn_jobs, widget_actions). Idempotent: a 404
 * from ElevenLabs is treated as success so a stale record can still be
 * cleaned up.
 */
export async function DELETE(
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
  const doc = await agents.findOne({ _id });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Best-effort: drop the agent on ElevenLabs first. If it's already gone
  // we still proceed to clean up Mongo; any other error bubbles up so the
  // user can retry without orphaning state.
  try {
    await deleteElevenAgent(doc.elevenlabs_agent_id);
  } catch (err) {
    if (err instanceof ElevenLabsError && err.status !== 404) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      );
    }
    if (!(err instanceof ElevenLabsError)) throw err;
  }

  await Promise.all([
    agents.deleteOne({ _id }),
    (await messagesCol()).deleteMany({ agent_id: _id }),
    (await turnJobsCol()).deleteMany({ agent_id: _id }),
    (await widgetActionsCol()).deleteMany({ agent_id: _id }),
  ]);

  return NextResponse.json({ ok: true });
}
