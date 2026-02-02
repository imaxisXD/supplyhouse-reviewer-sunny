import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getReviewStatus, connectWebSocket, cancelReview } from "../api/client";
import type { ReviewStatus as ReviewStatusType, WSEvent } from "../api/client";
import ProgressBar from "../components/ProgressBar";
import PhaseIndicator from "../components/PhaseIndicator";

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
        return "text-red-400";
      case "high":
        return "text-orange-400";
      case "medium":
        return "text-yellow-400";
      case "low":
        return "text-blue-400";
      default:
        return "text-gray-400";
    }
  };

  if (error) {
    return (
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">Review Failed</h1>
        <p className="text-gray-500 text-sm mb-8 font-mono">{id}</p>
        <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg">
          <p className="text-red-300 text-sm">{error}</p>
        </div>
        {completedAgents.length > 0 && (
          <div className="mt-6">
            <p className="text-sm text-gray-400 mb-2">Agents Completed Before Failure</p>
            <div className="flex gap-2 flex-wrap">
              {completedAgents.map((a, i) => (
                <span
                  key={`${a.agent}-${i}`}
                  className="px-2.5 py-1 bg-green-900/30 border border-green-800 text-green-300 text-xs rounded-full"
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
      <div className="max-w-xl mx-auto text-center py-16 text-gray-500">
        Loading review status...
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Review in Progress</h1>
        {status.phase !== "complete" && status.phase !== "failed" && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="px-3 py-1.5 text-xs rounded-lg border border-red-800 text-red-300 hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {cancelling ? "Cancelling..." : "Cancel Review"}
          </button>
        )}
      </div>
      <p className="text-gray-500 text-sm mb-8 font-mono">{id}</p>

      <div className="space-y-8">
        <PhaseIndicator currentPhase={status.phase} />
        <ProgressBar percentage={status.percentage} label="Overall Progress" />

        {status.currentFile && (
          <div className="text-sm text-gray-400">
            Analyzing: <span className="text-gray-200 font-mono">{status.currentFile}</span>
          </div>
        )}

        {status.agentsRunning && status.agentsRunning.length > 0 && (
          <div>
            <p className="text-sm text-gray-400 mb-2">Active Agents</p>
            <div className="flex gap-2 flex-wrap">
              {status.agentsRunning.map((agent) => (
                <span
                  key={agent}
                  className="px-2.5 py-1 bg-blue-900/30 border border-blue-800 text-blue-300 text-xs rounded-full animate-pulse"
                >
                  {agent}
                </span>
              ))}
            </div>
          </div>
        )}

        {completedAgents.length > 0 && (
          <div>
            <p className="text-sm text-gray-400 mb-2">Completed Agents</p>
            <div className="flex gap-2 flex-wrap">
              {completedAgents.map((a, i) => (
                <span
                  key={`${a.agent}-${i}`}
                  className="px-2.5 py-1 bg-green-900/30 border border-green-800 text-green-300 text-xs rounded-full"
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
          <p className="text-sm text-gray-400 mb-2">
            Live Findings Feed
            {liveFindings.length > 0 && (
              <span className="ml-2 text-gray-600">({liveFindings.length})</span>
            )}
          </p>
          <div
            ref={feedRef}
            className="bg-gray-900 border border-gray-800 rounded-lg p-3 max-h-80 overflow-y-auto space-y-1.5"
          >
            {liveFindings.length === 0 && (
              <p className="text-gray-600 text-sm">Waiting for findings...</p>
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
                <span className="text-gray-200 flex-1 min-w-0 truncate">{f.title}</span>
                <span className="text-gray-500 font-mono shrink-0">
                  {f.file}:{f.line}
                </span>
                <span className="text-gray-600 shrink-0">{f.agent}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
