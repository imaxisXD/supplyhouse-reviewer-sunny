import { useState, useRef, useEffect } from "react";
import { connectIndexWebSocket } from "../api/websocket";
import { useIndexJobs, useIndexFrameworks, useSubmitIndex, useSubmitIncrementalIndex, useCancelIndex } from "../api/hooks";
import type { IndexFramework } from "../api/types";
import { advanceJourneyStep } from "../journey";
import {
  panelClass, panelTitleClass, labelClass, inputClass, buttonPrimaryClass,
  statCardClass, statLabelClass, tableHeaderClass, tableRowClass, tableCellClass, badgeBaseClass,
} from "../utils/styles";
import { IconArrowDiagonalOut2Outline24 } from "nucleo-core-essential-outline-24";

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
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("main");
  const [framework, setFramework] = useState("");
  const [frameworkMode, setFrameworkMode] = useState<"auto" | "manual">("auto");
  const [incremental, setIncremental] = useState(false);
  const [changedFiles, setChangedFiles] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<IndexJob | null>(null);
  const { trigger: triggerIndex, isMutating: loading } = useSubmitIndex();
  const { trigger: triggerIncremental } = useSubmitIncrementalIndex();
  const { trigger: triggerCancel, isMutating: cancelling } = useCancelIndex();
  const { data: jobsData, mutate: mutateJobs } = useIndexJobs({ limit: 20 });
  const pastJobs = jobsData?.jobs ?? [];
  const { data: frameworksData } = useIndexFrameworks();
  const frameworks: IndexFramework[] = (frameworksData?.frameworks ?? []) as IndexFramework[];
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void advanceJourneyStep("explore");
  }, []);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleReindex = (pastJob: Record<string, unknown>) => {
    setRepoUrl((pastJob.repoUrl as string) ?? "");
    setBranch((pastJob.branch as string) ?? "master");
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

  const buildFullToken = () => {
    const trimmedEmail = email.trim();
    const trimmedToken = token.trim();
    if (trimmedEmail) return `${trimmedEmail}:${trimmedToken}`;
    return trimmedToken;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    try {
      const frameworkOverride = frameworkMode === "manual" ? framework || undefined : undefined;
      const files = changedFiles.split("\n").map((f) => f.trim()).filter(Boolean);
      const fullToken = buildFullToken();

      if (incremental && files.length === 0) {
        throw new Error("Provide at least one changed file for incremental indexing.");
      }

      const res = incremental
        ? await triggerIncremental({ repoUrl, token: fullToken, branch: branch || undefined, framework: frameworkOverride, changedFiles: files })
        : await triggerIndex({ repoUrl, token: fullToken, branch: branch || undefined, framework: frameworkOverride });

      const indexId = (res as { indexId: string }).indexId;

      setJob({
        id: indexId,
        phase: "queued",
        percentage: 0,
        filesProcessed: 0,
        totalFiles: 0,
        functionsIndexed: 0,
      });

      cleanupRef.current?.();

      cleanupRef.current = connectIndexWebSocket(indexId, (event) => {
        setJob((prev) => {
          if (!prev) return prev;
          const phase = (event.phase as string) ?? prev.phase;
          const nextError = typeof event.error === "string" ? event.error : phase === "failed" ? prev.error : undefined;
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

        const phase = event.phase as string | undefined;
        if (phase === "complete" || phase === "failed") {
          cleanupRef.current?.();
          void mutateJobs();
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start indexing");
    }
  };

  const handleCancel = async () => {
    if (!job || cancelling) return;
    setError("");
    try {
      await triggerCancel(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel indexing");
    }
  };

  const isTerminal = job?.phase === "complete" || job?.phase === "failed";
  const isRunning = !!job && !isTerminal;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Indexing</div>
        <h1 className="mt-2 text-2xl font-semibold text-ink-950">Index Repository</h1>
        <p className="mt-2 text-sm text-ink-700">
          Index a repository to enable code-aware reviews with graph and vector search.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className={panelClass}>
          <div className={panelTitleClass}>New Index Job</div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            <div>
              <label htmlFor="repo-url" className={labelClass}>Repository URL</label>
              <input
                id="repo-url"
                type="url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://bitbucket.org/workspace/repo"
                className={`${inputClass} mt-2`}
                autoComplete="url"
              />
            </div>

            <div>
              <label htmlFor="bb-email" className={labelClass}>Email</label>
              <input
                id="bb-email"
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your Bitbucket e-mail"
                className={`${inputClass} mt-2`}
                autoComplete="email"
              />
              <a
                href="https://bitbucket.org/account/settings/"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[10px] text-brand-600 hover:underline"
              >
                Find your email
                <IconArrowDiagonalOut2Outline24 size={12} />
              </a>
            </div>

            <div>
              <label htmlFor="access-token" className={labelClass}>Token</label>
              <input
                id="access-token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Enter token"
                className={`${inputClass} mt-2`}
                autoComplete="current-password"
              />
              <details className="mt-2 text-[10px] text-ink-600">
                <summary className="cursor-pointer hover:text-ink-900 transition">
                  How to connect using a Personal Access Token
                </summary>
                <div className="mt-2 border border-dashed border-ink-900 bg-warm-50 p-3 space-y-2 text-ink-700">
                  <p>
                    1. Create a{" "}
                    <a
                      href="https://bitbucket.org/account/settings/app-passwords/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-600 hover:underline"
                    >
                      Personal Access Token
                    </a>{" "}
                    on Bitbucket
                  </p>
                  <p>2. Ensure the required scopes are checked:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      "read:repository:bitbucket",
                      "read:pullrequest:bitbucket",
                      "write:pullrequest:bitbucket",
                    ].map((scope) => (
                      <span
                        key={scope}
                        className="inline-block border border-ink-900 bg-white px-2 py-0.5 font-mono text-[10px] text-ink-700"
                      >
                        {scope}
                      </span>
                    ))}
                  </div>
                </div>
              </details>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="branch" className={labelClass}>Branch</label>
                <input
                  id="branch"
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="master"
                  className={`${inputClass} mt-2`}
                />
              </div>
              <div>
                <label className={labelClass}>Framework</label>
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-4 text-xs text-ink-700">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="frameworkMode"
                        value="auto"
                        checked={frameworkMode === "auto"}
                        onChange={() => { setFrameworkMode("auto"); setFramework(""); }}
                        className="accent-brand-500"
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
                        className="accent-brand-500"
                      />
                      Manual
                    </label>
                  </div>
                  <select
                    value={framework}
                    onChange={(e) => setFramework(e.target.value)}
                    disabled={frameworkMode === "auto"}
                    className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <option value="">Select framework</option>
                    {frameworks.length > 0
                      ? frameworks.map((fw) => <option key={fw.id} value={fw.id}>{fw.name}</option>)
                      : (
                          <>
                            <option value="react">React</option>
                            <option value="typescript">TypeScript</option>
                            <option value="java">Java</option>
                            <option value="spring-boot">Spring Boot</option>
                          </>
                        )}
                  </select>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs text-ink-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={incremental}
                  onChange={(e) => setIncremental(e.target.checked)}
                  className="accent-brand-500"
                />
                Incremental indexing (only re-index changed files)
              </label>
              {incremental && (
                <div>
                  <label htmlFor="changed-files" className={labelClass}>Changed Files</label>
                  <textarea
                    id="changed-files"
                    value={changedFiles}
                    onChange={(e) => setChangedFiles(e.target.value)}
                    placeholder="src/app.ts\nsrc/api/user.ts"
                    rows={4}
                    className={`${inputClass} mt-2`}
                  />
                </div>
              )}
            </div>

            {error && (
              <div className="border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                {error}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={loading || isRunning}
                className={`${buttonPrimaryClass} flex-1`}
              >
                {loading ? "Submitting…" : isRunning ? "Indexing…" : "Start Indexing"}
              </button>
              {job && !isTerminal && (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                className="inline-flex items-center justify-center gap-2 border border-rose-400/50 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-rose-700 transition hover:border-rose-500"
                >
                  {cancelling ? "Cancelling…" : "Cancel"}
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="space-y-6">
          {job && (
            <div className={panelClass}>
              <div className={panelTitleClass}>Current Job</div>

              <div className="mt-4">
                <div className="flex justify-between text-xs text-ink-600 mb-2">
                  <span>Phase: {job.phase}</span>
                  <span className="tabular-nums">{job.percentage}%</span>
                </div>
                <div className="h-1.5 w-full bg-warm-200">
                  <div
                    className={`h-full ${job.phase === "failed" ? "bg-rose-500" : "bg-brand-500"}`}
                    style={{ width: `${job.percentage}%` }}
                  />
                </div>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className={statCardClass}>
                  <div className={statLabelClass}>Files</div>
                  <div className="mt-2 text-xl font-semibold text-ink-950 tabular-nums">{job.filesProcessed}/{job.totalFiles}</div>
                </div>
                <div className={statCardClass}>
                  <div className={statLabelClass}>Functions</div>
                  <div className="mt-2 text-xl font-semibold text-ink-950 tabular-nums">{job.functionsIndexed}</div>
                </div>
                <div className={statCardClass}>
                  <div className={statLabelClass}>Status</div>
                  <div className={`mt-2 text-xl font-semibold ${job.phase === "complete" ? "text-emerald-600" : job.phase === "failed" ? "text-rose-600" : "text-brand-600"}`}>
                    {job.phase}
                  </div>
                </div>
              </div>

              {job.error && (
                <div className="mt-4 border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                  {job.error}
                </div>
              )}
            </div>
          )}

          {pastJobs.length > 0 && (
            <div className={panelClass}>
              <div className={panelTitleClass}>Recent Jobs</div>
              <div className="mt-4 overflow-hidden border border-ink-900">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className={tableHeaderClass}>Repository</th>
                      <th className={tableHeaderClass}>Status</th>
                      <th className={`${tableHeaderClass} text-right`}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pastJobs.slice(0, 5).map((pj, idx) => {
                      const url = (pj.repoUrl as string) ?? "";
                      const shortUrl = url.split("/").slice(-2).join("/");
                      const key = (pj.id as string) ?? `past-${idx}`;
                      const badgeClass =
                        pj.phase === "complete"
                          ? `${badgeBaseClass} border-emerald-500/40 bg-emerald-50 text-emerald-700`
                          : pj.phase === "failed"
                          ? `${badgeBaseClass} border-rose-500/40 bg-rose-50 text-rose-700`
                          : `${badgeBaseClass} border-ink-900 bg-warm-50 text-ink-700`;
                      return (
                        <tr key={key} className={tableRowClass}>
                          <td className={`${tableCellClass} truncate max-w-[150px]`} title={url}>{shortUrl}</td>
                          <td className={tableCellClass}>
                            <span className={badgeClass}>{pj.phase as string}</span>
                          </td>
                          <td className={`${tableCellClass} text-right`}>
                            <button
                              type="button"
                              onClick={() => handleReindex(pj)}
                              className="text-xs text-brand-600 hover:underline"
                            >
                              Re-index
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
