/**
 * Embedding Availability Detection
 *
 * Utility to check if embeddings exist for a repository in Qdrant.
 */

import { qdrantClient } from "../db/qdrant.ts";
import { collectionName } from "../indexing/embedding-generator.ts";
import { qdrantBreaker } from "../services/breakers.ts";
import { createLogger } from "../config/logger.ts";

const log = createLogger("embedding-availability");

export interface EmbeddingAvailability {
  available: boolean;
  pointsCount: number;
  collectionExists: boolean;
}

/**
 * Check if embeddings are available for a repository.
 * Returns availability status with details.
 *
 * @param repoId - The repository identifier
 * @returns Availability status including point count
 */
export async function checkEmbeddingAvailability(
  repoId: string
): Promise<EmbeddingAvailability> {
  const collection = collectionName(repoId);

  try {
    const info = await qdrantBreaker.execute(() =>
      qdrantClient.getCollection(collection)
    );

    const pointsCount = info.points_count ?? 0;
    const available = pointsCount > 0;

    log.debug(
      { repoId, collection, pointsCount, available },
      "Checked embedding availability"
    );

    return {
      available,
      pointsCount,
      collectionExists: true,
    };
  } catch (error) {
    // Collection doesn't exist or Qdrant is unavailable
    log.debug(
      {
        repoId,
        collection,
        error: error instanceof Error ? error.message : String(error),
      },
      "Embeddings not available for repo"
    );

    return {
      available: false,
      pointsCount: 0,
      collectionExists: false,
    };
  }
}
