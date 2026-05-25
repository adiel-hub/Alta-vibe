/**
 * Singleton "audience_builder" agent — the workspace-internal chat host
 * for the /audiences page. Reuses the same Claude turn-job + widget +
 * tool infrastructure as voice agents, but its `kind` field hides it
 * from the agent picker and its system prompt is swapped (in
 * buildSystemPrompt) for AUDIENCE_BUILDER_ADDENDUM so it doesn't try to
 * run the voice-agent build flow.
 *
 * We still provision an ElevenLabs counterpart so existing code paths
 * (getAgent, runTurn, chat APIs) don't have to special-case kind. It
 * exists but is never used to place calls.
 */
import { ObjectId } from "mongodb";
import { agentsCol } from "@/lib/mongodb";
import { createAgent } from "@/lib/elevenlabs/client";
import { defaultAgentConfig } from "@/lib/capabilities";
import type { AgentDocument } from "@/types/agent";
import { createLogger } from "@/lib/logger";

const log = createLogger("audience-builder-agent");

const SINGLETON_NAME = "Audience Builder";
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const FIRST_MESSAGE =
  "Hi! I'm here to help you build a calling audience. Want to search PDL, sync HubSpot contacts, or upload a CSV?";
const SYSTEM_PROMPT =
  "Audience-builder host (internal). Never used for live calls.";

export async function getOrCreateAudienceBuilderAgent(): Promise<AgentDocument> {
  const agents = await agentsCol();
  const existing = await agents.findOne({ kind: "audience_builder" });
  if (existing) return existing;

  log.info("provisioning singleton");
  const { agent_id } = await createAgent({
    name: SINGLETON_NAME,
    first_message: FIRST_MESSAGE,
    system_prompt: SYSTEM_PROMPT,
    voice_id: DEFAULT_VOICE_ID,
  });

  const now = new Date();
  const configCache = defaultAgentConfig();
  configCache.name = SINGLETON_NAME;
  configCache.first_message = FIRST_MESSAGE;
  configCache.system_prompt = SYSTEM_PROMPT;
  configCache.voice_id = DEFAULT_VOICE_ID;

  // Race-tolerant: if a concurrent request inserted one first, the unique
  // index on elevenlabs_agent_id would actually NOT collide (since we just
  // created a different ElevenLabs agent), so we guard with a second find.
  const raceCheck = await agents.findOne({ kind: "audience_builder" });
  if (raceCheck) {
    log.info("race: another request provisioned first; using theirs", {
      id: raceCheck._id.toHexString(),
    });
    return raceCheck;
  }

  const insert = await agents.insertOne({
    elevenlabs_agent_id: agent_id,
    kind: "audience_builder",
    name: SINGLETON_NAME,
    description:
      "Workspace audience builder. Chat host for /audiences. Not user-facing as a voice agent.",
    revision: 0,
    config_cache: configCache,
    last_error: null,
    conversation_summary: null,
    summary_through_message_id: null,
    created_at: now,
    updated_at: now,
  } as never);

  const fresh = await agents.findOne({ _id: insert.insertedId });
  if (!fresh) {
    throw new Error("audience_builder agent insert disappeared");
  }
  log.info("provisioned", { id: fresh._id.toHexString(), elevenlabs_agent_id: agent_id });
  return fresh;
}

/** Convenience for components that already have a Mongo _id. */
export async function isAudienceBuilderAgent(agentMongoId: string): Promise<boolean> {
  if (!ObjectId.isValid(agentMongoId)) return false;
  const agents = await agentsCol();
  const doc = await agents.findOne(
    { _id: new ObjectId(agentMongoId) },
    { projection: { kind: 1 } },
  );
  return doc?.kind === "audience_builder";
}
