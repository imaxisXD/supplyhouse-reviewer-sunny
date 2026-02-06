import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useIndexedRepos } from "../api/hooks";
import { advanceJourneyStep } from "../journey";
import { panelClass, statLabelClass } from "../utils/styles";

export default function Repos() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useIndexedRepos();
  const repos = data?.repos ?? [];

  useEffect(() => {
    void advanceJourneyStep("explore");
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Repositories</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Indexed Repositories</h1>
        <p className="mt-2 text-sm text-ink-700">View the code knowledge graph for any indexed repository.</p>
      </div>

      {isLoading && <div className="text-ink-600 text-sm">Loading…</div>}

      {error && (
        <div className="border border-rose-400/50 bg-rose-50 p-5 text-rose-700 text-sm">
          {error.message}
        </div>
      )}

      {!isLoading && repos.length === 0 && !error && (
        <div className={`${panelClass} text-center py-12`}>
          <p className="text-ink-700 text-sm mb-2">No indexed repositories found.</p>
          <p className="text-xs text-ink-600">
            Index a repository from the{" "}
            <Link to="/indexing" className="text-brand-600 hover:underline">
              Indexing
            </Link>{" "}
            page first.
          </p>
        </div>
      )}

      {repos.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {repos.map((repo) => (
            <Link
              key={repo.repoId}
              to={`/repo/${encodeURIComponent(repo.repoId)}`}
              className={`${panelClass} hover:border-brand-500/50 transition-colors group`}
            >
              <h3 className="text-sm font-semibold text-ink-950 group-hover:text-brand-600 transition-colors truncate mb-4">
                {repo.repoId}
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className={statLabelClass}>Files</p>
                  <p className="text-lg font-bold text-brand-600">{repo.fileCount}</p>
                </div>
                <div>
                  <p className={statLabelClass}>Functions</p>
                  <p className="text-lg font-bold text-emerald-700">{repo.functionCount}</p>
                </div>
                <div>
                  <p className={statLabelClass}>Classes</p>
                  <p className="text-lg font-bold text-amber-700">{repo.classCount}</p>
                </div>
              </div>
              <div className="mt-4 text-xs text-ink-600 group-hover:text-ink-800 transition-colors">
                View knowledge graph →
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
