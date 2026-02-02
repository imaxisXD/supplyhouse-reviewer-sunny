import { redis } from "../db/redis.ts";

const DEFAULT_CANCEL_TTL_SECONDS = 60 * 60; // 1 hour

export function reviewCancelKey(reviewId: string): string {
  return `review:cancelled:${reviewId}`;
}

export function indexCancelKey(indexId: string): string {
  return `index:cancelled:${indexId}`;
}

export async function markCancelled(key: string): Promise<void> {
  await redis.set(key, "1", "EX", DEFAULT_CANCEL_TTL_SECONDS);
}

export async function isCancelled(key: string): Promise<boolean> {
  const value = await redis.get(key);
  return value === "1";
}

export async function assertNotCancelled(key: string, message: string): Promise<void> {
  if (await isCancelled(key)) {
    throw new Error(message);
  }
}
