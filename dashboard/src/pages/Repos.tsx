import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getIndexedRepos } from "../api/client";
import type { RepoInfo } from "../api/client";
import { advanceJourneyStep } from "../journey";

const panelClass =
  "border border-ink-900 bg-white p-4";
const statLabelClass = "text-[10px] uppercase tracking-[0.3em] text-ink-600";

export default function Repos() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void advanceJourneyStep("explore");
    getIndexedRepos()
      .then((data) => setRepos(data.repos ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load repos"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Repositories</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Indexed Repositories</h1>
        <p className="mt-2 text-sm text-ink-700">View the code knowledge graph for any indexed repository.</p>
      </div>

      {loading && <div className="text-ink-600 text-sm">Loading…</div>}

      {error && (
        <div className="border border-rose-400/50 bg-rose-50 p-5 text-rose-700 text-sm">
          {error}
        </div>
      )}

      {!loading && repos.length === 0 && !error && (
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
            <div
              key={repo.repoId}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/repo/${encodeURIComponent(repo.repoId)}`)}
              onKeyDown={(event) => {
                if (event.currentTarget !== event.target) {
                  return;
                }
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/repo/${encodeURIComponent(repo.repoId)}`);
                }
              }}
              className={`${panelClass} hover:border-brand-500/50 transition-colors group cursor-pointer`}
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
              <div className="mt-4 flex items-center justify-between text-xs text-ink-600 group-hover:text-ink-800 transition-colors">
                <span>View knowledge graph →</span>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    navigate(`/repo/${encodeURIComponent(repo.repoId)}/docs`);
                  }}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                  }}
                  className="text-brand-600 hover:underline"
                >
                  Docs →
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
