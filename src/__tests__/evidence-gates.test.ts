import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import type { DiffFile } from "../types/bitbucket.ts";
import type { Finding } from "../types/findings.ts";
import { applyEvidenceGates } from "../review/evidence-gates.ts";

describe("evidence gates", () => {
  it("drops entity field warnings when entitymodel contains the fields", () => {
    const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "evidence-gate-"));
    const entityPath = path.join(tmpRoot, "applications/product/entitydef");
    fs.mkdirSync(entityPath, { recursive: true });
    const entityFile = path.join(entityPath, "entitymodel.xml");
    fs.writeFileSync(
      entityFile,
      `<entity entity-name="ProductCostScheduled">
  <field name="blobUri" type="long-varchar"/>
  <field name="fileName" type="long-varchar"/>
  <field name="updateStatus" type="id"/>
  <field name="scheduledDate" type="date-time"/>
</entity>`,
      "utf-8",
    );

    const diffFiles: DiffFile[] = [
      {
        path: "applications/product/entitydef/entitymodel.xml",
        status: "modified",
        diff: "",
        additions: 0,
        deletions: 0,
      },
    ];

    const finding: Finding = {
      file: "applications/product/webapp/catalog/WEB-INF/actions/ListScheduledProductCosts.bsh",
      line: 22,
      severity: "medium",
      category: "api-change",
      title: "Entity field dependencies not verified",
      description: "The script references fields: blobUri, fileName, updateStatus, scheduledDate.",
      confidence: 0.8,
      lineText: `delegator.findByAnd("ProductCostScheduled", expr, orderBy);`,
    };

    const result = applyEvidenceGates([finding], {
      repoPath: tmpRoot,
      diffFiles,
      strategyId: "ofbiz-supplyhouse",
    });

    expect(result.findings.length).toBe(0);
    expect(result.stats.droppedEntityFields).toBe(1);
  });

  it("downgrades IDOR findings without backend evidence", () => {
    const diffFiles: DiffFile[] = [
      {
        path: "applications/product/webapp/catalog/main.ftl",
        status: "modified",
        diff: "+axios.delete('/productPrice/schedules/' + scheduleId)",
        additions: 1,
        deletions: 0,
      },
    ];

    const finding: Finding = {
      file: "applications/product/webapp/catalog/main.ftl",
      line: 12,
      severity: "high",
      category: "security",
      title: "Insecure Direct Object Reference (IDOR)",
      description: "DELETE /productPrice/schedules/{scheduleId} may allow unauthorized access.",
      confidence: 0.9,
    };

    const result = applyEvidenceGates([finding], {
      repoPath: "/tmp",
      diffFiles,
    });

    expect(result.findings.length).toBe(1);
    expect(result.findings[0]!.severity).toBe("medium");
    expect(result.stats.downgradedSecurity).toBe(1);
  });

  it("drops legacy-browser warnings when no legacy targets configured", () => {
    const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "evidence-legacy-"));
    const finding: Finding = {
      file: "applications/product/webapp/catalog/main.ftl",
      line: 10,
      severity: "medium",
      category: "bug",
      title: "Optional chaining operator may not be supported in older browsers",
      description: "Optional chaining is ES2020 syntax and not supported in IE11.",
      confidence: 0.9,
    };
    const result = applyEvidenceGates([finding], {
      repoPath: tmpRoot,
      diffFiles: [],
    });
    expect(result.findings.length).toBe(0);
    expect(result.stats.droppedLegacyBrowser).toBe(1);
  });

  it("keeps legacy-browser warnings when legacy targets configured", () => {
    const tmpRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "evidence-legacy-"));
    fs.writeFileSync(path.join(tmpRoot, ".browserslistrc"), "ie 11", "utf-8");
    const finding: Finding = {
      file: "applications/product/webapp/catalog/main.ftl",
      line: 10,
      severity: "medium",
      category: "bug",
      title: "Optional chaining operator may not be supported in older browsers",
      description: "Optional chaining is ES2020 syntax and not supported in IE11.",
      confidence: 0.9,
    };
    const result = applyEvidenceGates([finding], {
      repoPath: tmpRoot,
      diffFiles: [],
    });
    expect(result.findings.length).toBe(1);
    expect(result.stats.droppedLegacyBrowser).toBe(0);
  });
});
