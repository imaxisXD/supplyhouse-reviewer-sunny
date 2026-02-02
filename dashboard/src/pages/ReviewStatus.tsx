import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getReviewStatus, connectWebSocket, cancelReview } from "../api/client";
import type { ReviewStatus as ReviewStatusType, WSEvent } from "../api/client";
import ProgressBar from "../components/ProgressBar";
import PhaseIndicator from "../components/PhaseIndicator";
import { advanceJourneyStep } from "../journey";

const pillBaseClass = "border px-2.5 py-1 text-xs";

interface LiveFinding {
  file: string;
  line: number;
  severity: string;
  title: string;
  agent: string;
}

interface CompletedAgent {
  agent: string;
  findingsCount: number;
  durationMs: number;
}

export default function ReviewStatus() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<ReviewStatusType | null>(null);
  const [liveFindings, setLiveFindings] = useState<LiveFinding[]>([]);
  const [completedAgents, setCompletedAgents] = useState<CompletedAgent[]>([]);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void advanceJourneyStep("review");
  }, []);

  useEffect(() => {
    if (!id) return;

    getReviewStatus(id)
      .then((data) => {
        setStatus(data);
        // If review already complete when page loads, navigate to results
        if (data.phase === "complete") {
          navigate(`/review/${id}/results`);
        }
      })
      .catch((err) => setError(err.message));

    cleanupRef.current = connectWebSocket(
      id,
      (event: WSEvent) => {
        switch (event.type) {
          case "PHASE_CHANGE":
            setStatus((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                phase: event.phase ?? prev.phase,
                percentage: event.percentage ?? prev.percentage,
                currentFile: event.currentFile ?? prev.currentFile,
                agentsRunning: event.agentsRunning ?? prev.agentsRunning,
              };
            });
            break;

          case "FINDING_ADDED":
            if (event.finding) {
              setLiveFindings((prev) => [
                ...prev,
                {
                  file: event.finding!.file,
                  line: event.finding!.line,
                  severity: event.finding!.severity,
                  title: event.finding!.title,
                  agent: event.finding!.agent,
                },
              ]);
            }
            break;

          case "AGENT_COMPLETE":
            if (event.agent) {
              setCompletedAgents((prev) => [
                ...prev,
                {
                  agent: event.agent!,
                  findingsCount: event.findingsCount ?? 0,
                  durationMs: event.durationMs ?? 0,
                },
              ]);
            }
            break;

          case "REVIEW_COMPLETE":
            navigate(`/review/${id}/results`);
            break;

          case "REVIEW_FAILED":
            setError(event.error ?? "Review failed");
            setStatus((prev) => {
              if (!prev) return prev;
              return { ...prev, phase: "failed" };
            });
            break;
        }
      },
      () => {
        // WebSocket closed
      },
    );

    return () => {
      cleanupRef.current?.();
    };
  }, [id, navigate]);

  // Auto-scroll the findings feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [liveFindings]);

  const handleCancel = async () => {
    if (!id || cancelling) return;
    setCancelling(true);
    try {
      await cancelReview(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel review");
    } finally {
      setCancelling(false);
    }
  };

  const severityColor = (severity: string): string => {
    switch (severity) {
      case "critical":
        return "text-rose-700";
      case "high":
        return "text-orange-700";
      case "medium":
        return "text-amber-700";
      case "low":
        return "text-sky-700";
      default:
        return "text-ink-600";
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Review</div>
          <h1 className="mt-2 text-2xl font-semibold text-ink-950">Review Failed</h1>
          <p className="mt-2 text-sm font-mono text-ink-600">{id}</p>
        </div>
        <div className="border border-rose-400/50 bg-rose-50 p-4">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
        {completedAgents.length > 0 && (
          <div>
            <p className="text-sm text-ink-700 mb-2">Agents Completed Before Failure</p>
            <div className="flex gap-2 flex-wrap">
              {completedAgents.map((a, i) => (
                <span
                  key={`${a.agent}-${i}`}
                  className={`${pillBaseClass} border-emerald-500/40 bg-emerald-50 text-emerald-700`}
                >
                  {a.agent} ({a.findingsCount} findings)
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!status) {
    return (
      <div className="mx-auto max-w-xl text-center py-16 text-ink-600">
        Loading review status...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-[0.45em] text-ink-600">Review</div>
            <h1 className="mt-2 text-2xl font-semibold text-ink-950">Review in Progress</h1>
          </div>
        {status.phase !== "complete" && status.phase !== "failed" && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="inline-flex items-center justify-center gap-2 border border-rose-400/50 bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-rose-700 transition hover:border-rose-500"
          >
            {cancelling ? "Cancelling..." : "Cancel Review"}
          </button>
        )}
        </div>
        <p className="mt-2 text-sm font-mono text-ink-600">{id}</p>
      </div>

      <div className="space-y-8">
        <PhaseIndicator currentPhase={status.phase} />
        <ProgressBar percentage={status.percentage} label="Overall Progress" />

        {status.currentFile && (
          <div className="text-sm text-ink-700">
            Analyzing: <span className="text-ink-900 font-mono">{status.currentFile}</span>
          </div>
        )}

        {status.agentsRunning && status.agentsRunning.length > 0 && (
          <div>
            <p className="text-sm text-ink-700 mb-2">Active Agents</p>
            <div className="flex gap-2 flex-wrap">
              {status.agentsRunning.map((agent) => (
                <span
                  key={agent}
                  className={`${pillBaseClass} border-brand-500/40 bg-brand-500/10 text-brand-700 animate-pulse`}
                >
                  {agent}
                </span>
              ))}
            </div>
          </div>
        )}

        {completedAgents.length > 0 && (
          <div>
            <p className="text-sm text-ink-700 mb-2">Completed Agents</p>
            <div className="flex gap-2 flex-wrap">
              {completedAgents.map((a, i) => (
                <span
                  key={`${a.agent}-${i}`}
                  className={`${pillBaseClass} border-emerald-500/40 bg-emerald-50 text-emerald-700`}
                >
                  {a.agent}
                  <span className="ml-1.5 opacity-70">
                    {a.findingsCount} findings &middot; {(a.durationMs / 1000).toFixed(1)}s
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="text-sm text-ink-700 mb-2">
            Live Findings Feed
            {liveFindings.length > 0 && (
              <span className="ml-2 text-ink-600">({liveFindings.length})</span>
            )}
          </p>
          <div
            ref={feedRef}
            className="border border-ink-900 bg-warm-50 p-3 max-h-80 overflow-y-auto space-y-1.5"
          >
            {liveFindings.length === 0 && (
              <p className="text-ink-600 text-sm">Waiting for findings...</p>
            )}
            {liveFindings.map((f, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs"
              >
                <span
                  className={`shrink-0 font-semibold uppercase ${severityColor(f.severity)}`}
                >
                  {f.severity}
                </span>
                <span className="text-ink-900 flex-1 min-w-0 truncate">{f.title}</span>
                <span className="text-ink-600 font-mono shrink-0">
                  {f.file}:{f.line}
                </span>
                <span className="text-ink-500 shrink-0">{f.agent}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
