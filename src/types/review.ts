import type { Finding } from "./findings";

export type ReviewPhase =
  | "queued"
  | "fetching-pr"
  | "indexing"
  | "building-context"
  | "running-agents"
  | "synthesizing"
  | "posting-comments"
  | "cancelling"
  | "complete"
  | "failed";

export interface ReviewJob {
  id: string;
  prUrl: string;
  workspace: string;
  repoSlug: string;
  sourceWorkspace?: string;
  sourceRepoSlug?: string;
  prNumber: number;
  tokenKey?: string;
  branch?: string;
  options: {
    skipSecurity?: boolean;
    skipDuplication?: boolean;
    priorityFiles?: string[];
  };
  createdAt: string;
}

export interface ReviewStatus {
  id: string;
  phase: ReviewPhase;
  percentage: number;
  findings: Finding[];
  findingsCount?: number;
  currentFile?: string;
  agentsRunning?: string[];
  error?: string;
  prUrl?: string;
  startedAt: string;
  completedAt?: string;
}
