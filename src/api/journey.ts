import { Elysia, t } from "elysia";
import { redis } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("api:journey");

const JOURNEY_KEY = "journey:state";
const STEP_ORDER = ["submit", "review", "results", "explore"] as const;
type JourneyStep = typeof STEP_ORDER[number];

interface JourneyState {
  step: JourneyStep;
  updatedAt?: string;
}

function isJourneyStep(value: string): value is JourneyStep {
  return STEP_ORDER.includes(value as JourneyStep);
}

function stepIndex(step: JourneyStep): number {
  return STEP_ORDER.indexOf(step);
}

async function scanForKey(pattern: string, filter?: (key: string) => boolean): Promise<boolean> {
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 20);
    cursor = nextCursor;
    if (filter) {
      if (batch.some(filter)) return true;
    } else if (batch.length > 0) {
      return true;
    }
  } while (cursor !== "0");
  return false;
}

async function inferStepFromData(): Promise<JourneyStep> {
  try {
    const hasIndexJobs = await scanForKey("index:*");
    const hasReviewResults = await scanForKey("review:result:*");
    const hasReviewStatus = hasReviewResults
      ? true
      : await scanForKey("review:*", (key) => !key.startsWith("review:result:"));

    if (hasIndexJobs) return "explore";
    if (hasReviewResults) return "results";
    if (hasReviewStatus) return "review";
    return "submit";
  } catch (error) {
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to infer journey step from data",
    );
    return "submit";
  }
}

async function getStoredJourney(): Promise<JourneyState | null> {
  const raw = await redis.get(JOURNEY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JourneyState;
    if (!parsed || !parsed.step || !isJourneyStep(parsed.step)) return null;
    return { step: parsed.step, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export const journeyRoutes = new Elysia({ prefix: "/api" })
  .get("/journey", async () => {
    const stored = await getStoredJourney();
    if (stored) {
      return { step: stored.step, updatedAt: stored.updatedAt };
    }

    const inferred = await inferStepFromData();
    const updatedAt = new Date().toISOString();
    await redis.set(JOURNEY_KEY, JSON.stringify({ step: inferred, updatedAt }));
    return { step: inferred, updatedAt };
  })
  .put(
    "/journey",
    async ({ body, set }) => {
      if (!isJourneyStep(body.step)) {
        set.status = 400;
        return { error: "Invalid journey step" };
      }

      const stored = await getStoredJourney();
      const current = stored?.step ?? "submit";
      const next = stepIndex(body.step) > stepIndex(current) ? body.step : current;
      const updatedAt = new Date().toISOString();

      await redis.set(JOURNEY_KEY, JSON.stringify({ step: next, updatedAt }));
      return { step: next, updatedAt };
    },
    {
      body: t.Object({
        step: t.String(),
      }),
    },
  );
