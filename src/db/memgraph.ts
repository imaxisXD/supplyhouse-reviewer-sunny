import neo4j, { type Driver, type Record as Neo4jRecord } from "neo4j-driver";
import { memgraphBreaker } from "../services/breakers.ts";

let _driver: Driver | null = null;

/**
 * Returns a singleton Memgraph (Neo4j-compatible) driver instance.
 * Connection URL is read from MEMGRAPH_URL env var, defaulting to bolt://localhost:7687.
 */
export function getMemgraphDriver(): Driver {
  if (!_driver) {
    const url = process.env.MEMGRAPH_URL || "bolt://localhost:7687";
    _driver = neo4j.driver(url, neo4j.auth.basic("", ""), {
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 30_000,
      disableLosslessIntegers: true,
    });
  }
  return _driver;
}

/**
 * Runs a Cypher query against Memgraph, managing session lifecycle automatically.
 * Returns the result records array.
 */
export async function runCypher(
  query: string,
  params?: Record<string, unknown>
): Promise<Neo4jRecord[]> {
  const driver = getMemgraphDriver();
  const session = driver.session();
  try {
    const result = await memgraphBreaker.execute(() => session.run(query, params));
    return result.records;
  } finally {
    await session.close();
  }
}

/**
 * Creates common indexes used by the PR review system.
 * Uses try/catch per statement since Memgraph index syntax may differ from Neo4j
 * and some indexes may already exist.
 */
export async function setupSchema(): Promise<void> {
  const indexStatements = [
    "CREATE INDEX ON :File(path)",
    "CREATE INDEX ON :Function(name)",
    "CREATE INDEX ON :Class(name)",
  ];

  for (const statement of indexStatements) {
    try {
      await runCypher(statement);
    } catch (error) {
      // Memgraph may throw if the index already exists or if the syntax
      // is not supported. Log and continue rather than failing hard.
      const message =
        error instanceof Error ? error.message : "Unknown error";
      console.warn(
        `Memgraph index creation warning for "${statement}": ${message}`
      );
    }
  }
}

/**
 * Returns true if the Memgraph server is reachable, false otherwise.
 */
export async function memgraphHealthCheck(): Promise<boolean> {
  try {
    const driver = getMemgraphDriver();
    const serverInfo = await memgraphBreaker.execute(() => driver.getServerInfo());
    return !!serverInfo;
  } catch {
    return false;
  }
}
