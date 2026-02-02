import { redis } from "../db/redis.ts";

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

export function reviewTokenKey(reviewId: string): string {
  return `token:review:${reviewId}`;
}

export function indexTokenKey(indexId: string): string {
  return `token:index:${indexId}`;
}

export async function storeToken(key: string, token: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
  await redis.set(key, token, "EX", ttlSeconds);
}

export async function fetchToken(key: string): Promise<string | null> {
  return redis.get(key);
}

export async function deleteToken(key: string): Promise<void> {
  await redis.del(key);
}
