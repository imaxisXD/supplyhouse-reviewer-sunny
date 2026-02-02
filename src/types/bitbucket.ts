export interface PRDetails {
  id: number;
  title: string;
  description: string;
  author: {
    displayName: string;
    uuid: string;
  };
  sourceBranch: string;
  targetBranch: string;
  sourceWorkspace?: string;
  sourceRepoSlug?: string;
  state: string;
  createdOn: string;
  updatedOn: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  diff: string;
  additions: number;
  deletions: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: DiffChange[];
}

export interface DiffChange {
  type: "add" | "delete" | "context";
  lineOld?: number;
  lineNew?: number;
  content: string;
}

