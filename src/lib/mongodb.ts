import { MongoClient, type Db, type Collection } from "mongodb";
import type { AgentDocument, ChatMessageDocument } from "@/types/agent";

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
  const client = new MongoClient(getUri(), {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
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
    ]);
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
