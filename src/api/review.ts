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
    "/validate-token",
    async ({ body, set }) => {
      const trimmedToken = body.token.trim();
      if (!trimmedToken) {
        set.status = 400;
        return { valid: false, error: "Token must not be empty" };
      }

      const parsed = parsePrUrl(body.prUrl.trim());
      if (!parsed) {
        set.status = 400;
        return { valid: false, error: "Invalid BitBucket PR URL format" };
      }

      // Step 1: Fetch authenticated user to get real Bitbucket username
      let bbUsername = "";
      try {
        const user = await bitbucketBreaker.execute(() =>
          bitbucketClient.getAuthenticatedUser(trimmedToken),
        );
        bbUsername = user.username;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Authentication failed") || message.includes("401")) {
          return { valid: false, error: "Authentication failed. Check your email and app password." };
        }
        return { valid: false, error: `Token validation failed: ${message}` };
      }

      // Step 2: Fetch PR details to verify PR access
      let prDetails;
      try {
        prDetails = await bitbucketBreaker.execute(() =>
          bitbucketClient.getPRDetails(
            parsed.workspace,
            parsed.repoSlug,
            parsed.prNumber,
            trimmedToken,
          ),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found") || message.includes("404")) {
          return { valid: false, error: "PR not found. Check the URL and ensure the token has repository read access." };
        }
        return { valid: false, error: `PR access check failed: ${message}` };
      }

      // Step 3: Verify git clone access via ls-remote
      // Build the clone token using the real Bitbucket username (not email)
      const cloneToken = trimmedToken.includes(":")
        ? `${bbUsername}:${trimmedToken.split(":").slice(1).join(":")}`
        : trimmedToken;
      const repoUrl = `https://bitbucket.org/${parsed.workspace}/${parsed.repoSlug}.git`;

      let cloneAccessOk = false;
      try {
        const url = new URL(repoUrl);
        if (cloneToken.includes(":")) {
          const [user, ...passParts] = cloneToken.split(":");
          url.username = encodeURIComponent(user!);
          url.password = encodeURIComponent(passParts.join(":"));
        } else {
          url.username = "x-token-auth";
          url.password = cloneToken;
        }

        const proc = Bun.spawn(
          ["git", "ls-remote", "--exit-code", url.toString()],
          {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
        const exitCode = await proc.exited;
        cloneAccessOk = exitCode === 0;
      } catch {
        cloneAccessOk = false;
      }

      if (!cloneAccessOk) {
        return {
          valid: false,
          error: `API token works but git clone access failed. Ensure your App Password has repository read access.`,
          username: bbUsername,
        };
      }

      return {
        valid: true,
        username: bbUsername,
        pr: {
          title: prDetails.title,
          author: prDetails.author.displayName,
          sourceBranch: prDetails.sourceBranch,
          targetBranch: prDetails.targetBranch,
        },
      };
    },
    {
      body: t.Object({
        prUrl: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
      }),
    }
  )
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
        prUrl: trimmedUrl,
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
      let status: Record<string, unknown> | null = null;
      if (statusData) {
        try {
          status = JSON.parse(statusData) as Record<string, unknown>;
          if (status.phase === "complete" || status.phase === "failed") {
            return { message: `Review already ${status.phase}` };
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Set cancel flag first — worker will see it on next assertNotCancelled call
      await markCancelled(reviewCancelKey(id));

      if (status) {
        status.phase = "cancelling";
        if ("completedAt" in status) delete status.completedAt;
        if ("error" in status) delete status.error;
        const percentage = typeof status.percentage === "number" ? status.percentage : 0;
        const findingsCount =
          typeof status.findingsCount === "number"
            ? status.findingsCount
            : Array.isArray(status.findings)
              ? status.findings.length
              : 0;
        await redis.set(`review:${id}`, JSON.stringify(status));
        await publish(`review:events:${id}`, {
          type: "PHASE_CHANGE",
          phase: "cancelling",
          percentage,
          findingsCount,
          ...(typeof status.currentFile === "string" ? { currentFile: status.currentFile } : {}),
          ...(Array.isArray(status.agentsRunning) ? { agentsRunning: status.agentsRunning } : {}),
        });
      }

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
          const statusPayload = JSON.parse(statusData) as Record<string, unknown>;
          statusPayload.phase = "failed";
          statusPayload.error = "Cancelled by user";
          statusPayload.completedAt = new Date().toISOString();
          await redis.set(`review:${id}`, JSON.stringify(statusPayload));
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
