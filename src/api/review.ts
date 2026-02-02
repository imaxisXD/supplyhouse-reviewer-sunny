import { Elysia, t } from "elysia";
import { randomUUID } from "crypto";
import { createLogger } from "../config/logger.ts";
import { redis, publish } from "../db/redis.ts";
import { reviewQueue } from "../queue/queue-instance.ts";
import { reviewTokenKey, storeToken } from "../utils/token-store.ts";
import { markCancelled, reviewCancelKey } from "../utils/cancellation.ts";
import { bitbucketClient } from "../bitbucket/client.ts";
import { bitbucketBreaker } from "../services/breakers.ts";

const log = createLogger("api:review");

const PR_URL_REGEX =
  /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/;

function parsePrUrl(url: string) {
  const match = url.match(PR_URL_REGEX);
  if (!match) return null;
  return {
    workspace: match[1]!,
    repoSlug: match[2]!,
    prNumber: parseInt(match[3]!, 10),
  };
}

export const reviewRoutes = new Elysia({ prefix: "/api/review" })
  .post(
    "/",
    async ({ body, set }) => {
      const trimmedToken = body.token.trim();
      const trimmedUrl = body.prUrl.trim();

      if (!trimmedToken) {
        set.status = 400;
        return { error: "Token must not be empty" };
      }

      const parsed = parsePrUrl(trimmedUrl);
      if (!parsed) {
        set.status = 400;
        return { error: "Invalid BitBucket PR URL format" };
      }

      const reviewId = randomUUID();
      const tokenKey = reviewTokenKey(reviewId);
      await storeToken(tokenKey, trimmedToken);
      let branch: string | undefined;
      let sourceWorkspace: string | undefined;
      let sourceRepoSlug: string | undefined;
      try {
        const prDetails = await bitbucketBreaker.execute(() =>
          bitbucketClient.getPRDetails(
            parsed.workspace,
            parsed.repoSlug,
            parsed.prNumber,
            trimmedToken,
          ),
        );
        branch = prDetails.sourceBranch || prDetails.targetBranch || undefined;
        sourceWorkspace = prDetails.sourceWorkspace;
        sourceRepoSlug = prDetails.sourceRepoSlug;
      } catch (error) {
        log.warn(
          { reviewId, error: error instanceof Error ? error.message : String(error) },
          "Failed to resolve PR branch during submission",
        );
      }

      const job = {
        id: reviewId,
        prUrl: trimmedUrl,
        workspace: parsed.workspace,
        repoSlug: parsed.repoSlug,
        sourceWorkspace,
        sourceRepoSlug,
        prNumber: parsed.prNumber,
        tokenKey,
        branch,
        options: body.options ?? {},
        createdAt: new Date().toISOString(),
      };

      await redis.set(`review:${reviewId}`, JSON.stringify({
        id: reviewId,
        phase: "queued",
        percentage: 0,
        findings: [],
        startedAt: new Date().toISOString(),
      }));

      await reviewQueue.add("review", job, { jobId: reviewId });

      log.info({ reviewId, prUrl: trimmedUrl }, "Review submitted");

      set.status = 201;
      return { reviewId };
    },
    {
      body: t.Object({
        prUrl: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        options: t.Optional(
          t.Object({
            skipSecurity: t.Optional(t.Boolean()),
            skipDuplication: t.Optional(t.Boolean()),
            priorityFiles: t.Optional(t.Array(t.String())),
          })
        ),
      }),
    }
  )
  .get("/:id/status", async ({ params, set }) => {
    const data = await redis.get(`review:${params.id}`);
    if (!data) {
      set.status = 404;
      return { error: "Review not found" };
    }
    return JSON.parse(data);
  })
  .get("/:id/result", async ({ params, set }) => {
    const data = await redis.get(`review:result:${params.id}`);
    if (!data) {
      set.status = 404;
      return { error: "Review result not found" };
    }
    return JSON.parse(data);
  })
  .delete("/:id", async ({ params, set }) => {
    const { id } = params;
    try {
      const statusData = await redis.get(`review:${id}`);
      if (statusData) {
        try {
          const status = JSON.parse(statusData);
          if (status.phase === "complete" || status.phase === "failed") {
            return { message: `Review already ${status.phase}` };
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Set cancel flag first — worker will see it on next assertNotCancelled call
      await markCancelled(reviewCancelKey(id));

      let jobIsActive = false;
      const job = await reviewQueue.getJob(id);
      if (job) {
        const state = await job.getState();
        if (state === "active") {
          // Active jobs hold a lock — don't call moveToFailed (would throw without
          // the lock token). The worker will see the cancel flag and fail itself.
          jobIsActive = true;
        } else if (state === "waiting" || state === "delayed") {
          try {
            await job.remove();
          } catch {
            log.warn({ reviewId: id }, "Could not remove queued job, relying on cancel flag");
          }
        }
      }

      if (!jobIsActive && statusData) {
        try {
          const status = JSON.parse(statusData);
          status.phase = "failed";
          status.error = "Cancelled by user";
          status.completedAt = new Date().toISOString();
          await redis.set(`review:${id}`, JSON.stringify(status));
        } catch {
          // Ignore parse errors
        }
      }

      // Only emit REVIEW_FAILED from here when the worker is NOT active.
      // If active, the worker will emit it when it catches the cancellation error.
      if (!jobIsActive) {
        await publish(`review:events:${id}`, {
          type: "REVIEW_FAILED",
          error: "Cancelled by user",
        });
      }

      return { message: "Review cancelled" };
    } catch (error) {
      log.error({ reviewId: id, error: error instanceof Error ? error.message : String(error) }, "Failed to cancel review");
      set.status = 500;
      return { error: "Failed to cancel review" };
    }
  });
