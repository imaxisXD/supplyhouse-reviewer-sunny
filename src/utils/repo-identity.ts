import { createLogger } from "../config/logger.ts";

const log = createLogger("repo-identity");

export interface RepoIdentity {
  repoId: string;
  workspace?: string;
  repoSlug?: string;
  host?: string;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function normalizePath(pathname: string): string {
  return pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parseSshUrl(repoUrl: string): { host?: string; path?: string } {
  const match = repoUrl.match(/^git@([^:]+):(.+)$/);
  if (!match) return {};
  return { host: match[1], path: match[2] };
}

export function repoIdFromSlug(workspace: string, repoSlug: string): string {
  return `${workspace}/${repoSlug}`;
}

/**
 * Derive a stable repoId from a repository URL. For Bitbucket URLs, the repoId
 * is "workspace/repoSlug". For other URLs, it falls back to "host/path".
 */
export function deriveRepoIdFromUrl(repoUrl: string): RepoIdentity {
  const trimmed = repoUrl.trim();

  try {
    const url = new URL(trimmed);
    const host = url.host;
    const cleanedPath = stripGitSuffix(normalizePath(url.pathname));
    const parts = cleanedPath.split("/").filter(Boolean);

    if (host.includes("bitbucket.org") && parts.length >= 2) {
      return {
        repoId: repoIdFromSlug(parts[0]!, parts[1]!),
        workspace: parts[0]!,
        repoSlug: parts[1]!,
        host,
      };
    }

    return {
      repoId: `${host}/${parts.join("/")}`,
      host,
    };
  } catch {
    // Handle SSH-style URLs like git@bitbucket.org:workspace/repo.git
    const { host, path } = parseSshUrl(trimmed);
    if (host && path) {
      const cleanedPath = stripGitSuffix(normalizePath(path));
      const parts = cleanedPath.split("/").filter(Boolean);
      if (host.includes("bitbucket.org") && parts.length >= 2) {
        return {
          repoId: repoIdFromSlug(parts[0]!, parts[1]!),
          workspace: parts[0]!,
          repoSlug: parts[1]!,
          host,
        };
      }
      return { repoId: `${host}/${parts.join("/")}`, host };
    }
  }

  log.warn({ repoUrl }, "Failed to parse repo URL; using raw value as repoId");
  return { repoId: trimmed };
}
