import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

export const api = treaty<App>(window.location.origin);

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
