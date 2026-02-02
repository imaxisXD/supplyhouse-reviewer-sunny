import { Elysia, t } from "elysia";
import { subscribe } from "../db/redis.ts";
import { createLogger } from "../config/logger.ts";
import { env } from "../config/env.ts";

const log = createLogger("ws");

export const wsRoutes = new Elysia()
  .ws("/ws", {
    query: t.Object({
      reviewId: t.Optional(t.String()),
      indexId: t.Optional(t.String()),
      auth: t.Optional(t.String()),
    }),
    async open(ws) {
      const reviewId = ws.data.query.reviewId;
      const indexId = ws.data.query.indexId;
      const auth = ws.data.query.auth;

      const requiredToken = env.WS_AUTH_TOKEN;
      if (requiredToken && auth !== requiredToken) {
        ws.close(4001, "Unauthorized");
        return;
      }

      if (!reviewId && !indexId) {
        ws.close(4000, "reviewId or indexId query param required");
        return;
      }

      const channel = reviewId
        ? `review:events:${reviewId}`
        : `index:progress:${indexId}`;

      log.debug({ reviewId, indexId, channel }, "WebSocket client connected");

      const unsubscribe = await subscribe(channel, (data) => {
        try {
          ws.send(data as Record<string, unknown>);
        } catch {
          // Client may have disconnected
        }
      });

      // Store unsubscribe function for cleanup
      (ws.data as Record<string, unknown>)._unsubscribe = unsubscribe;
    },
    message(_ws, _message) {
      // Clients don't need to send messages; this is a server-push channel
    },
    close(ws) {
      const reviewId = ws.data.query.reviewId;
      const indexId = ws.data.query.indexId;
      log.debug({ reviewId, indexId }, "WebSocket client disconnected");

      const unsubscribe = (ws.data as Record<string, unknown>)._unsubscribe;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    },
  });
