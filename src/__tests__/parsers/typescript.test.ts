import { describe, it, expect } from "bun:test";
import { typescriptParser } from "../../indexing/parsers/typescript.ts";

const parse = (code: string, filePath = "test.ts") =>
  typescriptParser.parse(code, filePath);

// ---------------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------------

describe("TypeScript parser - functions", () => {
  it("extracts a regular function declaration", () => {
    const code = `function greet(name: string): string {
  return "hello " + name;
}`;
    const result = parse(code);
    expect(result.functions.length).toBeGreaterThanOrEqual(1);
    const fn = result.functions.find((f) => f.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.params).toContain("name");
    expect(fn!.isAsync).toBe(false);
  });

  it("extracts an async function declaration", () => {
    const code = `async function fetchData(url: string): Promise<Response> {
  return fetch(url);
}`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "fetchData");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
  });

  it("extracts an arrow function assigned to a const", () => {
    const code = `const add = (a: number, b: number): number => {
  return a + b;
};`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "add");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(false);
  });

  it("extracts an exported function", () => {
    const code = `export function helper(x: number): number {
  return x * 2;
}`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "helper");
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(true);
  });

  it("extracts an async arrow function", () => {
    const code = `export const loadUser = async (id: string) => {
  return await db.find(id);
};`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "loadUser");
    expect(fn).toBeDefined();
    expect(fn!.isAsync).toBe(true);
    expect(fn!.isExported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Class extraction
// ---------------------------------------------------------------------------

describe("TypeScript parser - classes", () => {
  it("extracts a class with methods", () => {
    const code = `class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  subtract(a: number, b: number): number {
    return a - b;
  }
}`;
    const result = parse(code);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("Calculator");
    expect(cls.methods.length).toBeGreaterThanOrEqual(2);
    const addMethod = cls.methods.find((m) => m.name === "add");
    expect(addMethod).toBeDefined();
  });

  it("extracts class properties", () => {
    const code = `class User {
  name: string;
  age: number;
  greet(): string {
    return this.name;
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.properties.length).toBeGreaterThanOrEqual(2);
    const nameProp = cls.properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
  });

  it("extracts extends clause", () => {
    const code = `class Admin extends User {
  promote(): void {
    console.log("promoted");
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("Admin");
    expect(cls.extends).toBe("User");
  });

  it("extracts implements clause", () => {
    const code = `class UserService extends BaseService implements Serializable, Cacheable {
  serialize(): string {
    return "{}";
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toBeDefined();
    expect(cls.implements!.length).toBe(2);
    expect(cls.implements).toContain("Serializable");
    expect(cls.implements).toContain("Cacheable");
  });

  it("marks exported classes", () => {
    const code = `export class AppController {
  handle(): void {
    return;
  }
}`;
    const result = parse(code);
    expect(result.classes[0]!.isExported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

describe("TypeScript parser - imports", () => {
  it("parses named imports", () => {
    const code = `import { useState, useEffect } from "react";`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("react");
    const names = imp.specifiers.map((s) => s.name);
    expect(names).toContain("useState");
    expect(names).toContain("useEffect");
  });

  it("parses default imports", () => {
    const code = `import React from "react";`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("react");
    const defaultSpec = imp.specifiers.find((s) => s.isDefault);
    expect(defaultSpec).toBeDefined();
    expect(defaultSpec!.name).toBe("React");
  });

  it("parses star imports", () => {
    const code = `import * as path from "path";`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("path");
    const starSpec = imp.specifiers.find((s) => s.name === "*");
    expect(starSpec).toBeDefined();
    expect(starSpec!.alias).toBe("path");
  });

  it("parses type imports with named specifiers", () => {
    const code = `import type { ParsedFile, FunctionInfo } from "./base.ts";`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("./base.ts");
    const names = imp.specifiers.map((s) => s.name);
    expect(names).toContain("ParsedFile");
    expect(names).toContain("FunctionInfo");
  });
});

// ---------------------------------------------------------------------------
// Export parsing
// ---------------------------------------------------------------------------

describe("TypeScript parser - exports", () => {
  it("detects named exports", () => {
    const code = `export function doSomething(): void {
  return;
}
export const VALUE = 42;`;
    const result = parse(code);
    const names = result.exports.map((e) => e.name);
    expect(names).toContain("doSomething");
  });

  it("detects default exports", () => {
    const code = `export default function main() {
  return;
}`;
    const result = parse(code);
    const defaultExport = result.exports.find((e) => e.isDefault);
    expect(defaultExport).toBeDefined();
  });

  it("detects export default class", () => {
    const code = `export default class App {
  run(): void {
    return;
  }
}`;
    const result = parse(code);
    const defaultExport = result.exports.find((e) => e.isDefault);
    expect(defaultExport).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TSX / JSX detection
// ---------------------------------------------------------------------------

describe("TypeScript parser - TSX detection", () => {
  it("reports tsx language for .tsx files", () => {
    const code = `const App = () => {
  return <div>Hello</div>;
};`;
    const result = parse(code, "App.tsx");
    expect(result.language).toBe("tsx");
  });

  it("reports typescript language for .ts files", () => {
    const code = `const x = 42;`;
    const result = parse(code, "utils.ts");
    expect(result.language).toBe("typescript");
  });

  it("sets the correct filePath", () => {
    const result = parse("", "src/components/Button.tsx");
    expect(result.filePath).toBe("src/components/Button.tsx");
  });
});
