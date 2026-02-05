export type IndexPhase =
  | "queued"
  | "cloning"
  | "detecting-framework"
  | "parsing"
  | "building-graph"
  | "generating-embeddings"
  | "complete"
  | "failed";

export interface IndexJob {
  id: string;
  repoUrl: string;
  branch: string;
  tokenKey?: string;
  framework?: string;
  incremental?: boolean;
  changedFiles?: string[];
  includeEmbeddings?: boolean; // opt-in for embeddings (default: false)
  createdAt: string;
}

export interface IndexStatus {
  id: string;
  phase: IndexPhase;
  percentage: number;
  repoId?: string;
  repoUrl?: string;
  branch?: string;
  framework?: string;
  filesProcessed: number;
  totalFiles: number;
  functionsIndexed: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
}
