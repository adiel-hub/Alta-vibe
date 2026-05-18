import { MongoClient, type Db, type Collection } from "mongodb";
import type {
  AgentDocument,
  AgentSecretDocument,
  ChatMessageDocument,
  CustomToolDocument,
  IntegrationDocument,
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
        .collection<TurnJobDocument>("turn_jobs")
        .createIndex({ agent_id: 1, started_at: -1 }),
      db
        .collection<TurnJobDocument>("turn_jobs")
        .createIndex({ status: 1, last_event_at: 1 }),
      db
        .collection<WidgetActionDocument>("widget_actions")
        .createIndex({ agent_id: 1, status: 1, created_at: -1 }),
      db
        .collection<IntegrationDocument>("integrations")
        .createIndex({ agent_id: 1, provider: 1 }, { unique: true }),
      db
        .collection<AgentSecretDocument>("agent_secrets")
        .createIndex({ agent_id: 1, name: 1 }, { unique: true }),
      db
        .collection<CustomToolDocument>("custom_tools")
        .createIndex({ agent_id: 1, name: 1 }, { unique: true }),
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
