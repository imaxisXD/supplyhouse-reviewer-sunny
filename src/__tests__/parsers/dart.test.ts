import { describe, it, expect } from "bun:test";
import { dartParser } from "../../indexing/parsers/dart.ts";

const parse = (code: string, filePath = "test.dart") =>
  dartParser.parse(code, filePath);

// ---------------------------------------------------------------------------
// Class extraction
// ---------------------------------------------------------------------------

describe("Dart parser - classes", () => {
  it("extracts a simple class", () => {
    const code = `class User {
  String name;
  int age;
  void greet() {
    print("Hello");
  }
}`;
    const result = parse(code);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("User");
    expect(cls.isExported).toBe(true); // does not start with _
  });

  it("marks private classes (underscore prefix) as not exported", () => {
    const code = `class _InternalWidget {
  void build() {
    return;
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("_InternalWidget");
    expect(cls.isExported).toBe(false);
  });

  it("extracts extends clause", () => {
    const code = `class AdminUser extends User {
  void promote() {
    print("promoted");
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.extends).toBe("User");
  });

  it("extracts implements clause", () => {
    const code = `class UserRepo extends BaseRepo implements Serializable {
  void save() {
    return;
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.extends).toBe("BaseRepo");
    expect(cls.implements).toBeDefined();
    expect(cls.implements).toContain("Serializable");
  });

  it("extracts mixins via 'with' as part of implements list", () => {
    const code = `class MyWidget extends StatelessWidget with ChangeNotifier {
  void build() {
    return;
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.extends).toBe("StatelessWidget");
    expect(cls.implements).toBeDefined();
    expect(cls.implements).toContain("ChangeNotifier");
  });
});

// ---------------------------------------------------------------------------
// Widget subclass detection
// ---------------------------------------------------------------------------

describe("Dart parser - widget subclasses", () => {
  it("detects StatelessWidget subclass", () => {
    const code = `class MyApp extends StatelessWidget {
  Widget build(BuildContext context) {
    return Container();
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("MyApp");
    expect(cls.extends).toBe("StatelessWidget");
  });

  it("detects StatefulWidget subclass", () => {
    const code = `class CounterPage extends StatefulWidget {
  State createState() {
    return CounterPageState();
  }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.extends).toBe("StatefulWidget");
  });
});

// ---------------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------------

describe("Dart parser - functions", () => {
  it("extracts a top-level function", () => {
    const code = `void main() {
  runApp(MyApp());
}`;
    const result = parse(code);
    expect(result.functions.length).toBeGreaterThanOrEqual(1);
    const fn = result.functions.find((f) => f.name === "main");
    expect(fn).toBeDefined();
    expect(fn!.returnType).toContain("void");
  });

  it("extracts a top-level function with return type", () => {
    const code = `String greet(String name) {
  return "Hello " + name;
}`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "greet");
    expect(fn).toBeDefined();
    expect(fn!.params).toContain("name");
  });

  it("marks private functions as not exported", () => {
    const code = `void _helper() {
  print("private");
}`;
    const result = parse(code);
    const fn = result.functions.find((f) => f.name === "_helper");
    expect(fn).toBeDefined();
    expect(fn!.isExported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

describe("Dart parser - imports", () => {
  it("parses a simple dart import", () => {
    const code = `import 'package:flutter/material.dart';

void main() {
  runApp(MyApp());
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("package:flutter/material.dart");
  });

  it("parses an import with alias (as)", () => {
    const code = `import 'dart:math' as math;

void main() {
  print(math.pi);
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("dart:math");
    const starSpec = imp.specifiers.find((s) => s.name === "*");
    expect(starSpec).toBeDefined();
    expect(starSpec!.alias).toBe("math");
  });

  it("parses import with show combinator", () => {
    const code = `import 'package:flutter/material.dart' show Widget, BuildContext;

void main() {
  return;
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    const names = imp.specifiers.map((s) => s.name);
    expect(names).toContain("Widget");
    expect(names).toContain("BuildContext");
  });

  it("parses a plain import and uses filename as default specifier", () => {
    const code = `import 'utils.dart';

void main() {
  return;
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("utils.dart");
    // The fallback parser extracts filename minus .dart as default import name
    const defaultSpec = imp.specifiers.find((s) => s.isDefault);
    expect(defaultSpec).toBeDefined();
    expect(defaultSpec!.name).toBe("utils");
  });
});

// ---------------------------------------------------------------------------
// Export parsing
// ---------------------------------------------------------------------------

describe("Dart parser - exports", () => {
  it("detects export statements", () => {
    const code = `export 'src/models/user.dart';
export 'src/services/auth.dart';`;
    const result = parse(code);
    expect(result.exports.length).toBe(2);
    const names = result.exports.map((e) => e.name);
    expect(names).toContain("src/models/user.dart");
    expect(names).toContain("src/services/auth.dart");
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("Dart parser - metadata", () => {
  it("reports dart as the language", () => {
    const result = parse("void main() { }", "main.dart");
    expect(result.language).toBe("dart");
  });

  it("preserves the file path", () => {
    const result = parse("void main() { }", "lib/src/app.dart");
    expect(result.filePath).toBe("lib/src/app.dart");
  });
});
