import { describe, it, expect } from "bun:test";
import { parseDiff } from "../bitbucket/diff-parser.ts";
import {
  buildDiffIndex,
  buildSummaryDiff,
  resolveFindingLine,
} from "../review/diff-indexer.ts";
import type { Finding } from "../types/findings.ts";

describe("diff-indexer", () => {
  it("detects moved blocks within a file", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,1 @@
-foo
-bar
 baz
@@ -10,0 +12,2 @@
+foo
+bar`;
    const diffFile = parseDiff(diff)[0]!;
    const index = buildDiffIndex([diffFile]);
    expect(index.moveFacts.length).toBe(1);
    const fact = index.moveFacts[0]!;
    expect(fact.from.file).toBe("file.ts");
    expect(fact.to.file).toBe("file.ts");
    expect(fact.sizeLines).toBe(2);
  });

  it("normalizes whitespace/comments when matching moves", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,1 @@
-// comment
-const  a   = 1;
 baz
@@ -10,0 +12,1 @@
+const a = 1;`;
    const diffFile = parseDiff(diff)[0]!;
    const index = buildDiffIndex([diffFile]);
    expect(index.moveFacts.length).toBe(1);
  });

  it("resolves line by lineText to closest match", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,4 +1,5 @@
 const a = 1;
+const b = 2;
 const a = 1;
 const a = 1;`;
    const diffFile = parseDiff(diff)[0]!;
    const index = buildDiffIndex([diffFile]);
    const finding: Finding = {
      file: "file.ts",
      line: 99,
      lineText: "const a = 1;",
      severity: "low",
      category: "refactor",
      title: "test",
      description: "test",
      confidence: 0.9,
    };
    const result = resolveFindingLine(finding, index);
    expect(result.line).toBe(4);
  });

  it("buildSummaryDiff keeps change lines across hunks", () => {
    const diff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;
@@ -10,3 +11,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
 const w = 4;`;
    const diffFile = parseDiff(diff)[0]!;
    const summary = buildSummaryDiff(diffFile, { maxLines: 6, contextLines: 0 });
    expect(summary).toContain("+const b = 2;");
    expect(summary).toContain("+const y = 2;");
    expect(summary).toContain("@@ -10,3 +11,4 @@");
  });

});
