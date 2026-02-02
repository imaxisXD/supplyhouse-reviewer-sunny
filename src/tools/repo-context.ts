import { AsyncLocalStorage } from "async_hooks";

export interface RepoContext {
  repoId: string;
  repoPath: string;
}

const storage = new AsyncLocalStorage<RepoContext>();

export function runWithRepoContext<T>(context: RepoContext, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(context, fn);
}

export function getRepoContext(): RepoContext | undefined {
  return storage.getStore();
}
