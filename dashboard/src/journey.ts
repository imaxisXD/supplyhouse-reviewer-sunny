import { useCallback, useEffect, useState } from "react";
import { getJourney, setJourney } from "./api/client";

const STEP_ORDER = ["submit", "review", "results", "explore"] as const;

export type JourneyStepId = typeof STEP_ORDER[number];

export interface JourneyStep {
  id: JourneyStepId;
  title: string;
  description: string;
  sidebarLabel: string;
  hint?: string;
}

export const journeySteps: JourneyStep[] = [
  {
    id: "submit",
    title: "Step 1 - Submit a PR review",
    description: "You land here first. Paste a Bitbucket PR URL and token to start.",
    sidebarLabel: "Submit review",
    hint: "You are here. Fill the form below to begin.",
  },
  {
    id: "review",
    title: "Step 2 - Live review stream",
    description: "Track phases, agent progress, and live findings in real time.",
    sidebarLabel: "Live review",
    hint: "We open this view right after submission.",
  },
  {
    id: "results",
    title: "Step 3 - Results and exports",
    description: "Triage findings, export JSON or CSV, and share summaries.",
    sidebarLabel: "Results",
    hint: "Results open automatically when the review completes.",
  },
  {
    id: "explore",
    title: "Step 4 - Explore repos and metrics",
    description: "Index repos, inspect knowledge graphs, and monitor observability.",
    sidebarLabel: "Explore",
    hint: "Index a repo next to unlock graphs and metrics.",
  },
];

const DEFAULT_STEP: JourneyStepId = "submit";

type JourneyUpdateDetail = { step: JourneyStepId };
let cachedStep: JourneyStepId = DEFAULT_STEP;
let cachedLoaded = false;
let inflightLoad: Promise<JourneyStepId> | null = null;

export function stepIndex(step: JourneyStepId): number {
  return STEP_ORDER.indexOf(step);
}

function publishJourneyStep(step: JourneyStepId): void {
  cachedStep = step;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<JourneyUpdateDetail>("sh-journey-update", { detail: { step } }));
}

async function loadJourneyStep(): Promise<JourneyStepId> {
  if (cachedLoaded) return cachedStep;
  if (inflightLoad) return inflightLoad;
  inflightLoad = getJourney()
    .then((state) => {
      publishJourneyStep(state.step);
      cachedLoaded = true;
      return cachedStep;
    })
    .catch(() => {
      cachedLoaded = true;
      return cachedStep;
    })
    .finally(() => {
      inflightLoad = null;
    });
  return inflightLoad;
}

export async function advanceJourneyStep(step: JourneyStepId): Promise<JourneyStepId> {
  const current = cachedLoaded ? cachedStep : await loadJourneyStep();
  if (stepIndex(step) <= stepIndex(current)) return current;

  publishJourneyStep(step);
  try {
    const updated = await setJourney(step);
    publishJourneyStep(updated.step);
    return updated.step;
  } catch {
    return cachedStep;
  }
}

export type JourneyStatus = "complete" | "current" | "upcoming";

export function getJourneyStatus(currentStep: JourneyStepId, step: JourneyStepId): JourneyStatus {
  const currentIndex = stepIndex(currentStep);
  const stepPosition = stepIndex(step);
  if (stepPosition < currentIndex) return "complete";
  if (stepPosition === currentIndex) return "current";
  return "upcoming";
}

export function useJourney() {
  const [currentStep, setCurrentStep] = useState<JourneyStepId>(cachedStep);
  const [loading, setLoading] = useState(!cachedLoaded);

  useEffect(() => {
    let isMounted = true;
    if (!cachedLoaded) {
      loadJourneyStep()
        .then((step) => {
          if (!isMounted) return;
          setCurrentStep(step);
          setLoading(false);
        })
        .catch(() => {
          if (!isMounted) return;
          setLoading(false);
        });
    } else {
      setLoading(false);
    }

    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<JourneyUpdateDetail>).detail;
      if (!detail?.step) return;
      setCurrentStep(detail.step);
      setLoading(false);
    };

    if (typeof window !== "undefined") {
      window.addEventListener("sh-journey-update", handleUpdate as EventListener);
    }
    return () => {
      isMounted = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("sh-journey-update", handleUpdate as EventListener);
      }
    };
  }, []);

  const advanceStep = useCallback((step: JourneyStepId) => {
    void advanceJourneyStep(step).then((next) => setCurrentStep(next));
  }, []);

  return { currentStep, advanceStep, loading };
}
