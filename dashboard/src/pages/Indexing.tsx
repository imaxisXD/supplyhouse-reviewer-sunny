import { useState, useRef, useEffect } from "react";
import { submitIndex, submitIncrementalIndex, connectIndexWebSocket, getIndexJobs, getIndexFrameworks, cancelIndex } from "../api/client";
import type { IndexFramework } from "../api/client";
import ProgressBar from "../components/ProgressBar";

interface IndexJob {
  id: string;
  phase: string;
  percentage: number;
  filesProcessed: number;
  totalFiles: number;
  functionsIndexed: number;
  error?: string;
}

export default function Indexing() {
  const [repoUrl, setRepoUrl] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("main");
  const [framework, setFramework] = useState("");
  const [frameworkMode, setFrameworkMode] = useState<"auto" | "manual">("auto");
  const [incremental, setIncremental] = useState(false);
  const [changedFiles, setChangedFiles] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [job, setJob] = useState<IndexJob | null>(null);
  const [pastJobs, setPastJobs] = useState<Record<string, unknown>[]>([]);
  const [frameworks, setFrameworks] = useState<IndexFramework[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // Fetch past indexing jobs on mount
  useEffect(() => {
    getIndexJobs(20)
      .then((data) => setPastJobs(data.jobs ?? []))
      .catch(() => {
        // Silently ignore if endpoint not available yet
      });
  }, []);

  useEffect(() => {
    getIndexFrameworks()
      .then((data) => setFrameworks(data.frameworks ?? []))
      .catch(() => setFrameworks([]));
  }, []);

  const handleReindex = (pastJob: Record<string, unknown>) => {
    setRepoUrl((pastJob.repoUrl as string) ?? "");
    setBranch((pastJob.branch as string) ?? "main");
    const pastFramework = (pastJob.framework as string) ?? "";
    if (pastFramework) {
      setFrameworkMode("manual");
      setFramework(pastFramework);
    } else {
      setFrameworkMode("auto");
      setFramework("");
    }
    setIncremental(false);
    setChangedFiles("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCancelling(false);
    setLoading(true);

    try {
      const frameworkOverride = frameworkMode === "manual" ? framework || undefined : undefined;
      const files = changedFiles
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);

      if (incremental && files.length === 0) {
        throw new Error("Provide at least one changed file for incremental indexing.");
      }

      const { indexId } = await (incremental
        ? submitIncrementalIndex({
            repoUrl,
            token,
            branch: branch || undefined,
            framework: frameworkOverride,
            changedFiles: files,
          })
        : submitIndex({
            repoUrl,
            token,
            branch: branch || undefined,
            framework: frameworkOverride,
          }));

      setJob({
        id: indexId,
        phase: "queued",
        percentage: 0,
        filesProcessed: 0,
        totalFiles: 0,
        functionsIndexed: 0,
      });

      // Cleanup any previous WebSocket
      cleanupRef.current?.();

      cleanupRef.current = connectIndexWebSocket(indexId, (event) => {
        setJob((prev) => {
          if (!prev) return prev;
          const phase = (event.phase as string) ?? prev.phase;
          const nextError =
            typeof event.error === "string"
              ? event.error
              : phase === "failed"
              ? prev.error
              : undefined;
          return {
            ...prev,
            phase,
            percentage: (event.percentage as number) ?? prev.percentage,
            filesProcessed: (event.filesProcessed as number) ?? prev.filesProcessed,
            totalFiles: (event.totalFiles as number) ?? prev.totalFiles,
            functionsIndexed: (event.functionsIndexed as number) ?? prev.functionsIndexed,
            error: nextError,
          };
        });

        // Check for terminal phases
        const phase = event.phase as string | undefined;
        if (phase === "complete" || phase === "failed") {
          cleanupRef.current?.();
          // Refresh past jobs list
          getIndexJobs(20)
            .then((data) => setPastJobs(data.jobs ?? []))
            .catch(() => {});
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start indexing");
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!job || cancelling) return;
    setCancelling(true);
    setError("");
    try {
      await cancelIndex(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel indexing");
    } finally {
      setCancelling(false);
    }
  };

  const isTerminal = job?.phase === "complete" || job?.phase === "failed";
  const isRunning = !!job && !isTerminal;

  return (
    <div className="max-w-xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Index Repository</h1>
      <p className="text-gray-400 mb-8">
        Index a repository to enable code-aware reviews with graph and vector search.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Repository URL</label>
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://bitbucket.org/workspace/repo"
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
          />
        </div>

        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Access Token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="BitBucket access token"
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Branch</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Framework</label>
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-sm text-gray-300">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="frameworkMode"
                    value="auto"
                    checked={frameworkMode === "auto"}
                    onChange={() => {
                      setFrameworkMode("auto");
                      setFramework("");
                    }}
                    className="h-4 w-4 text-blue-500 bg-gray-900 border-gray-700"
                  />
                  Auto-detect
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="frameworkMode"
                    value="manual"
                    checked={frameworkMode === "manual"}
                    onChange={() => setFrameworkMode("manual")}
                    className="h-4 w-4 text-blue-500 bg-gray-900 border-gray-700"
                  />
                  Select manually
                </label>
              </div>
              <select
                value={framework}
                onChange={(e) => setFramework(e.target.value)}
                disabled={frameworkMode === "auto"}
                className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <option value="">Select framework</option>
                {frameworks.length > 0
                  ? frameworks.map((fw) => (
                      <option key={fw.id} value={fw.id}>
                        {fw.name}
                      </option>
                    ))
                  : (
                      <>
                        <option value="react">React</option>
                        <option value="typescript">TypeScript</option>
                        <option value="java">Java</option>
                        <option value="spring-boot">Spring Boot</option>
                        <option value="flutter">Flutter</option>
                        <option value="ftl">FTL (FreeMarker)</option>
                      </>
                    )}
              </select>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={incremental}
              onChange={(e) => setIncremental(e.target.checked)}
              className="rounded border-gray-700 bg-gray-900 text-blue-500"
            />
            Incremental indexing (only re-index changed files)
          </label>
          {incremental && (
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Changed files (one per line)</label>
              <textarea
                value={changedFiles}
                onChange={(e) => setChangedFiles(e.target.value)}
                placeholder="src/app.ts\nsrc/api/user.ts"
                rows={4}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600"
              />
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading || isRunning}
            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-colors"
          >
            {loading ? "Submitting..." : isRunning ? "Indexing in Progress..." : "Start Indexing"}
          </button>
          {job && !isTerminal && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="px-4 py-2.5 border border-red-800 text-red-300 rounded-lg text-sm hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
        </div>
      </form>

      {job && (
        <div className="mt-8 space-y-4">
          <ProgressBar percentage={job.percentage} label={`Phase: ${job.phase}`} />
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-500">Files</p>
              <p className="text-lg font-bold">
                {job.filesProcessed}/{job.totalFiles}
              </p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-500">Functions</p>
              <p className="text-lg font-bold">{job.functionsIndexed}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-500">Status</p>
              <p
                className={`text-lg font-bold ${
                  job.phase === "complete"
                    ? "text-green-400"
                    : job.phase === "failed"
                    ? "text-red-400"
                    : "text-blue-400"
                }`}
              >
                {job.phase}
              </p>
            </div>
          </div>
          {job.error && (
            <div className="rounded-lg border border-red-800 bg-red-900/30 p-3 text-sm text-red-300">
              {job.error}
            </div>
          )}
        </div>
      )}

      {/* Recent Indexing Jobs */}
      {pastJobs.length > 0 && (
        <div className="mt-12">
          <h2 className="text-lg font-semibold mb-4">Recent Indexing Jobs</h2>
          <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_100px_90px_80px_80px] gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-500">
              <span>Repository</span>
              <span>Framework</span>
              <span>Phase</span>
              <span className="text-right">Files</span>
              <span className="text-right">Action</span>
            </div>
            {pastJobs.map((pj, idx) => {
              const url = (pj.repoUrl as string) ?? "";
              const truncatedUrl =
                url.length > 50 ? "..." + url.slice(url.length - 47) : url;
              const key = (pj.id as string) ?? `past-${idx}`;
              return (
                <div
                  key={key}
                  className="grid grid-cols-[1fr_100px_90px_80px_80px] gap-2 px-4 py-2.5 border-b border-gray-800/50 text-sm hover:bg-gray-800/30 transition-colors"
                >
                  <span
                    className="text-gray-300 truncate"
                    title={url}
                  >
                    {truncatedUrl}
                  </span>
                  <span className="text-gray-400 text-xs">
                    {(pj.framework as string) || "auto"}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      pj.phase === "complete"
                        ? "text-green-400"
                        : pj.phase === "failed"
                        ? "text-red-400"
                        : "text-blue-400"
                    }`}
                  >
                    {pj.phase as string}
                  </span>
                  <span className="text-right text-gray-400 font-mono text-xs">
                    {(pj.filesProcessed as number) ?? 0}
                  </span>
                  <span className="text-right">
                    <button
                      type="button"
                      onClick={() => handleReindex(pj)}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      Re-index
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
