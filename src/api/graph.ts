import { Elysia } from "elysia";
import { createLogger } from "../config/logger.ts";
import { runCypher } from "../db/memgraph.ts";

const log = createLogger("api:graph");

export const graphRoutes = new Elysia({ prefix: "/api/graph" })
  .get("/repos", async ({ set }) => {
    try {
      const records = await runCypher(`
        MATCH (f:File)
        WITH f.repoId AS repoId, count(f) AS fileCount
        OPTIONAL MATCH (fn:Function {repoId: repoId})
        WITH repoId, fileCount, count(fn) AS functionCount
        OPTIONAL MATCH (c:Class {repoId: repoId})
        RETURN repoId, fileCount, functionCount, count(c) AS classCount
        ORDER BY fileCount DESC
      `);

      const repos = records.map((r) => ({
        repoId: r.get("repoId") as string,
        fileCount: r.get("fileCount") as number,
        functionCount: r.get("functionCount") as number,
        classCount: r.get("classCount") as number,
      }));

      return { repos };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg }, "Failed to list indexed repos");
      set.status = 500;
      return { error: "Failed to list indexed repos" };
    }
  })
  .get("/:repoId", async ({ params, set }) => {
    const { repoId } = params;

    try {
      // Fetch all nodes for this repo
      const nodeRecords = await runCypher(
        `MATCH (n)
         WHERE n.repoId = $repoId
         RETURN n, labels(n) AS labels, id(n) AS nodeId`,
        { repoId },
      );

      const nodes = nodeRecords.map((r) => {
        const props = r.get("n").properties;
        const labels: string[] = r.get("labels");
        const nodeId: number = r.get("nodeId");
        const label = labels.find((l) => l === "File" || l === "Function" || l === "Class") ?? labels[0];

        return {
          id: String(nodeId),
          label,
          name: label === "File" ? props.path : props.name,
          path: props.path ?? props.file ?? undefined,
          language: props.language ?? undefined,
          startLine: props.startLine ?? undefined,
          endLine: props.endLine ?? undefined,
          isExported: props.isExported ?? undefined,
          isAsync: props.isAsync ?? undefined,
          params: props.params ?? undefined,
          returnType: props.returnType ?? undefined,
          extendsName: props.extendsName ?? undefined,
          propertyCount: props.propertyCount ?? undefined,
          methodCount: props.methodCount ?? undefined,
        };
      });

      // Fetch all edges for this repo
      const edgeRecords = await runCypher(
        `MATCH (a)-[r]->(b)
         WHERE a.repoId = $repoId
         RETURN id(a) AS source, id(b) AS target, type(r) AS relType`,
        { repoId },
      );

      const nodeIdSet = new Set(nodes.map((n) => n.id));
      const links = edgeRecords
        .map((r) => ({
          source: String(r.get("source") as number),
          target: String(r.get("target") as number),
          type: r.get("relType") as string,
        }))
        .filter((l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target));

      log.info(
        { repoId, nodes: nodes.length, links: links.length },
        "Graph data fetched",
      );

      return { nodes, links };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ repoId, error: msg }, "Failed to fetch graph data");
      set.status = 500;
      return { error: "Failed to fetch graph data" };
    }
  });
