import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import { getRepoDocSummary, getReviewsList, submitReview, validateToken } from "../api/client";
import type { RepoDocSummary, ReviewListItem, TokenValidationResult } from "../api/client";
import { useJourney, journeySteps, getJourneyStatus } from "../journey";

const panelClass =
  "border border-ink-900 bg-white p-4";
const panelSoftClass = "border border-dashed border-ink-900 bg-warm-50 p-4";
const panelTitleClass = "text-[10px] uppercase tracking-[0.35em] text-ink-600";
const labelClass = "text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-600";
const inputClass =
  "w-full border border-ink-900 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-500 focus:outline-none focus:border-brand-500";
const buttonPrimaryClass =
  "inline-flex items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60";
const buttonSecondaryClass =
  "inline-flex items-center justify-center gap-2 border border-ink-900 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-ink-700 transition hover:bg-warm-100 disabled:cursor-not-allowed disabled:opacity-60";
const badgeBrandClass =
  "inline-flex items-center gap-1 border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-brand-700";
const tableHeaderClass = "px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-ink-600";
const tableRowClass = "border-t border-ink-900 hover:bg-warm-100/60 transition";
const tableCellClass = "px-4 py-3 text-ink-700";

const stepNumberClass = (active: boolean, complete: boolean) =>
  `flex h-7 w-7 items-center justify-center text-xs font-semibold ${
    complete
      ? "bg-emerald-500 text-white"
      : active
      ? "bg-brand-500 text-white"
      : "border border-ink-900 bg-warm-50 text-ink-600"
  }`;

const stepTitleClass = (active: boolean) =>
  `text-sm font-semibold ${active ? "text-ink-950" : "text-ink-600"}`;

