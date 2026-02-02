import { describe, it, expect } from "bun:test";
import { prioritizeFiles, batchFiles } from "../review/large-pr.ts";
import type { DiffFile } from "../types/bitbucket.ts";

function makeDiffFile(
  path: string,
  additions = 10,
  deletions = 5,
  overrides?: Partial<DiffFile>,
): DiffFile {
  return {
    path,
    status: "modified",
    diff: "",
    additions,
    deletions,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// prioritizeFiles - priority scoring
// ---------------------------------------------------------------------------

describe("prioritizeFiles - priority scoring", () => {
  it("gives security-related paths the highest priority", () => {
    const files = [
      makeDiffFile("src/utils/helper.ts", 10, 5),
      makeDiffFile("src/auth/login.ts", 10, 5),
      makeDiffFile("src/components/Button.tsx", 10, 5),
    ];
    const result = prioritizeFiles(files);
    // auth file should be first (highest priority)
    expect(result[0]!.file.path).toBe("src/auth/login.ts");
  });

  it("ranks api/controllers paths higher than utils", () => {
    const files = [
      makeDiffFile("src/utils/format.ts", 10, 5),
      makeDiffFile("src/api/users.ts", 10, 5),
    ];
    const result = prioritizeFiles(files);
    expect(result[0]!.file.path).toBe("src/api/users.ts");
  });

  it("gives test files negative priority adjustments", () => {
    const files = [
      makeDiffFile("src/services/auth.ts", 10, 5),
      makeDiffFile("src/tests/auth.test.ts", 10, 5),
    ];
    const result = prioritizeFiles(files);
    // Service file should come before test file
    expect(result[0]!.file.path).toBe("src/services/auth.ts");
    // Test file should have lower priority
    const testFile = result.find((r) => r.file.path.includes("tests"));
    const serviceFile = result.find((r) => r.file.path.includes("services"));
    expect(testFile!.priority).toBeLessThan(serviceFile!.priority);
  });

  it("gives large files a lines-changed bonus (capped at 20)", () => {
    const smallFile = makeDiffFile("src/models/user.ts", 5, 5);
    const largeFile = makeDiffFile("src/models/order.ts", 200, 100);
    const files = [smallFile, largeFile];
    const result = prioritizeFiles(files);
    const small = result.find((r) => r.file.path.includes("user"));
    const large = result.find((r) => r.file.path.includes("order"));
    // Both are in models so base segment score is same; difference comes from lines changed
    expect(large!.priority).toBeGreaterThan(small!.priority);
  });

  it("ranks generated files lowest", () => {
    const files = [
      makeDiffFile("src/generated/schema.ts", 50, 10),
      makeDiffFile("src/components/Header.tsx", 10, 5),
    ];
    const result = prioritizeFiles(files);
    const generated = result.find((r) => r.file.path.includes("generated"));
    expect(generated!.priority).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// prioritizeFiles - fullAnalysis flag
// ---------------------------------------------------------------------------

describe("prioritizeFiles - fullAnalysis", () => {
  it("marks top files for full analysis", () => {
    const files = [
      makeDiffFile("src/auth/login.ts", 10, 5),
      makeDiffFile("src/utils/helper.ts", 10, 5),
    ];
    const result = prioritizeFiles(files);
    // With only 2 files, both should get full analysis (well under the cap)
    expect(result.every((r) => r.fullAnalysis)).toBe(true);
  });

  it("returns all files sorted by priority descending", () => {
    const files = [
      makeDiffFile("src/components/Button.tsx", 10, 5),
      makeDiffFile("src/security/crypto.ts", 10, 5),
      makeDiffFile("src/docs/readme.md", 10, 5),
    ];
    const result = prioritizeFiles(files);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.priority).toBeGreaterThanOrEqual(result[i + 1]!.priority);
    }
  });
});

// ---------------------------------------------------------------------------
// batchFiles
// ---------------------------------------------------------------------------

describe("batchFiles", () => {
  it("splits items into batches of the specified size", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const batches = batchFiles(items, 3);
    expect(batches.length).toBe(3);
    expect(batches[0]).toEqual([1, 2, 3]);
    expect(batches[1]).toEqual([4, 5, 6]);
    expect(batches[2]).toEqual([7]);
  });

  it("returns a single batch when items fit within batchSize", () => {
    const items = ["a", "b", "c"];
    const batches = batchFiles(items, 10);
    expect(batches.length).toBe(1);
    expect(batches[0]).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty input", () => {
    const batches = batchFiles([], 5);
    expect(batches).toEqual([]);
  });

  it("handles batchSize of 1", () => {
    const items = ["x", "y", "z"];
    const batches = batchFiles(items, 1);
    expect(batches.length).toBe(3);
    expect(batches[0]).toEqual(["x"]);
    expect(batches[1]).toEqual(["y"]);
    expect(batches[2]).toEqual(["z"]);
  });

  it("handles exact multiples of batchSize", () => {
    const items = [1, 2, 3, 4, 5, 6];
    const batches = batchFiles(items, 2);
    expect(batches.length).toBe(3);
    expect(batches[0]).toEqual([1, 2]);
    expect(batches[1]).toEqual([3, 4]);
    expect(batches[2]).toEqual([5, 6]);
  });

  it("works with complex objects", () => {
    const files = [
      makeDiffFile("a.ts"),
      makeDiffFile("b.ts"),
      makeDiffFile("c.ts"),
    ];
    const batches = batchFiles(files, 2);
    expect(batches.length).toBe(2);
    expect(batches[0]!.length).toBe(2);
    expect(batches[1]!.length).toBe(1);
    expect(batches[0]![0]!.path).toBe("a.ts");
  });
});
