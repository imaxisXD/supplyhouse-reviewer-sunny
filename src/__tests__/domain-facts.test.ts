import { describe, it, expect, mock } from "bun:test";
import type { DiffFile } from "../types/bitbucket.ts";

const record = (data: Record<string, unknown>) => ({
  get: (key: string) => data[key],
});

mock.module("../db/memgraph.ts", () => ({
  runCypher: async (query: string) => {
    if (query.includes("MATCH (e:Entity") && query.includes("file: $file")) {
      return [
        record({
          entity: "ProductCostScheduled",
          services: ["ListScheduledProductCosts"],
          forms: [],
        }),
      ];
    }
    if (query.includes("MATCH (s:Service") && query.includes("IMPLEMENTED_BY")) {
      return [];
    }
    return [];
  },
}));

const { getFileDomainFacts, buildDomainFactsIndex } = await import("../review/domain-facts.ts");
const { buildRepoStrategyProfile } = await import("../utils/repo-meta.ts");

describe("domain facts", () => {
  it("returns entity facts for entitymodel.xml", async () => {
    const profile = buildRepoStrategyProfile("repo", "ofbiz-supplyhouse");
    const facts = await getFileDomainFacts("repo", "applications/product/entitydef/entitymodel.xml", profile);
    expect(facts.entities).toEqual(["ProductCostScheduled"]);
    expect(facts.services).toEqual(["ListScheduledProductCosts"]);
    expect(facts.relations?.some((r) => r.includes("ProductCostScheduled"))).toBe(true);
  });

  it("aggregates PR domain facts across files", async () => {
    const profile = buildRepoStrategyProfile("repo", "ofbiz-supplyhouse");
    const diffFiles: DiffFile[] = [
      {
        path: "applications/product/entitydef/entitymodel.xml",
        status: "modified",
        diff: "",
        additions: 1,
        deletions: 0,
      },
    ];
    const index = await buildDomainFactsIndex("repo", diffFiles, profile);
    expect(index.prFacts.entities).toEqual(["ProductCostScheduled"]);
    expect(index.byFile.get("applications/product/entitydef/entitymodel.xml")?.entities).toEqual(["ProductCostScheduled"]);
  });
});
