import { z } from "zod";

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("debug"),

  // OpenRouter (LLM)
  OPENROUTER_API_KEY: z.string().optional(),

  // Voyage AI (Embeddings)
  VOYAGE_API_KEY: z.string().optional(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Qdrant
  QDRANT_URL: z.string().url().default("http://localhost:6333"),

  // Memgraph
  MEMGRAPH_URL: z.string().default("bolt://localhost:7687"),

  // BitBucket
  BITBUCKET_BASE_URL: z
    .string()
    .url()
    .default("https://api.bitbucket.org/2.0"),

  // WebSocket auth
  WS_AUTH_TOKEN: z.string().optional(),

  // Token encryption (Bitbucket tokens in Redis)
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  // CORS
  CORS_ORIGIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.format();
    console.error("Environment validation failed:");
    console.error(JSON.stringify(formatted, null, 2));
    process.exit(1);
  }

  const data = result.data;

  if (data.NODE_ENV === "production") {
    if (!data.WS_AUTH_TOKEN) {
      console.error("WS_AUTH_TOKEN is required in production.");
      process.exit(1);
    }
  }

  if (!data.TOKEN_ENCRYPTION_KEY) {
    console.error("TOKEN_ENCRYPTION_KEY is required to encrypt Bitbucket tokens.");
    process.exit(1);
  }

  return data;
}

export const env: Env = validateEnv();
