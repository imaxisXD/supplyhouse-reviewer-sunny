import { Elysia } from "elysia";
import { qdrantHealthCheck } from "../db/qdrant.ts";
import { memgraphHealthCheck } from "../db/memgraph.ts";
import { redisHealthCheck } from "../db/redis.ts";
import { getBreakerStates } from "../services/breakers.ts";
import { getDegradationMode } from "../services/degradation.ts";

export const healthRoutes = new Elysia({ prefix: "/health" })
  .get("/", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))
  .get("/services", async () => {
    const [qdrant, memgraph, redis] = await Promise.allSettled([
      qdrantHealthCheck(),
      memgraphHealthCheck(),
      redisHealthCheck(),
    ]);

    const services = {
      qdrant: qdrant.status === "fulfilled" && qdrant.value,
      memgraph: memgraph.status === "fulfilled" && memgraph.value,
      redis: redis.status === "fulfilled" && redis.value,
    };

    const circuitBreakers = getBreakerStates();
    const degradation = getDegradationMode();

    const allHealthy = Object.values(services).every(Boolean);
    const anyBreakerOpen = Object.values(circuitBreakers).some(
      (b) => b.state === "OPEN",
    );

    return {
      status: allHealthy && !anyBreakerOpen ? "ok" : "degraded",
      services,
      circuitBreakers,
      degradation,
      timestamp: new Date().toISOString(),
    };
  });
