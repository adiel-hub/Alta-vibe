/**
 * Per-agent free-form secrets. Distinct from `IntegrationDocument` (which is
 * keyed to a known provider in PROVIDERS) — these are arbitrary credentials
 * the builder agent asked the user for via a `collect_secret` widget.
 *
 * Generated runtime tools reference these by `name`; this module owns the
 * encrypt-on-write and decrypt-on-read boundary so the value never lives in
 * memory longer than needed and never reaches the chat transcript.
 */
import { ObjectId } from "mongodb";
import { agentSecretsCol } from "@/lib/mongodb";
import { decryptToken, encryptToken } from "./tokens";

export type StoredAgentSecret = {
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
};

/**
 * Encrypt and upsert a secret for the given agent. Returns the stable
 * `name` handle the caller should reference from generated tool code.
 */
export async function storeAgentSecret(
  agentMongoId: string,
  name: string,
  description: string,
  value: string,
): Promise<string> {
  if (!ObjectId.isValid(agentMongoId)) {
    throw new Error("Invalid agentMongoId");
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Empty secret value");
  const ciphertext = encryptToken(trimmed);
  const now = new Date();
  const col = await agentSecretsCol();
  await col.updateOne(
    { agent_id: new ObjectId(agentMongoId), name },
    {
      $set: { description, ciphertext, updated_at: now },
      $setOnInsert: {
        agent_id: new ObjectId(agentMongoId),
        name,
        created_at: now,
      },
    },
    { upsert: true },
  );
  return name;
}

/**
 * Decrypt and return the secret value. Returns null if not found.
 * Callers should hold the plaintext for the shortest scope possible.
 */
export async function getAgentSecret(
  agentMongoId: string,
  name: string,
): Promise<string | null> {
  if (!ObjectId.isValid(agentMongoId)) return null;
  const col = await agentSecretsCol();
  const doc = await col.findOne({
    agent_id: new ObjectId(agentMongoId),
    name,
  });
  if (!doc) return null;
  try {
    return decryptToken(doc.ciphertext);
  } catch {
    return null;
  }
}

/**
 * List stored secrets for an agent without leaking values. Used by the
 * builder agent to introspect what's already on file before asking again.
 */
export async function listAgentSecrets(
  agentMongoId: string,
): Promise<StoredAgentSecret[]> {
  if (!ObjectId.isValid(agentMongoId)) return [];
  const col = await agentSecretsCol();
  const docs = await col
    .find({ agent_id: new ObjectId(agentMongoId) })
    .sort({ created_at: 1 })
    .toArray();
  return docs.map((d) => ({
    name: d.name,
    description: d.description,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));
}
