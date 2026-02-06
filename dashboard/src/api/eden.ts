import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

export const api = treaty<App>(window.location.origin);

/** Unwrap an Eden response — throw on error, return data.
 *  Accepts both a resolved value and a Promise so callers can write
 *  either `unwrap(await call())` or `await unwrap(call())`.
 */
export async function unwrap<T>(
  res: Promise<{ data: T; error: unknown }> | { data: T; error: unknown },
): Promise<T> {
  const resolved = await res;
  if (resolved.error) throw new Error(extractErrorMessage(resolved.error));
  return resolved.data as T;
}

export function extractErrorMessage(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "value" in error) {
    const val = (error as { value: unknown }).value;
    if (typeof val === "string") return val;
    if (typeof val === "object" && val && "error" in val)
      return String((val as { error: unknown }).error);
  }
  if (typeof error === "object" && "error" in error)
    return String((error as { error: unknown }).error);
  return String(error);
}
