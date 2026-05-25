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
import { createAgent, getAgent, ElevenLabsError } from "@/lib/elevenlabs/client";
import { defaultAgentConfig } from "@/lib/capabilities";
import { fromElevenWorkflow } from "@/lib/capabilities/experience/workflow";
import { backfillProviderToolsForAgent } from "@/lib/integrations/registerProviderTools";
import { enqueueTurnJob, processTurnJob } from "@/lib/turn-jobs/runner";
import { createLogger, newRequestId } from "@/lib/logger";
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

/**
 * Lightweight agent index — name + phone numbers — used by the campaign
 * modal so the user can pick which agent to use for an outbound campaign.
 * Returns only the fields the picker needs.
 */
export async function GET(req: NextRequest) {
  const log = createLogger("api", { route: "GET /api/agents", req_id: newRequestId() });
  const guard = requireSharedSecret(req);
  if (guard) return guard;
  try {
    const col = await agentsCol();
    const docs = await col
      // Exclude the audience_builder singleton — it's a workspace-internal
      // chat host, not a user-facing voice agent. {$ne} also matches docs
      // where `kind` is missing (legacy voice agents).
      .find({ kind: { $ne: "audience_builder" } })
      .sort({ updated_at: -1 })
      .limit(100)
      .project({
        name: 1,
        elevenlabs_agent_id: 1,
        "config_cache.name": 1,
        "config_cache.phone_numbers": 1,
        updated_at: 1,
      })
      .toArray();
    type DocShape = {
      _id: { toHexString: () => string };
      name?: string;
      elevenlabs_agent_id?: string;
      config_cache?: {
        name?: string;
        phone_numbers?: Array<{
          id: string;
          number: string;
          label?: string;
          provider?: string;
        }>;
      };
      updated_at?: Date;
    };
    const data = (docs as unknown as DocShape[]).map((d) => ({
      id: d._id.toHexString(),
      name: d.config_cache?.name || d.name || "Untitled agent",
      elevenlabs_agent_id: d.elevenlabs_agent_id ?? "",
      phone_numbers:
        d.config_cache?.phone_numbers?.map((p) => ({
          id: p.id,
          number: p.number,
          label: p.label ?? "",
        })) ?? [],
      updated_at: d.updated_at?.toISOString() ?? new Date(0).toISOString(),
    }));
    log.info("ok", { count: data.length });
    return NextResponse.json({ agents: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("failed", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const log = createLogger("api", { route: "POST /api/agents", req_id: newRequestId() });
  log.info("request");
  const guard = requireSharedSecret(req);
  if (guard) return guard;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    log.warn("invalid body");
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { description } = parsed.data;
  log.debug("creating agent", { desc_len: description.length });

  try {
    const configCache = defaultAgentConfig();
    // Start with an empty display name in our cache so the chat header is
    // blank on creation; the builder agent's `update_agent_name` tool will
    // fill it in mid-turn, which then types out via the header's animated
    // reveal. Upstream ElevenLabs still needs a non-empty name on create,
    // so we send the starter — that string is internal and never shown.
    configCache.name = "";
    configCache.first_message = STARTER_FIRST_MESSAGE;
    configCache.system_prompt = STARTER_SYSTEM_PROMPT;
    configCache.voice_id = DEFAULT_VOICE_ID;

    const { agent_id } = await createAgent({
      name: STARTER_NAME,
      first_message: STARTER_FIRST_MESSAGE,
      system_prompt: STARTER_SYSTEM_PROMPT,
      voice_id: DEFAULT_VOICE_ID,
    });

    // ElevenLabs auto-generates a start node with its OWN id during create.
    // Read it back so our cache stores the real upstream id from day zero
    // — otherwise our hardcoded "start" id silently overwrites theirs on
    // the first PATCH and any reference to the start node during the gap
    // is wrong. If the read fails (transient), fall back to the seeded
    // default — the next set_workflow will re-anchor anyway.
    try {
      const raw = await getAgent(agent_id);
      // raw.workflow is typed loosely (Record<string, unknown>) on the
      // ElevenAgentRaw response type; fromElevenWorkflow does its own
      // runtime guards on the shape so the cast is safe.
      const upstreamWorkflow = fromElevenWorkflow(
        raw.workflow as Parameters<typeof fromElevenWorkflow>[0],
      );
      if (upstreamWorkflow && upstreamWorkflow.nodes.length > 0) {
        configCache.workflow = upstreamWorkflow;
      }
    } catch (err) {
      log.warn("could not hydrate upstream workflow after create", {
        agent_id,
        message: err instanceof Error ? err.message : "unknown",
      });
    }

    const now = new Date();
    const col = await agentsCol();
    const insert = await col.insertOne({
      elevenlabs_agent_id: agent_id,
      name: STARTER_NAME,
      description,
      revision: 0,
      config_cache: configCache,
      last_error: null,
      conversation_summary: null,
      summary_through_message_id: null,
      created_at: now,
      updated_at: now,
    } as unknown as AgentDocument);

    // Auto-inherit workspace-connected provider tools. If HubSpot /
    // Google Calendar / etc. are already connected for the workspace,
    // their default tools land on this new agent immediately so the
    // first builder turn can reference them. Best-effort: a failure
    // here just defers the install to the agent's first GET (which
    // also runs backfill).
    await backfillProviderToolsForAgent(insert.insertedId.toHexString()).catch(
      (err) => {
        log.warn("backfill provider tools failed on create", {
          mongo_id: insert.insertedId.toHexString(),
          message: err instanceof Error ? err.message : "unknown",
        });
      },
    );

    // Kick off the first builder turn so Alta starts shaping the agent
    // immediately. The user's landing-page description becomes the
    // conversational seed.
    const jobId = await enqueueTurnJob(insert.insertedId, description, "user");
    if (!process.env.USE_RAILWAY_WORKER) {
      after(async () => {
        try {
          await processTurnJob(jobId);
        } catch {
          // job runner persists its own failure state
        }
      });
    }

    log.info("agent created", {
      mongo_id: insert.insertedId.toHexString(),
      voice_agent_id: agent_id,
      first_turn_job_id: jobId.toHexString(),
    });
    return NextResponse.json({
      id: insert.insertedId.toHexString(),
      jobId: jobId.toHexString(),
    });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      log.error("provider error", { status: err.status, message: err.message });
      return NextResponse.json(
        { error: err.message, section: err.section },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error("create failed", { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
