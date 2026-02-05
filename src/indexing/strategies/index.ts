import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../../config/logger.ts";

const log = createLogger("indexing-strategy");

export type IndexingStrategyId = "default" | "ofbiz-supplyhouse";

let cachedMap: Record<string, IndexingStrategyId> | null = null;

function loadStrategyMap(): Record<string, IndexingStrategyId> {
  if (cachedMap) return cachedMap;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const configPath = path.join(dir, "indexing-strategies.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, IndexingStrategyId>;
    const normalized: Record<string, IndexingStrategyId> = {};
    for (const [key, value] of Object.entries(parsed)) {
      normalized[key.trim().toLowerCase()] = value;
    }
    cachedMap = normalized;
    return normalized;
  } catch (error) {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, "Failed to load strategy map");
    cachedMap = {};
    return cachedMap;
  }
}

export function getIndexingStrategyId(repoId: string): IndexingStrategyId {
  const map = loadStrategyMap();
  const normalized = repoId.trim().toLowerCase();
  if (normalized && map[normalized]) {
    return map[normalized] as IndexingStrategyId;
  }
  return "default";
}
