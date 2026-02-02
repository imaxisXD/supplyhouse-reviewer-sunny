import { Worker } from "bullmq";
import type { Job } from "bullmq";
import type { ReviewJob } from "../types/review.ts";
import { executeReview } from "../review/workflow.ts";
import { createLogger } from "../config/logger.ts";
import { deleteToken } from "../utils/token-store.ts";
import { reviewQueue, QUEUE_NAME, REDIS_URL } from "./queue-instance.ts";

export { reviewQueue };

const log = createLogger("review-worker");

/**
 * Start the review worker. Call this once at application startup.
 */
export function startReviewWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const data = job.data as ReviewJob;
      log.info({ jobId: data.id, prUrl: data.prUrl }, "Review job started");
      await processJob(data);
    },
    {
      connection: { url: REDIS_URL },
      concurrency: 2,
      limiter: {
        max: 5,
        duration: 60_000,
      },
    },
  );

  worker.on("completed", async (job) => {
    log.info({ jobId: job?.id }, "Review job completed");
    const tokenKey = (job?.data as ReviewJob | undefined)?.tokenKey;
    if (tokenKey) {
      await deleteToken(tokenKey).catch(() => {});
    }
  });

  worker.on("failed", async (job, error) => {
    log.error({ jobId: job?.id, error: error.message }, "Review job failed");
    if (job) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        const tokenKey = (job.data as ReviewJob | undefined)?.tokenKey;
        if (tokenKey) {
          await deleteToken(tokenKey).catch(() => {});
        }
      }
    }
  });

  log.info("Review worker started");
  return worker;
}

async function processJob(job: ReviewJob): Promise<void> {
  try {
    const result = await executeReview(job);

    log.info(
      {
        reviewId: job.id,
        totalFindings: result.summary.totalFindings,
        durationMs: result.summary.durationMs,
      },
      "Review job completed",
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    log.error(
      { reviewId: job.id, error: errorMessage },
      "Review job failed",
    );
    throw error;
  }
}
