/**
 * AES-256-GCM encryption helpers for per-agent third-party credentials.
 * Stored format: "<iv-hex>.<tag-hex>.<ciphertext-hex>". Reads
 * `INTEGRATION_TOKEN_ENC_KEY` from env (32 random bytes, hex-encoded).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const raw = process.env.INTEGRATION_TOKEN_ENC_KEY;
  if (!raw) {
    throw new Error(
      "INTEGRATION_TOKEN_ENC_KEY is not set. Generate one with `openssl rand -hex 32`.",
    );
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "INTEGRATION_TOKEN_ENC_KEY must be 32 bytes hex-encoded (64 hex chars).",
    );
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

export function decryptToken(blob: string): string {
  const key = getKey();
  const [ivHex, tagHex, ctHex] = blob.split(".");
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error("Malformed encrypted token");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}
