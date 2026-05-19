/**
 * POST /api/agents/[id]/versions/[versionId]/restore
 *
 * Restore the agent's `main` branch to a historical version. Append-only:
 * we fetch the snapshot via GET ?version_id=X, then PATCH the agent with
 * its config — producing a NEW version whose contents equal version X.
 * The original X is preserved in history.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireSharedSecret } from "@/lib/auth";
import { agentsCol, messagesCol } from "@/lib/mongodb";
import {
  getAgentAtVersion,
  patchAgent,
  projectAgentConfig,
  ElevenLabsError,
  type AgentPatch,
  type ElevenWorkflow,
} from "@/lib/elevenlabs/client";
import type { AgentConfigCache } from "@/types/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VersionIdSchema = z.string().min(1).max(200);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const { id, versionId } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const parsedVersion = VersionIdSchema.safeParse(versionId);
  if (!parsedVersion.success) {
    return NextResponse.json({ error: "Invalid versionId" }, { status: 400 });
  }
  const _id = new ObjectId(id);
  const agents = await agentsCol();
  const agent = await agents.findOne({ _id });
  if (!agent) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    // 1. Pull the historical snapshot in upstream shape.
    const historical = await getAgentAtVersion(
      agent.elevenlabs_agent_id,
      parsedVersion.data,
    );
    // 2. Normalize into our cache shape so we can use it for the in-app
    //    state update later. Pass current cache as fallback for fields the
    //    historical response omits (e.g. integrations are platform-side).
    const projected = projectAgentConfig(historical, agent.config_cache);

    // 3. Build a PATCH that re-applies the historical config. We pass the
    //    raw upstream `workflow` straight through (no round trip through
    //    our internal WorkflowState shape) to avoid lossy projection.
    const patch: AgentPatch = {
      name: projected.name,
      first_message: projected.first_message,
      system_prompt: projected.system_prompt,
      voice_id: projected.voice_id,
      voice_settings: projected.voice_settings,
      tts_model: projected.tts_model,
      language: projected.language,
      llm: projected.llm,
      temperature: projected.temperature,
      max_duration_seconds: projected.max_duration_seconds,
      knowledge_base: projected.knowledge_base.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
      })),
      tool_ids: projected.tools.map((t) => t.id),
      mcp_server_ids: projected.mcp_servers.map((m) => m.id),
      data_collection: Object.fromEntries(
        projected.data_collection.map((f) => [
          f.name,
          {
            type: f.type,
            description: f.description,
            ...(f.enum && f.enum.length > 0 ? { enum: f.enum } : {}),
          },
        ]),
      ),
      evaluation_criteria: projected.evaluation_criteria,
      workflow: (historical.workflow ?? undefined) as ElevenWorkflow | undefined,
    };

    const elResponse = await patchAgent(agent.elevenlabs_agent_id, patch);

    // 4. Persist the restored config + cache the new upstream version id.
    //    Use the same optimistic-lock pattern as the config route so a
    //    concurrent in-flight edit can't silently overwrite the restore.
    const next: AgentConfigCache = { ...projected, integrations: agent.config_cache.integrations };
    const $set: Record<string, unknown> = {
      config_cache: next,
      revision: agent.revision + 1,
      updated_at: new Date(),
    };
    if (elResponse.version_id) $set.current_version_id = elResponse.version_id;

    const updated = await agents.findOneAndUpdate(
      { _id, revision: agent.revision },
      { $set },
      { returnDocument: "after" },
    );
    if (!updated) {
      // Lost the optimistic lock — another edit landed between read and write.
      // Tell the client so it can refresh and retry the restore.
      return NextResponse.json(
        {
          error:
            "Agent changed during restore. Refresh and try again.",
        },
        { status: 409 },
      );
    }

    // 5. Synthetic chat message so the conversation reflects the restore.
    await (await messagesCol()).insertOne({
      agent_id: _id,
      role: "system",
      content: [
        {
          type: "text",
          text: `Restored agent to version ${parsedVersion.data}.`,
        },
      ],
      revision_before: agent.revision,
      revision_after: updated.revision,
      created_at: new Date(),
    } as never);

    return NextResponse.json({
      revision: updated.revision,
      current_version_id: updated.current_version_id ?? null,
      config_cache: updated.config_cache,
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