export default function Home() {
  const navigate = useNavigate();
  const { currentStep, advanceStep, loading: journeyLoading } = useJourney();
  const [prUrl, setPrUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [skipSecurity, setSkipSecurity] = useState(false);
  const [skipDuplication, setSkipDuplication] = useState(false);
  const [priorityFiles, setPriorityFiles] = useState("");
  const [recent, setRecent] = useState<ReviewListItem[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);

  // Token validation state
  const [validating, setValidating] = useState(false);
  const [tokenValid, setTokenValid] = useState(false);
  const [validationResult, setValidationResult] = useState<TokenValidationResult | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [repoDocSummary, setRepoDocSummary] = useState<RepoDocSummary | null>(null);
  const [repoDocLoading, setRepoDocLoading] = useState(false);
  const [repoDocError, setRepoDocError] = useState("");

  const prUrlPattern = /^https?:\/\/bitbucket\.org\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+/;
  const prUrlValid = prUrlPattern.test(prUrl);

  const repoIdFromPrUrl = useMemo(() => {
    return (value: string): string | null => {
      try {
        const url = new URL(value);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `${parts[0]}/${parts[1]}`;
        }
      } catch {
        // ignore
      }
      return null;
    };
  }, []);

  // Reset validation when inputs change
  useEffect(() => {
    setTokenValid(false);
    setValidationResult(null);
  }, [prUrl, email, token]);

  useEffect(() => {
    if (!prUrlValid) {
      setRepoDocSummary(null);
      setRepoDocError("");
      setRepoDocLoading(false);
      return;
    }

    const repoId = repoIdFromPrUrl(prUrl);
    if (!repoId) {
      setRepoDocSummary(null);
      setRepoDocError("");
      return;
    }

    setRepoDocSummary(null);
    setRepoDocLoading(true);
    let active = true;
    const timer = setTimeout(() => {
      setRepoDocError("");
      getRepoDocSummary(repoId)
        .then((summary) => {
          if (!active) return;
          setRepoDocSummary(summary);
        })
        .catch((err) => {
          if (!active) return;
          setRepoDocSummary(null);
          setRepoDocError(err instanceof Error ? err.message : "Failed to load repo docs");
        })
        .finally(() => {
          if (!active) return;
          setRepoDocLoading(false);
        });
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [prUrlValid, prUrl, repoIdFromPrUrl]);

  useEffect(() => {
    setRecentLoading(true);
    getReviewsList(10)
      .then((res) => {
        setRecent(res.reviews);
        if (res.reviews.length > 0) {
          advanceStep("results");
        }
      })
      .catch(() => setRecent([]))
      .finally(() => setRecentLoading(false));
  }, [advanceStep]);

  const buildFullToken = () => {
    const trimmedEmail = email.trim();
    const trimmedToken = token.trim();
    if (trimmedEmail) {
      return `${trimmedEmail}:${trimmedToken}`;
    }
    return trimmedToken;
  };

  const handleValidate = async () => {
    setError("");
    if (!prUrlValid) {
      setError("Enter a valid Bitbucket PR URL first");
      return;
    }
    if (!token.trim()) {
      setError("Token is required");
      return;
    }

    setValidating(true);
    try {
      const result = await validateToken(prUrl, buildFullToken());
      setValidationResult(result);
      if (result.valid) {
        setTokenValid(true);
      } else {
        setTokenValid(false);
        setError(result.error ?? "Token validation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation request failed");
      setTokenValid(false);
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!tokenValid) {
      setError("Please validate your token first");
      return;
    }

    setLoading(true);
    try {
      const { reviewId } = await submitReview({
        prUrl,
        token: buildFullToken(),
        options: {
          skipSecurity,
          skipDuplication,
          priorityFiles: priorityFiles
            ? priorityFiles.split(",").map((f) => f.trim()).filter(Boolean)
            : undefined,
        },
      });
      advanceStep("review");
      navigate(`/review/${reviewId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setLoading(false);
    }
  };

  const isFirstRun = !journeyLoading && !recentLoading && recent.length === 0 && currentStep === "submit";

  const activeStep = journeySteps.find((step) => step.id === currentStep);
  const repoIdForDocs = prUrlValid ? repoIdFromPrUrl(prUrl) : null;
  const dossierPatternStyle: CSSProperties = {
    backgroundImage:
      "repeating-linear-gradient(135deg, rgba(30,41,59,0.08) 0, rgba(30,41,59,0.08) 1px, transparent 1px, transparent 7px)",
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Code Review Agent</div>
          <h1 className="mt-2 text-2xl font-semibold text-ink-950">AI Code Review Agent</h1>
          <p className="mt-2 text-sm text-ink-700">
            Paste a Bitbucket pull request URL to start an AI-powered code review.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 border border-ink-900 bg-white px-3 py-2 text-xs text-ink-700">
            <span className="h-2 w-2 bg-brand-500" />
            Bitbucket
          </div>
        </div>
      </div>

      <div className={panelClass}>
        <div className="flex flex-wrap items-center gap-4">
          {journeySteps.map((step) => {
            const status = getJourneyStatus(currentStep, step.id);
            const bar =
              status === "complete"
                ? "bg-brand-500"
                : status === "current"
                ? "bg-brand-500/70"
                : "bg-warm-200";
            const label =
              status === "current"
                ? "text-brand-600"
                : status === "complete"
                ? "text-emerald-600"
                : "text-ink-600";
            return (
              <div key={step.id} className="flex-1 min-w-[140px]">
                <div className={`h-1 ${bar}`} />
                <div className={`mt-2 text-[10px] uppercase tracking-[0.35em] ${label}`}>
                  {step.sidebarLabel}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-600">
          <span>{activeStep?.description}</span>
          {activeStep?.hint && (
            <span className="text-brand-600">{activeStep.hint}</span>
          )}
        </div>
      </div>

      {isFirstRun && (
        <section className={panelSoftClass}>
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div>
              <span className={badgeBrandClass}>Empty dashboard</span>
              <h2 className="mt-3 text-lg font-semibold text-ink-950">Go, complete step one</h2>
              <p className="mt-2 text-sm text-ink-700">
                Your dashboard is empty until the first review finishes. Start with the PR URL and token below.
              </p>
            </div>
            <a href="#new-review" className={buttonPrimaryClass}>
              Start review
            </a>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] gap-6">
        <div className={panelClass} id="new-review">
          <div className="flex items-center justify-between">
            <div className={panelTitleClass}>Review setup</div>
            {isFirstRun && <span className={badgeBrandClass}>Step 1</span>}
          </div>

          <form onSubmit={handleSubmit} className="mt-5 space-y-0">
            {/* ── Step 1: PR URL ── */}
            <div className="border border-ink-900 p-4">
              <div className="flex items-center gap-3">
                <span className={stepNumberClass(true, prUrlValid)}>
                  {prUrlValid ? (
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                      <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    "1"
                  )}
                </span>
                <span className={stepTitleClass(true)}>Pull Request URL</span>
              </div>
              <p className="mt-2 ml-10 text-xs text-ink-600">
                Full URL of the pull request you want to review
              </p>
              <div className="mt-3 ml-10 relative">
                <input
                  id="pr-url"
                  type="url"
                  value={prUrl}
                  onChange={(e) => setPrUrl(e.target.value)}
                  placeholder="https://bitbucket.org/workspace/repo/pull-requests/123"
                  className={`${inputClass} pr-10`}
                  autoComplete="url"
                />
                {prUrlValid && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500">
                    <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M5 8l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                )}
              </div>
            </div>

            {/* ── Repository Docs ── */}
            <div className={`border border-t-0 border-ink-900 p-4 ${!prUrlValid ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-3">
                <span className="flex h-7 w-7 items-center justify-center border border-ink-900 bg-warm-50 text-[9px] font-semibold uppercase tracking-[0.3em] text-ink-700">
                  Docs
                </span>
                <span className={stepTitleClass(prUrlValid)}>Repository Docs</span>
                {repoDocLoading ? (
                  <span className="inline-flex items-center gap-1 border border-ink-900/40 bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-700">
                    Checking
                  </span>
                ) : repoDocSummary?.hasDocs ? (
                  <span className="inline-flex items-center gap-1 border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                    Available
                  </span>
                ) : repoDocError ? (
                  <span className="inline-flex items-center gap-1 border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-rose-700">
                    Error
                  </span>
                ) : prUrlValid ? (
                  <span className="inline-flex items-center gap-1 border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-700">
                    Not found
                  </span>
                ) : null}
              </div>
              <p className="mt-2 ml-10 text-xs text-ink-600">
                Repo-specific rules and conventions that will be injected into the review agents.
              </p>

              <div className="mt-3 ml-10 relative border border-ink-900/70 bg-warm-50/80 p-4 overflow-hidden">
                <div className="absolute inset-0 pointer-events-none opacity-50" style={dossierPatternStyle} />
                <div className="absolute inset-y-0 left-0 w-1 bg-brand-500/80" />
                <div className="relative space-y-3">
                  {repoDocLoading && (
                    <div className="text-xs text-ink-500">Checking repo docs…</div>
                  )}

                  {repoDocError && (
                    <div className="text-xs text-rose-700">
                      {repoDocError}
                    </div>
                  )}

                  {!repoDocLoading && !repoDocError && repoDocSummary?.hasDocs && (
                    <>
                      <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.3em] text-ink-600">
                        <span>{repoDocSummary.docCount} docs</span>
                        {repoDocSummary.latestUpdatedAt && (
                          <span>Updated {repoDocSummary.latestUpdatedAt}</span>
                        )}
                      </div>
                      <div className="max-h-40 overflow-y-auto pr-2 border border-ink-900/20 bg-white/60 p-3">
                        <ReactMarkdown
                          components={{
                            h3: ({ children }) => (
                              <h3 className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-700 mt-2 mb-1">
                                {children}
                              </h3>
                            ),
                            p: ({ children }) => <p className="text-xs text-ink-700 mb-2">{children}</p>,
                            em: ({ children }) => <em className="text-ink-600">{children}</em>,
                            ul: ({ children }) => <ul className="list-disc ml-4 text-xs text-ink-700 space-y-1">{children}</ul>,
                            li: ({ children }) => <li>{children}</li>,
                          }}
                        >
                          {repoDocSummary.summaryMarkdown}
                        </ReactMarkdown>
                      </div>
                      {repoIdForDocs && (
                        <Link
                          to={`/repo/${encodeURIComponent(repoIdForDocs)}/docs`}
                          className="text-xs text-brand-600 hover:underline"
                        >
                          Open full docs →
                        </Link>
                      )}
                    </>
                  )}

                  {!repoDocLoading && !repoDocError && !repoDocSummary?.hasDocs && prUrlValid && (
                    <div className="text-xs text-ink-600">
                      No docs found for this repo yet.
                      {repoIdForDocs && (
                        <Link
                          to={`/repo/${encodeURIComponent(repoIdForDocs)}/docs`}
                          className="ml-2 text-brand-600 hover:underline"
                        >
                          Create docs →
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Step 2: Token Validation ── */}
            <div className={`border border-t-0 border-ink-900 p-4 ${!prUrlValid ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-3">
                <span className={stepNumberClass(prUrlValid, tokenValid)}>
                  {tokenValid ? (
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5">
                      <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    "2"
                  )}
                </span>
                <span className={stepTitleClass(prUrlValid)}>Personal Access Token</span>
              </div>
              <p className="mt-2 ml-10 text-xs text-ink-600">
                Enter your personal access token to access the pull request
              </p>

              <div className="mt-3 ml-10 space-y-3">
                <div>
                  <label htmlFor="bb-email" className={labelClass}>
                    Email
                  </label>
                  <input
                    id="bb-email"
                    type="text"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your Bitbucket e-mail"
                    disabled={!prUrlValid}
                    className={`${inputClass} mt-1`}
                    autoComplete="email"
                  />
                  <a
                    href="https://bitbucket.org/account/settings/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
                  >
                    Find your email
                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3">
                      <path d="M3.5 2H10V8.5M10 2L2 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </a>
                </div>

                <div>
                  <label htmlFor="bb-token" className={labelClass}>
                    Token
                  </label>
                  <div className="mt-1 flex gap-0">
                    <input
                      id="bb-token"
                      type="password"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Enter token"
                      disabled={!prUrlValid}
                      className={`${inputClass} flex-1`}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      onClick={handleValidate}
                      disabled={!prUrlValid || !token.trim() || validating}
                      className={`${buttonSecondaryClass} shrink-0 border-l-0`}
                    >
                      {validating ? (
                        "Validating…"
                      ) : tokenValid ? (
                        <>
                          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 text-emerald-500">
                            <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          Valid
                        </>
                      ) : (
                        "Validate"
                      )}
                    </button>
                  </div>
                </div>

                {/* Validation success info */}
                {tokenValid && validationResult?.pr && (
                  <div className="border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-800 space-y-1">
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 text-emerald-500">
                        <path d="M3 8.5l3.5 3.5L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="font-semibold">Token verified · API + Clone access confirmed</span>
                    </div>
                    {validationResult.username && (
                      <div className="text-emerald-600">
                        Bitbucket user: <span className="font-mono font-semibold">{validationResult.username}</span>
                      </div>
                    )}
                    <div className="text-emerald-700">
                      PR: {validationResult.pr.title}
                    </div>
                    <div className="text-emerald-600">
                      {validationResult.pr.sourceBranch} → {validationResult.pr.targetBranch}
                      {validationResult.pr.author && ` · by ${validationResult.pr.author}`}
                    </div>
                  </div>
                )}

                {/* Help section */}
                <div className="border border-ink-900 bg-warm-50">
                  <button
                    type="button"
                    onClick={() => setShowHelp(!showHelp)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-[10px] text-ink-600 hover:text-ink-900 transition"
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
                      <text x="8" y="11.5" textAnchor="middle" fill="currentColor" fontSize="9" fontWeight="600">i</text>
                    </svg>
                    <span className="flex-1 text-left">How to connect using a Personal Access Token</span>
                    <span className="text-ink-500">{showHelp ? "−" : "›"}</span>
                  </button>
                  {showHelp && (
                    <div className="border-t border-ink-900 px-3 py-3 space-y-2 text-xs text-ink-700">
                      <p>
                        1. Create a{" "}
                        <a
                          href="https://bitbucket.org/account/settings/app-passwords/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline"
                        >
                          Personal Access Token
                          <svg viewBox="0 0 12 12" fill="none" className="ml-0.5 inline h-3 w-3">
                            <path d="M3.5 2H10V8.5M10 2L2 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </a>{" "}
                        on Bitbucket
                      </p>
                      <p>2. Ensure the required scopes are checked:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          "read:pullrequest:bitbucket",
                          "write:pullrequest:bitbucket",
                          "read:workspace:bitbucket",
                          "read:repository:bitbucket",
                          "read:user:bitbucket",
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
                  )}
                </div>
              </div>
            </div>

            {/* ── Step 3: Options & Submit ── */}
            <div className={`border border-t-0 border-ink-900 p-4 ${!tokenValid ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-3">
                <span className={stepNumberClass(tokenValid, false)}>3</span>
                <span className={stepTitleClass(tokenValid)}>Review Options & Submit</span>
              </div>

              <div className="mt-3 ml-10 space-y-4">
                <div className="border border-ink-900 bg-warm-50">
                  <button
                    type="button"
                    onClick={() => tokenValid && setShowOptions(!showOptions)}
                    disabled={!tokenValid}
                    className="flex w-full items-center justify-between px-4 py-3 text-[10px] uppercase tracking-[0.35em] text-ink-600 hover:text-ink-900 transition disabled:cursor-not-allowed"
                  >
                    Review options
                    <span>{showOptions ? "−" : "+"}</span>
                  </button>
                  {showOptions && (
                    <div className="border-t border-ink-900 px-4 py-4 space-y-4">
                      <label className="flex items-center gap-3 text-xs text-ink-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={skipSecurity}
                          onChange={(e) => setSkipSecurity(e.target.checked)}
                          className="h-4 w-4 border-ink-900 bg-white accent-brand-500"
                        />
                        Skip security analysis
                      </label>
                      <label className="flex items-center gap-3 text-xs text-ink-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={skipDuplication}
                          onChange={(e) => setSkipDuplication(e.target.checked)}
                          className="h-4 w-4 border-ink-900 bg-white accent-brand-500"
                        />
                        Skip duplication analysis
                      </label>
                      <div>
                        <label htmlFor="priority-files" className={labelClass}>Priority Files</label>
                        <input
                          id="priority-files"
                          type="text"
                          value={priorityFiles}
                          onChange={(e) => setPriorityFiles(e.target.value)}
                          placeholder="src/api/auth.ts, src/db/queries.ts…"
                          className={`${inputClass} mt-2`}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="border border-rose-400/50 bg-rose-50 p-3 text-xs text-rose-700">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!tokenValid || loading}
                  className={`${buttonPrimaryClass} w-full`}
                >
                  {loading ? "Submitting…" : "Start Review"}
                </button>
              </div>
            </div>
          </form>
        </div>

        <div className={panelClass}>
          <div className="flex items-center justify-between">
            <div className={panelTitleClass}>Recent Reviews</div>
            <span className="text-[10px] uppercase tracking-[0.35em] text-ink-600">Last 10</span>
          </div>

          {recentLoading && <div className="mt-4 text-xs text-ink-600">Loading…</div>}

          {!recentLoading && recent.length === 0 && (
            <div className="mt-6 border border-dashed border-ink-900 bg-warm-50 p-6 text-sm text-ink-700">
              <div className="text-[10px] uppercase tracking-[0.3em] text-ink-600">Empty state</div>
              <p className="mt-2">
                No completed reviews yet. Step 3 will appear here when your first review finishes.
              </p>
            </div>
          )}

          {recent.length > 0 && (
            <div className="mt-4 overflow-hidden border border-ink-900">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className={tableHeaderClass}>Review</th>
                    <th className={`${tableHeaderClass} text-right`}>Findings</th>
                    <th className={`${tableHeaderClass} text-right`}>Duration</th>
                    <th className={`${tableHeaderClass} text-right`}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((review) => (
                    <tr key={review.id} className={tableRowClass}>
                      <td className={tableCellClass}>
                        <Link
                          to={`/review/${review.id}/results`}
                          className="font-mono text-[11px] text-brand-600 hover:underline"
                        >
                          {review.id.slice(0, 8)}…
                        </Link>
                      </td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{review.totalFindings}</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>{(review.durationMs / 1000).toFixed(1)}s</td>
                      <td className={`${tableCellClass} text-right tabular-nums`}>${review.costUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
