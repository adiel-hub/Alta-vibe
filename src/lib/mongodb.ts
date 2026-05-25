import { MongoClient, type Db, type Collection } from "mongodb";
import type {
  AgentDocument,
  AgentSecretDocument,
  AgentVersionMetaDocument,
  AudienceChatSessionDocument,
  AudienceDocument,
  CallCampaignDocument,
  ChatMessageDocument,
  CustomToolDocument,
  IntegrationDocument,
  ProspectDocument,
  TurnJobDocument,
  WidgetActionDocument,
} from "@/types/agent";
import { createLogger } from "./logger";

const log = createLogger("mongo");

declare global {
  // eslint-disable-next-line no-var
  var __altaVibeMongoClient: MongoClient | undefined;
  // eslint-disable-next-line no-var
  var __altaVibeIndexesEnsured: boolean | undefined;
}

function getUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");
  return uri;
}

function getDbName(): string {
  return process.env.MONGODB_DB ?? "alta_vibe";
}

async function getClient(): Promise<MongoClient> {
  if (globalThis.__altaVibeMongoClient) return globalThis.__altaVibeMongoClient;
  log.info("connecting", { db: getDbName() });
  const t0 = Date.now();
  const client = new MongoClient(getUri(), {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  log.info("connected", { ms: Date.now() - t0 });
  globalThis.__altaVibeMongoClient = client;
  return client;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  const db = client.db(getDbName());
  if (!globalThis.__altaVibeIndexesEnsured) {
    await Promise.all([
      db
        .collection<AgentDocument>("agents")
        .createIndex({ elevenlabs_agent_id: 1 }, { unique: true }),
      db
        .collection<ChatMessageDocument>("chat_messages")
        .createIndex({ agent_id: 1, created_at: 1 }),
      db
        .collection<ChatMessageDocument>("chat_messages")
        .createIndex({ chat_session_id: 1, created_at: 1 }, { sparse: true }),
      db
        .collection<AudienceChatSessionDocument>("audience_chat_sessions")
        .createIndex({ agent_id: 1, last_message_at: -1 }),
      db
        .collection<TurnJobDocument>("turn_jobs")
        .createIndex({ agent_id: 1, started_at: -1 }),
      db
        .collection<TurnJobDocument>("turn_jobs")
        .createIndex({ status: 1, last_event_at: 1 }),
      db
        .collection<WidgetActionDocument>("widget_actions")
        .createIndex({ agent_id: 1, status: 1, created_at: -1 }),
      // Workspace-shared integrations: one row per provider, NOT one row
      // per (agent, provider) — the OAuth token / proxy_secret is shared
      // across every agent in the workspace. The legacy index that
      // enforced uniqueness on (agent_id, provider) is replaced by a
      // {provider}-only unique. Old docs from before this migration may
      // duplicate by provider (different agent_ids); MongoDB will reject
      // the new index until those are merged or removed manually — that
      // matches the v1 expectation of fresh state for the workspace
      // change.
      db
        .collection<IntegrationDocument>("integrations")
        .createIndex({ provider: 1 }, { unique: true }),
      db
        .collection<AgentSecretDocument>("agent_secrets")
        .createIndex({ agent_id: 1, name: 1 }, { unique: true }),
      db
        .collection<CustomToolDocument>("custom_tools")
        .createIndex({ agent_id: 1, name: 1 }, { unique: true }),
      db
        .collection<AgentVersionMetaDocument>("agent_version_meta")
        .createIndex(
          { elevenlabs_agent_id: 1, version_id: 1 },
          { unique: true },
        ),
      db
        .collection<ProspectDocument>("prospects")
        .createIndex({ pdl_id: 1 }, { unique: true }),
      db
        .collection<AudienceDocument>("audiences")
        .createIndex({ name: 1 }, { unique: true }),
      db
        .collection<AudienceDocument>("audiences")
        .createIndex({ updated_at: -1 }),
      db
        .collection<CallCampaignDocument>("call_campaigns")
        .createIndex({ audience_id: 1, created_at: -1 }),
      db
        .collection<CallCampaignDocument>("call_campaigns")
        .createIndex({ status: 1, last_event_at: 1 }),
    ]);
    log.info("indexes ensured");
    globalThis.__altaVibeIndexesEnsured = true;
  }
  return db;
}

export async function agentsCol(): Promise<Collection<AgentDocument>> {
  return (await getDb()).collection<AgentDocument>("agents");
}

export async function messagesCol(): Promise<Collection<ChatMessageDocument>> {
  return (await getDb()).collection<ChatMessageDocument>("chat_messages");
}

export async function turnJobsCol(): Promise<Collection<TurnJobDocument>> {
  return (await getDb()).collection<TurnJobDocument>("turn_jobs");
}

export async function widgetActionsCol(): Promise<Collection<WidgetActionDocument>> {
  return (await getDb()).collection<WidgetActionDocument>("widget_actions");
}

export async function integrationsCol(): Promise<Collection<IntegrationDocument>> {
  return (await getDb()).collection<IntegrationDocument>("integrations");
}

export async function agentSecretsCol(): Promise<Collection<AgentSecretDocument>> {
  return (await getDb()).collection<AgentSecretDocument>("agent_secrets");
}

export async function customToolsCol(): Promise<Collection<CustomToolDocument>> {
  return (await getDb()).collection<CustomToolDocument>("custom_tools");
}

export async function agentVersionMetaCol(): Promise<
  Collection<AgentVersionMetaDocument>
> {
  return (await getDb()).collection<AgentVersionMetaDocument>(
    "agent_version_meta",
  );
}

export async function prospectsCol(): Promise<Collection<ProspectDocument>> {
  return (await getDb()).collection<ProspectDocument>("prospects");
}

export async function audiencesCol(): Promise<Collection<AudienceDocument>> {
  return (await getDb()).collection<AudienceDocument>("audiences");
}

export async function callCampaignsCol(): Promise<
  Collection<CallCampaignDocument>
> {
  return (await getDb()).collection<CallCampaignDocument>("call_campaigns");
}

export async function audienceChatSessionsCol(): Promise<
  Collection<AudienceChatSessionDocument>
> {
  return (await getDb()).collection<AudienceChatSessionDocument>(
    "audience_chat_sessions",
  );
}
