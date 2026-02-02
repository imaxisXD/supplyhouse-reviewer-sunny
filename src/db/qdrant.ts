import { QdrantClient } from "@qdrant/js-client-rest";
import { qdrantBreaker } from "../services/breakers.ts";

let _client: QdrantClient | null = null;

function getClient(): QdrantClient {
  if (!_client) {
    const url = process.env.QDRANT_URL || "http://localhost:6333";
    _client = new QdrantClient({ url });
  }
  return _client;
}

export const qdrantClient: QdrantClient = new Proxy({} as QdrantClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});

/**
 * Creates a Qdrant collection if it does not already exist.
 * Uses cosine distance by default.
 */
export async function ensureCollection(
  name: string,
  vectorSize: number
): Promise<void> {
  const client = getClient();
  try {
    const collections = await qdrantBreaker.execute(() => client.getCollections());
    const exists = collections.collections.some((c) => c.name === name);
    if (!exists) {
      await qdrantBreaker.execute(() =>
        client.createCollection(name, {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        }),
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Failed to ensure Qdrant collection "${name}": ${message}`
    );
  }
}

/**
 * Returns true if the Qdrant server is healthy, false otherwise.
 */
export async function qdrantHealthCheck(): Promise<boolean> {
  try {
    const client = getClient();
    await qdrantBreaker.execute(() => client.getCollections());
    return true;
  } catch {
    return false;
  }
}
