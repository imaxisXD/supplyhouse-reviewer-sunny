import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { staticPlugin } from "@elysiajs/static";
import { randomUUID } from "crypto";
import { createLogger } from "./config/logger.ts";
import { env } from "./config/env.ts";
import { checkRateLimit } from "./middleware/rate-limit.ts";
import { healthRoutes } from "./api/health.ts";
import { reviewRoutes } from "./api/review.ts";
import { indexRoutes } from "./api/index-repo.ts";
import { reviewsListRoutes } from "./api/reviews-list.ts";
import { wsRoutes } from "./api/ws.ts";
import { graphRoutes } from "./api/graph.ts";
import { journeyRoutes } from "./api/journey.ts";
import { traceRoutes } from "./api/traces.ts";
import { repoDocsRoutes } from "./api/repo-docs.ts";
import { startReviewWorker } from "./queue/review-worker.ts";
import { startIndexWorker } from "./queue/index-worker.ts";
import { ensureRepoDocsDb } from "./db/repo-docs.ts";

const log = createLogger("server");
const port = parseInt(process.env.PORT ?? "3000", 10);
const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
const corsOrigin = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean)
  : ["http://localhost:3000", "http://localhost:5173"];

ensureRepoDocsDb();

const app = new Elysia()
  .use(
    cors({
      origin: corsOrigin,
      credentials: true,
    })
  )
  .use(openapi())
  .use(
    staticPlugin({
      assets: "dashboard/dist",
      prefix: "/",
      indexHTML: true,
      alwaysStatic: false,
    })
  )
  // Trace ID middleware
  .derive(({ request }) => {
    const traceId = `tr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? "127.0.0.1";
    return { traceId, clientIp: ip };
  })
  // Rate limiting (skip health checks and static assets)
  .onBeforeHandle(({ request, set, clientIp }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/health") || !url.pathname.startsWith("/api")) {
      return;
    }

    const result = checkRateLimit(clientIp);
    if (result) {
      set.status = 429;
      set.headers["retry-after"] = String(result.retryAfter);
      return {
        error: "Too Many Requests",
        retryAfter: result.retryAfter,
      };
    }
  })
  // Request logging
  .onBeforeHandle(({ request, traceId }) => {
    log.debug(
      { traceId, method: request.method, url: request.url },
      "Incoming request"
    );
  })
  // Global error handler
  .onError(({ error, set }) => {
    const message = 'message' in error ? error.message : String(error);
    log.error({ error: message }, "Unhandled error");
    set.status = 500;
    return {
      error: "Internal Server Error",
      message:
        process.env.NODE_ENV === "development" ? message : undefined,
    };
  })
  // Routes
  .use(healthRoutes)
  .use(reviewRoutes)
  .use(indexRoutes)
  .use(reviewsListRoutes)
  .use(journeyRoutes)
  .use(wsRoutes)
  .use(graphRoutes)
  .use(traceRoutes)
  .use(repoDocsRoutes)
  .listen({
    port,
    ...(tlsCert && tlsKey
      ? { tls: { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } }
      : {}),
  });

const protocol = tlsCert && tlsKey ? "https" : "http";
log.info({ port, tls: !!(tlsCert && tlsKey) }, `Server running on ${protocol}://localhost:${port}`);
log.info(`OpenAPI docs at ${protocol}://localhost:${port}/openapi`);

// Start workers after server is ready
startReviewWorker();
startIndexWorker();

export type App = typeof app;
