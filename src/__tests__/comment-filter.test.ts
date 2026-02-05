import { describe, it, expect } from "bun:test";
import type { Finding } from "../types/findings.ts";
import { parseDiff } from "../bitbucket/diff-parser.ts";
import { filterFindingsForInline, filterFindingsForQuality } from "../review/comment-filters.ts";

describe("comment filters", () => {
  const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;`;
  const diffFile = parseDiff(diff)[0]!;
  const diffMap = new Map([[diffFile.path, diffFile]]);

  const baseFinding: Finding = {
    file: "file.ts",
    line: 2,
    severity: "medium",
    category: "bug",
    title: "Ok",
    description: "Concrete bug",
    confidence: 0.75,
  };

  it("filters findings by quality rules and tracks drop reasons", () => {
    const findings: Finding[] = [
      baseFinding,
      { ...baseFinding, title: "Out of diff", line: 99 },
      {
        ...baseFinding,
        title: "API change without evidence",
        category: "api-change",
        affectedFiles: [],
      },
      {
        ...baseFinding,
        title: "Duplication without evidence",
        category: "duplication",
        relatedCode: { file: "other.ts", line: 1, functionName: "dup", similarity: 0.89 },
      },
      { ...baseFinding, title: "Low confidence", confidence: 0.65 },
      {
        ...baseFinding,
        title: "Potential issue",
        description: "potential edge case",
        severity: "low",
        confidence: 0.83,
      },
      {
        ...baseFinding,
        title: "Missing location",
        file: "",
        line: 0,
      },
    ];

    const result = filterFindingsForQuality(findings, diffMap);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Ok");
    expect(result.dropped.outOfDiff).toBe(1);
    expect(result.dropped.apiChangeNoEvidence).toBe(1);
    expect(result.dropped.duplicationNoEvidence).toBe(1);
    expect(result.dropped.lowConfidence).toBe(1);
    expect(result.dropped.speculativeLowInfo).toBe(1);
    expect(result.dropped.missingLocation).toBe(1);
  });

  it("drops api-change findings without external usage evidence", () => {
    const findings: Finding[] = [
      {
        ...baseFinding,
        category: "api-change",
        affectedFiles: [{ file: "file.ts", line: 10, usage: "call()" }],
      },
    ];
    const result = filterFindingsForQuality(findings, diffMap);
    expect(result.findings).toHaveLength(0);
    expect(result.dropped.apiChangeNoEvidence).toBe(1);
    expect(Object.keys(result.dropped.apiChangeEvidenceFiles ?? {})).toHaveLength(0);
  });

  it("keeps only medium+ findings for inline", () => {
    const inline = filterFindingsForInline([
      { ...baseFinding, severity: "critical" },
      { ...baseFinding, severity: "medium" },
      { ...baseFinding, severity: "low" },
      { ...baseFinding, severity: "info" },
    ]);
    expect(inline.map((finding) => finding.severity)).toEqual(["critical", "medium"]);
  });

  it("ignores meta diff lines when validating diff presence", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
\\ No newline at end of file`;
    const diffFile = parseDiff(diff)[0]!;
    const diffMap = new Map([[diffFile.path, diffFile]]);
    const result = filterFindingsForQuality([baseFinding], diffMap);
    expect(result.findings).toHaveLength(1);
  });
});
