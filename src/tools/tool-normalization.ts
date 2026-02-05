type ToolMap = Record<string, unknown>;

/**
 * Wrap a tools map so lookups trim whitespace in the tool name.
 * This prevents failures when the model emits tool names with leading/trailing spaces.
 */
export function normalizeToolNames<T extends ToolMap>(tools: T): T {
  return new Proxy(tools, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const trimmed = prop.trim();
        if (trimmed in target) {
          return Reflect.get(target, trimmed, receiver);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
