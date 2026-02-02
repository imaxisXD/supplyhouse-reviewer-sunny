import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getIndexedRepos } from "../api/client";
import type { RepoInfo } from "../api/client";

export default function Repos() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    getIndexedRepos()
      .then((data) => setRepos(data.repos ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load repos"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Indexed Repositories</h1>
      <p className="text-gray-400 mb-8">
        View the code knowledge graph for any indexed repository.
      </p>

      {loading && (
        <div className="text-gray-400 text-sm">Loading repositories...</div>
      )}

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
          {error}
        </div>
      )}

      {!loading && repos.length === 0 && !error && (
        <div className="text-center py-16">
          <p className="text-gray-500 text-sm">No indexed repositories found.</p>
          <p className="text-gray-600 text-xs mt-2">
            Index a repository from the{" "}
            <Link to="/indexing" className="text-blue-400 hover:text-blue-300">
              Indexing
            </Link>{" "}
            page first.
          </p>
        </div>
      )}

      {repos.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {repos.map((repo) => (
            <Link
              key={repo.repoId}
              to={`/repo/${encodeURIComponent(repo.repoId)}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-blue-500/50 hover:bg-gray-900/80 transition-colors group"
            >
              <h3 className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors truncate mb-3">
                {repo.repoId}
              </h3>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-xs text-gray-500">Files</p>
                  <p className="text-lg font-bold text-blue-400">{repo.fileCount}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Functions</p>
                  <p className="text-lg font-bold text-green-400">{repo.functionCount}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Classes</p>
                  <p className="text-lg font-bold text-purple-400">{repo.classCount}</p>
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500 group-hover:text-gray-400 transition-colors">
                View knowledge graph →
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
