import { Elysia, t } from "elysia";
import { randomUUID } from "crypto";
import { createLogger } from "../config/logger.ts";
import { redis, publish } from "../db/redis.ts";
import { indexQueue } from "../queue/index-worker.ts";
import { indexTokenKey, storeToken } from "../utils/token-store.ts";
import { deriveRepoIdFromUrl } from "../utils/repo-identity.ts";
import { indexCancelKey, markCancelled } from "../utils/cancellation.ts";
import { getRepoMeta, listRepoMeta } from "../utils/repo-meta.ts";

const log = createLogger("api:index");
const FRAMEWORK_IDS = ["react", "typescript", "java", "spring-boot", "flutter", "ftl"] as const;
const FrameworkSchema = t.Union(FRAMEWORK_IDS.map((id) => t.Literal(id)));
const FRAMEWORK_SET = new Set<string>(FRAMEWORK_IDS);

function normalizeFramework(value?: string): string | undefined {
  if (!value) return undefined;
  return FRAMEWORK_SET.has(value) ? value : undefined;
}


export const indexRoutes = new Elysia({ prefix: "/api/index" })
  .post(
    "/",
    async ({ body, set }) => {
      const trimmedToken = body.token.trim();
      const trimmedUrl = body.repoUrl.trim();

      if (!trimmedToken) {
        set.status = 400;
        return { error: "Token must not be empty" };
      }

      const indexId = randomUUID();
      const tokenKey = indexTokenKey(indexId);
      await storeToken(tokenKey, trimmedToken);
      const { repoId } = deriveRepoIdFromUrl(trimmedUrl);

      const job = {
        id: indexId,
        repoUrl: trimmedUrl,
        branch: body.branch ?? "main",
        tokenKey,
        framework: body.framework,
        createdAt: new Date().toISOString(),
      };

      await redis.set(`index:${indexId}`, JSON.stringify({
        id: indexId,
        phase: "queued",
        percentage: 0,
        repoId,
        repoUrl: trimmedUrl,
        branch: body.branch ?? "main",
        framework: body.framework,
        filesProcessed: 0,
        totalFiles: 0,
        functionsIndexed: 0,
        startedAt: new Date().toISOString(),
      }));

      await indexQueue.add("index", job, { jobId: indexId });

      log.info({ indexId, repoUrl: trimmedUrl }, "Indexing submitted");

      set.status = 201;
      return { indexId };
    },
    {
      body: t.Object({
        repoUrl: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        branch: t.Optional(t.String()),
        framework: t.Optional(FrameworkSchema),
      }),
    }
  )
  .post(
    "/force",
    async ({ body, set }) => {
      const trimmedToken = body.token.trim();
      if (!trimmedToken) {
        set.status = 400;
        return { error: "Token must not be empty" };
      }

      log.info({ repoId: body.repoId, branch: body.branch, framework: body.framework }, "Force re-index requested");

      let repoMeta = await getRepoMeta(body.repoId);
      log.info(
        { repoId: body.repoId, hasRepoMeta: !!repoMeta, repoUrl: repoMeta?.repoUrl },
        "Force re-index repo metadata lookup",
      );
      if (!repoMeta?.repoUrl) {
        set.status = 404;
        return { error: "Repository metadata not found. Re-index from the Indexing page first." };
      }

      const indexId = randomUUID();
      const tokenKey = indexTokenKey(indexId);
      await storeToken(tokenKey, trimmedToken);

      const repoUrl = repoMeta.repoUrl;
      const repoId = body.repoId;
      const frameworkOverride = normalizeFramework(body.framework) ?? normalizeFramework(repoMeta.framework);
      const branch = body.branch ?? repoMeta.branch ?? "main";

      const job = {
        id: indexId,
        repoUrl,
        branch,
        tokenKey,
        framework: frameworkOverride,
        createdAt: new Date().toISOString(),
      };

      await redis.set(`index:${indexId}`, JSON.stringify({
        id: indexId,
        phase: "queued",
        percentage: 0,
        repoId,
        repoUrl,
        branch,
        framework: frameworkOverride,
        filesProcessed: 0,
        totalFiles: 0,
        functionsIndexed: 0,
        startedAt: new Date().toISOString(),
      }));

      await indexQueue.add("index", job, { jobId: indexId });

      log.info({ indexId, repoId, repoUrl }, "Force re-indexing submitted");

      set.status = 201;
      return { indexId };
    },
    {
      body: t.Object({
        repoId: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        branch: t.Optional(t.String()),
        framework: t.Optional(FrameworkSchema),
      }),
    },
  )
  .post(
    "/incremental",
    async ({ body, set }) => {
      const trimmedToken = body.token.trim();
      const trimmedUrl = body.repoUrl.trim();

      if (!trimmedToken) {
        set.status = 400;
        return { error: "Token must not be empty" };
      }

      if (!body.changedFiles || body.changedFiles.length === 0) {
        set.status = 400;
        return { error: "changedFiles must contain at least one file" };
      }

      const indexId = randomUUID();
      const tokenKey = indexTokenKey(indexId);
      await storeToken(tokenKey, trimmedToken);
      const { repoId } = deriveRepoIdFromUrl(trimmedUrl);

      const job = {
        id: indexId,
        repoUrl: trimmedUrl,
        branch: body.branch ?? "main",
        tokenKey,
        framework: body.framework,
        incremental: true,
        changedFiles: body.changedFiles,
        createdAt: new Date().toISOString(),
      };

      await redis.set(`index:${indexId}`, JSON.stringify({
        id: indexId,
        phase: "queued",
        percentage: 0,
        repoId,
        repoUrl: trimmedUrl,
        branch: body.branch ?? "main",
        framework: body.framework,
        filesProcessed: 0,
        totalFiles: body.changedFiles.length,
        functionsIndexed: 0,
        startedAt: new Date().toISOString(),
      }));

      await indexQueue.add("index", job, { jobId: indexId });

      log.info({ indexId, repoUrl: trimmedUrl, changedFiles: body.changedFiles.length }, "Incremental indexing submitted");

      set.status = 201;
      return { indexId };
    },
    {
      body: t.Object({
        repoUrl: t.String({ minLength: 1 }),
        token: t.String({ minLength: 1 }),
        branch: t.Optional(t.String()),
        framework: t.Optional(FrameworkSchema),
        changedFiles: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
      }),
    }
  )
  .get("/meta", async () => {
    const items = await listRepoMeta();
    return { items };
  })
  .get(
    "/meta/:repoId",
    async ({ params, set }) => {
      const meta = await getRepoMeta(params.repoId);
      if (!meta) {
        set.status = 404;
        return { error: "Repository metadata not found" };
      }
      return meta;
    },
    {
      params: t.Object({ repoId: t.String({ minLength: 1 }) }),
    },
  )
  .get("/:id/status", async ({ params, set }) => {
    const data = await redis.get(`index:${params.id}`);
    if (!data) {
      set.status = 404;
      return { error: "Index job not found" };
    }
    return JSON.parse(data);
  })
  .delete("/:id", async ({ params, set }) => {
    const { id } = params;
    try {
      const statusData = await redis.get(`index:${id}`);
      if (statusData) {
        try {
          const status = JSON.parse(statusData);
          if (status.phase === "complete" || status.phase === "failed") {
            return { message: `Index job already ${status.phase}` };
          }
        } catch {
          // Ignore parse errors
        }
      }

      // Set cancel flag — worker will see it on next assertNotCancelled call
      await markCancelled(indexCancelKey(id));

      let jobIsActive = false;
      const job = await indexQueue.getJob(id);
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
            log.warn({ indexId: id }, "Could not remove queued job, relying on cancel flag");
          }
        }
      }

      if (!jobIsActive && statusData) {
        try {
          const status = JSON.parse(statusData);
          status.phase = "failed";
          status.error = "Cancelled by user";
          status.completedAt = new Date().toISOString();
          await redis.set(`index:${id}`, JSON.stringify(status));
        } catch {
          // Ignore parse errors
        }
      }

      // Only emit from here when the worker is NOT active.
      // If active, the worker will emit the failure event itself.
      if (!jobIsActive) {
        await publish(`index:progress:${id}`, {
          jobId: id,
          phase: "failed",
          percentage: 0,
          error: "Cancelled by user",
        });
      }

      return { message: "Index job cancelled" };
    } catch (error) {
      log.error({ indexId: id, error: error instanceof Error ? error.message : String(error) }, "Failed to cancel index");
      set.status = 500;
      return { error: "Failed to cancel index job" };
    }
  })
  .get("/frameworks", () => {
    return {
      frameworks: [
        { id: "react", name: "React", languages: ["TypeScript", "JavaScript"] },
        { id: "typescript", name: "TypeScript", languages: ["TypeScript"] },
        { id: "java", name: "Java", languages: ["Java"] },
        { id: "spring-boot", name: "Spring Boot", languages: ["Java"] },
        { id: "flutter", name: "Flutter", languages: ["Dart"] },
        { id: "ftl", name: "FTL (FreeMarker)", languages: ["FTL"] },
      ],
    };
  })
  .get("/jobs", async ({ query }) => {
    const limit = Math.min(parseInt((query as Record<string, string>).limit ?? "20", 10), 100);
    const rawOffset = (query as Record<string, string>).offset
      ?? (query as Record<string, string>).cursor
      ?? "0";
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);
    try {
      const keys: string[] = [];
      let cursor = "0";
      do {
        const [nextCursor, batch] = await redis.scan(cursor, "MATCH", "index:*", "COUNT", 200);
        cursor = nextCursor;
        for (const k of batch) {
          if (!k.includes(":result") && !k.includes(":progress") && !k.includes(":cancel")) keys.push(k);
        }
      } while (cursor !== "0");

      const jobs: Record<string, unknown>[] = [];
      for (const key of keys) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          jobs.push(JSON.parse(raw));
        } catch { /* skip */ }
      }

      jobs.sort((a, b) => {
        const aTime = new Date((a.startedAt as string) || "0").getTime();
        const bTime = new Date((b.startedAt as string) || "0").getTime();
        return bTime - aTime;
      });

      const total = jobs.length;
      const page = jobs.slice(offset, offset + limit);
      const nextOffset = offset + limit < total ? offset + limit : null;

      return { jobs: page, total, nextOffset };
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to list index jobs");
      return { jobs: [], total: 0, nextOffset: null };
    }
  });
