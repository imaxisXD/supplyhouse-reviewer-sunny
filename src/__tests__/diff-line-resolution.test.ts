import { describe, it, expect } from "bun:test";
import { parseDiff } from "../bitbucket/diff-parser.ts";
import { resolveCommentLine } from "../review/comment-filters.ts";

describe("resolveCommentLine", () => {
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

  it("returns the line when it exists in diff hunks", () => {
    expect(resolveCommentLine("file.ts", 2, diffMap)).toBe(2);
  });

  it("returns null when the line is not in diff hunks", () => {
    expect(resolveCommentLine("file.ts", 99, diffMap)).toBeNull();
  });

  it("returns null when the file is not part of the diff", () => {
    expect(resolveCommentLine("missing.ts", 2, diffMap)).toBeNull();
  });

  it("ignores meta diff lines when resolving", () => {
    const metaDiff = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
\\ No newline at end of file`;
    const file = parseDiff(metaDiff)[0]!;
    const map = new Map([[file.path, file]]);
    expect(resolveCommentLine("file.ts", 2, map)).toBe(2);
  });
});
