import { redis } from "../db/redis.ts";

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  branch?: string;
  framework?: string;
  updatedAt?: string;
}

export interface RepoStrategyProfile {
  repoId: string;
  strategyId: string;
  frameworkSignals: string[];
  templateExtensions: string[];
  lastIndexedAt?: string;
}

function repoMetaKey(repoId: string): string {
  return `repo:meta:${repoId}`;
}

function repoStrategyKey(repoId: string): string {
  return `repo:strategy:${repoId}`;
}

function buildFrameworkSignals(strategyId: string): string[] {
  if (strategyId === "ofbiz-supplyhouse") {
    return ["ofbiz", "ftl", "bsh"];
  }
  return [];
}

function buildTemplateExtensions(strategyId: string): string[] {
  if (strategyId === "ofbiz-supplyhouse") {
    return [".ftl"];
  }
  return [];
}

export function buildRepoStrategyProfile(
  repoId: string,
  strategyId: string,
  lastIndexedAt?: string,
): RepoStrategyProfile {
  return {
    repoId,
    strategyId,
    frameworkSignals: buildFrameworkSignals(strategyId),
    templateExtensions: buildTemplateExtensions(strategyId),
    lastIndexedAt: lastIndexedAt ?? new Date().toISOString(),
  };
}

export async function setRepoMeta(meta: RepoMeta): Promise<void> {
  const payload: RepoMeta = {
    ...meta,
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
  };
  await redis.set(repoMetaKey(meta.repoId), JSON.stringify(payload));
}

export async function setRepoStrategyProfile(profile: RepoStrategyProfile): Promise<void> {
  await redis.set(repoStrategyKey(profile.repoId), JSON.stringify(profile));
}

export async function getRepoMeta(repoId: string): Promise<RepoMeta | null> {
  const raw = await redis.get(repoMetaKey(repoId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoMeta;
  } catch {
    return null;
  }
}

export async function getRepoStrategyProfile(repoId: string): Promise<RepoStrategyProfile | null> {
  const raw = await redis.get(repoStrategyKey(repoId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RepoStrategyProfile;
  } catch {
    return null;
  }
}

export async function listRepoMeta(): Promise<RepoMeta[]> {
  const keys = await redis.keys("repo:meta:*");
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  const items: RepoMeta[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw) as RepoMeta);
    } catch {
      // ignore malformed entries
    }
  }
  return items;
}

export async function listRepoStrategyProfiles(): Promise<RepoStrategyProfile[]> {
  const keys = await redis.keys("repo:strategy:*");
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  const items: RepoStrategyProfile[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw) as RepoStrategyProfile);
    } catch {
      // ignore malformed entries
    }
  }
  return items;
}
