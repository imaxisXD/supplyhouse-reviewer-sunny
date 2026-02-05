import { redis } from "../db/redis.ts";
import { env } from "../config/env.ts";
import { createLogger } from "../config/logger.ts";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const ENCRYPTION_ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const log = createLogger("token-store");

function getEncryptionKey(): Buffer {
  if (!env.TOKEN_ENCRYPTION_KEY) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to store Bitbucket tokens securely");
  }
  return createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();
}

function encryptToken(token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptToken(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted token format");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ENCRYPTION_ALGO, getEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

function looksEncrypted(payload: string): boolean {
  const parts = payload.split(":");
  // Encrypted format is base64(iv):base64(tag):base64(data) — exactly 3 parts
  // and each part is valid base64 (no spaces, @, /, etc. outside base64 charset).
  // A raw token like "user@email.com:appPassword" would fail the base64 check.
  if (parts.length !== 3) return false;
  const b64 = /^[A-Za-z0-9+/]+=*$/;
  return parts.every((p) => p.length > 0 && b64.test(p));
}

export function reviewTokenKey(reviewId: string): string {
  return `token:review:${reviewId}`;
}

export function indexTokenKey(indexId: string): string {
  return `token:index:${indexId}`;
}

export async function storeToken(key: string, token: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  const encrypted = encryptToken(token);
  await redis.set(key, encrypted, "EX", ttlSeconds);
}

export async function fetchToken(key: string): Promise<string | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  if (!looksEncrypted(raw)) return raw;
  try {
    return decryptToken(raw);
  } catch (error) {
    log.warn({ key, error: error instanceof Error ? error.message : String(error) }, "Failed to decrypt token; using legacy value");
    return raw;
  }
}

export async function deleteToken(key: string): Promise<void> {
  await redis.del(key);
}
