import { Elysia, t } from "elysia";
import { createLogger } from "../config/logger.ts";
import { runCypher } from "../db/memgraph.ts";
import {
  IndexedReposResponseSchema,
  GraphDataSchema,
  ErrorResponse,
} from "./schemas.ts";

const log = createLogger("api:graph");

const NODE_LABELS = ["File", "Function", "Class"] as const;
const EDGE_TYPES = ["CONTAINS", "CALLS", "IMPORTS", "HAS_METHOD", "EXTENDS", "IMPLEMENTS"] as const;

function parseCsvList(input: unknown, allowed: readonly string[], fallback: string[]): string[] {
  if (typeof input !== "string" || input.trim() === "") return fallback;
  const allowedSet = new Set(allowed);
  const parsed = input
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && allowedSet.has(value));
  return parsed.length > 0 ? parsed : fallback;
}

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
  }, {
    response: {
      200: IndexedReposResponseSchema,
      500: ErrorResponse,
    },
  })
  .get("/:repoId", async ({ params, query, set }) => {
    const { repoId } = params;
    const view = typeof query?.view === "string" && query.view === "full" ? "full" : "overview";
    const defaultNodeTypes = view === "full" ? [...NODE_LABELS] : ["File"];
    const defaultEdgeTypes =
      view === "full" ? [...EDGE_TYPES] : ["CALLS", "IMPORTS", "EXTENDS", "IMPLEMENTS"];
    const nodeTypes = parseCsvList(query?.nodeTypes as unknown, NODE_LABELS, defaultNodeTypes);
    const edgeTypes = parseCsvList(query?.edgeTypes as unknown, EDGE_TYPES, defaultEdgeTypes);

    try {
      if (view === "overview") {
        const nodeRecords = await runCypher(
          `MATCH (f:File {repoId: $repoId})
           RETURN f, labels(f) AS labels, id(f) AS nodeId`,
          { repoId },
        );

        const nodes = nodeRecords.map((r) => {
          const props = r.get("f").properties;
          const labels: string[] = r.get("labels");
          const nodeId: number = r.get("nodeId");
          const label = labels.find((l) => l === "File") ?? labels[0] ?? "File";

          return {
            id: String(nodeId),
            label,
            name: props.path,
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

        const fileIdByPath = new Map<string, string>();
        for (const node of nodes) {
          if (node.path) fileIdByPath.set(node.path, node.id);
        }

        const edgeMap = new Map<
          string,
          { source: string; target: string; type: string; weight: number }
        >();

        const addEdge = (
          sourcePath: string | null,
          targetPath: string | null,
          type: string,
          weight: number,
        ) => {
          if (!sourcePath || !targetPath) return;
          if (sourcePath === targetPath) return;
          const sourceId = fileIdByPath.get(sourcePath);
          const targetId = fileIdByPath.get(targetPath);
          if (!sourceId || !targetId) return;
          const key = `${sourceId}-${targetId}-${type}`;
          const existing = edgeMap.get(key);
          if (existing) {
            existing.weight += weight;
            return;
          }
          edgeMap.set(key, { source: sourceId, target: targetId, type, weight });
        };

        if (edgeTypes.includes("IMPORTS")) {
          const importRecords = await runCypher(
            `MATCH (a:File {repoId: $repoId})-[r:IMPORTS]->(b:File {repoId: $repoId})
             RETURN a.path AS sourcePath, b.path AS targetPath, count(r) AS weight`,
            { repoId },
          );
          for (const r of importRecords) {
            addEdge(
              r.get("sourcePath") as string,
              r.get("targetPath") as string,
              "IMPORTS",
              Number(r.get("weight") ?? 1),
            );
          }
        }

        if (edgeTypes.includes("CALLS")) {
          const callRecords = await runCypher(
            `MATCH (caller:Function {repoId: $repoId})-[r:CALLS]->(callee:Function {repoId: $repoId})
             WHERE caller.file IS NOT NULL AND callee.file IS NOT NULL
             RETURN caller.file AS sourcePath, callee.file AS targetPath, count(r) AS weight`,
            { repoId },
          );
          for (const r of callRecords) {
            addEdge(
              r.get("sourcePath") as string,
              r.get("targetPath") as string,
              "CALLS",
              Number(r.get("weight") ?? 1),
            );
          }
        }

        if (edgeTypes.includes("EXTENDS") || edgeTypes.includes("IMPLEMENTS")) {
          const inheritRecords = await runCypher(
            `MATCH (child:Class {repoId: $repoId})-[r:EXTENDS|IMPLEMENTS]->(parent:Class {repoId: $repoId})
             WHERE child.file IS NOT NULL AND parent.file IS NOT NULL
             RETURN child.file AS sourcePath, parent.file AS targetPath, type(r) AS relType, count(r) AS weight`,
            { repoId },
          );
          for (const r of inheritRecords) {
            const relType = r.get("relType") as string;
            if (!edgeTypes.includes(relType as (typeof EDGE_TYPES)[number])) continue;
            addEdge(
              r.get("sourcePath") as string,
              r.get("targetPath") as string,
              relType,
              Number(r.get("weight") ?? 1),
            );
          }
        }

        const links = Array.from(edgeMap.values());

        log.info(
          { repoId, nodes: nodes.length, links: links.length, view },
          "Graph overview data fetched",
        );

        return { nodes, links };
      }

      // Fetch all nodes for this repo
      const nodeRecords = await runCypher(
        `MATCH (n)
         WHERE n.repoId = $repoId
           AND ANY(lbl IN labels(n) WHERE lbl IN $nodeTypes)
         RETURN n, labels(n) AS labels, id(n) AS nodeId`,
        { repoId, nodeTypes },
      );

      const nodes = nodeRecords.map((r) => {
        const props = r.get("n").properties;
        const labels: string[] = r.get("labels");
        const nodeId: number = r.get("nodeId");
        const label = labels.find((l) => l === "File" || l === "Function" || l === "Class") ?? labels[0] ?? "File";

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

      // Fetch all edges for this repo (include line + symbols for detail panel)
      const edgeRecords = await runCypher(
        `MATCH (a)-[r]->(b)
         WHERE a.repoId = $repoId
           AND b.repoId = $repoId
           AND type(r) IN $edgeTypes
           AND ANY(lbl IN labels(a) WHERE lbl IN $nodeTypes)
           AND ANY(lbl IN labels(b) WHERE lbl IN $nodeTypes)
         RETURN id(a) AS source, id(b) AS target, type(r) AS relType,
                r.line AS line, r.symbols AS symbols`,
        { repoId, edgeTypes, nodeTypes },
      );

      const nodeIdSet = new Set(nodes.map((n) => n.id));
      const links = edgeRecords
        .map((r) => {
          const line = r.get("line");
          const symbols = r.get("symbols");
          return {
            source: String(r.get("source") as number),
            target: String(r.get("target") as number),
            type: r.get("relType") as string,
            line: line != null ? Number(line) : undefined,
            symbols: Array.isArray(symbols) ? (symbols as string[]) : undefined,
          };
        })
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
  }, {
    query: t.Object({
      view: t.Optional(t.String()),
      nodeTypes: t.Optional(t.String()),
      edgeTypes: t.Optional(t.String()),
    }),
    response: {
      200: GraphDataSchema,
      500: ErrorResponse,
    },
  });
