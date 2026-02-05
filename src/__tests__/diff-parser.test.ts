import { describe, it, expect } from "bun:test";
import { parseDiff, mapDiffLineToFileLine } from "../bitbucket/diff-parser.ts";

// ---------------------------------------------------------------------------
// File path parsing
// ---------------------------------------------------------------------------

describe("parseDiff - file paths", () => {
  it("extracts file path from diff header", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;`;
    const files = parseDiff(diff);
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe("src/app.ts");
  });

  it("parses multiple files from a single diff", () => {
    const diff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,2 @@
-old
+new
 keep`;
    const files = parseDiff(diff);
    expect(files.length).toBe(2);
    expect(files[0]!.path).toBe("file1.ts");
    expect(files[1]!.path).toBe("file2.ts");
  });

  it("captures hunks on DiffFile", () => {
    const diff = `diff --git a/sample.ts b/sample.ts
--- a/sample.ts
+++ b/sample.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;`;
    const files = parseDiff(diff);
    expect(files[0]!.hunks?.length).toBe(1);
    expect(files[0]!.hunks?.[0]!.newStart).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Additions and deletions count
// ---------------------------------------------------------------------------

describe("parseDiff - additions and deletions", () => {
  it("counts additions correctly", () => {
    const diff = `diff --git a/index.ts b/index.ts
--- a/index.ts
+++ b/index.ts
@@ -1,2 +1,5 @@
 const a = 1;
+const b = 2;
+const c = 3;
+const d = 4;
 const e = 5;`;
    const files = parseDiff(diff);
    expect(files[0]!.additions).toBe(3);
    expect(files[0]!.deletions).toBe(0);
  });

  it("counts deletions correctly", () => {
    const diff = `diff --git a/index.ts b/index.ts
--- a/index.ts
+++ b/index.ts
@@ -1,4 +1,2 @@
 const a = 1;
-const b = 2;
-const c = 3;
 const d = 4;`;
    const files = parseDiff(diff);
    expect(files[0]!.additions).toBe(0);
    expect(files[0]!.deletions).toBe(2);
  });

  it("counts both additions and deletions in mixed hunks", () => {
    const diff = `diff --git a/index.ts b/index.ts
--- a/index.ts
+++ b/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const OLD = 2;
+const NEW = 2;
 const c = 3;`;
    const files = parseDiff(diff);
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// File status detection
// ---------------------------------------------------------------------------

describe("parseDiff - file status", () => {
  it("detects added files", () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+const z = 3;`;
    const files = parseDiff(diff);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.path).toBe("new-file.ts");
  });

  it("detects deleted files", () => {
    const diff = `diff --git a/old-file.ts b/old-file.ts
--- a/old-file.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-const z = 3;`;
    const files = parseDiff(diff);
    expect(files[0]!.status).toBe("deleted");
    // For deleted files the path should come from the old path
    expect(files[0]!.path).toBe("old-file.ts");
  });

  it("detects renamed files", () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`;
    const files = parseDiff(diff);
    expect(files[0]!.status).toBe("renamed");
    expect(files[0]!.path).toBe("new-name.ts");
    expect(files[0]!.oldPath).toBe("old-name.ts");
  });

  it("detects modified files", () => {
    const diff = `diff --git a/existing.ts b/existing.ts
--- a/existing.ts
+++ b/existing.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;`;
    const files = parseDiff(diff);
    expect(files[0]!.status).toBe("modified");
  });
});

// ---------------------------------------------------------------------------
// Line number mapping
// ---------------------------------------------------------------------------

describe("mapDiffLineToFileLine", () => {
  it("maps an added line to the correct new file line", () => {
    const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;`;
    const files = parseDiff(diff);
    const file = files[0]!;

    // The diff lines (1-indexed positions within the raw diff):
    // 1: diff --git ...
    // 2: --- a/test.ts
    // 3: +++ b/test.ts
    // 4: @@ -1,3 +1,4 @@
    // 5:  const a = 1;     -> new line 1
    // 6: +const b = 2;     -> new line 2
    // 7:  const c = 3;     -> new line 3
    // 8:  const d = 4;     -> new line 4
    const result = mapDiffLineToFileLine(file, 6);
    expect(result).toBe(2);
  });

  it("returns null for a deleted line", () => {
    const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
 const a = 1;
-const removed = 2;
 const c = 3;`;
    const files = parseDiff(diff);
    const file = files[0]!;

    // Line 6 is the deleted line "-const removed = 2;"
    const result = mapDiffLineToFileLine(file, 6);
    expect(result).toBeNull();
  });

  it("maps a context line correctly", () => {
    const diff = `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
 const d = 4;`;
    const files = parseDiff(diff);
    const file = files[0]!;

    // Line 5 is the context line " const a = 1;" -> new line 1
    const result = mapDiffLineToFileLine(file, 5);
    expect(result).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseDiff - edge cases", () => {
  it("returns empty array for empty diff", () => {
    const files = parseDiff("");
    expect(files).toEqual([]);
  });

  it("handles diff with no hunks", () => {
    const diff = `diff --git a/empty.ts b/empty.ts
--- a/empty.ts
+++ b/empty.ts`;
    const files = parseDiff(diff);
    expect(files.length).toBe(1);
    expect(files[0]!.additions).toBe(0);
    expect(files[0]!.deletions).toBe(0);
  });
});
