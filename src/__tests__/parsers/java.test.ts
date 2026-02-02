import { describe, it, expect } from "bun:test";
import { javaParser } from "../../indexing/parsers/java.ts";

const parse = (code: string, filePath = "Test.java") =>
  javaParser.parse(code, filePath);

// ---------------------------------------------------------------------------
// Class extraction
// ---------------------------------------------------------------------------

describe("Java parser - classes", () => {
  it("extracts a public class with methods", () => {
    const code = `public class Calculator {
    public int add(int a, int b) {
        return a + b;
    }
    public int subtract(int a, int b) {
        return a - b;
    }
}`;
    const result = parse(code);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("Calculator");
    expect(cls.isExported).toBe(true);
    expect(cls.methods.length).toBeGreaterThanOrEqual(2);
    const addMethod = cls.methods.find((m) => m.name === "add");
    expect(addMethod).toBeDefined();
    expect(addMethod!.params).toContain("int a");
  });

  it("extracts class with extends and implements", () => {
    const code = `public class UserService extends BaseService implements Serializable {
    public void save(String name) {
        System.out.println(name);
    }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("UserService");
    expect(cls.extends).toBe("BaseService");
    expect(cls.implements).toBeDefined();
    expect(cls.implements).toContain("Serializable");
  });

  it("extracts class fields as properties", () => {
    const code = `public class User {
    private String name;
    private int age;
    public String getName() {
        return name;
    }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.properties.length).toBeGreaterThanOrEqual(2);
    const nameProp = cls.properties.find((p) => p.name === "name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.type).toBe("String");
  });

  it("marks private classes as not exported", () => {
    const code = `class InternalHelper {
    void doWork() {
        return;
    }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.isExported).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe("Java parser - annotations", () => {
  it("extracts class with @Override method", () => {
    const code = `public class MyService extends BaseService {
    @Override
    public String toString() {
        return "MyService";
    }
    public void process() {
        return;
    }
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.methods.length).toBeGreaterThanOrEqual(1);
    // The regex parser should still pick up methods even with annotations
    const toStringMethod = cls.methods.find((m) => m.name === "toString");
    expect(toStringMethod).toBeDefined();
  });

  it("handles class-level annotations without breaking parsing", () => {
    const code = `@Entity
@Table(name = "users")
public class UserEntity {
    private Long id;
    private String name;
}`;
    const result = parse(code);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("UserEntity");
  });
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

describe("Java parser - imports", () => {
  it("parses standard imports", () => {
    const code = `import java.util.List;
import java.util.Map;

public class App {
    public void run() {
        return;
    }
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(2);

    const listImport = result.imports.find((imp) =>
      imp.source.includes("java.util.List"),
    );
    expect(listImport).toBeDefined();
    expect(listImport!.specifiers[0]!.name).toBe("List");

    const mapImport = result.imports.find((imp) =>
      imp.source.includes("java.util.Map"),
    );
    expect(mapImport).toBeDefined();
    expect(mapImport!.specifiers[0]!.name).toBe("Map");
  });

  it("parses wildcard imports", () => {
    const code = `import java.util.*;

public class App {
    public void run() {
        return;
    }
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toBe("java.util.*");
    expect(imp.specifiers[0]!.name).toBe("*");
  });

  it("parses static imports", () => {
    const code = `import static org.junit.Assert.assertEquals;

public class TestApp {
    public void test() {
        return;
    }
}`;
    const result = parse(code);
    expect(result.imports.length).toBe(1);
    const imp = result.imports[0]!;
    expect(imp.source).toContain("org.junit.Assert.assertEquals");
  });
});

// ---------------------------------------------------------------------------
// Interface extraction
// ---------------------------------------------------------------------------

describe("Java parser - interfaces", () => {
  it("extracts an interface declaration", () => {
    const code = `public interface Repository {
    void save(String entity);
    String findById(int id);
}`;
    const result = parse(code);
    expect(result.classes.length).toBe(1);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("Repository");
    expect(cls.isExported).toBe(true);
  });

  it("extracts interface with extends", () => {
    const code = `public interface CrudRepository extends Repository {
    void delete(int id);
}`;
    const result = parse(code);
    const cls = result.classes[0]!;
    expect(cls.name).toBe("CrudRepository");
    expect(cls.extends).toBe("Repository");
  });
});

// ---------------------------------------------------------------------------
// Language and file metadata
// ---------------------------------------------------------------------------

describe("Java parser - metadata", () => {
  it("reports java as the language", () => {
    const result = parse("public class Foo { }", "Foo.java");
    expect(result.language).toBe("java");
  });

  it("preserves the file path", () => {
    const result = parse("public class Bar { }", "src/main/Bar.java");
    expect(result.filePath).toBe("src/main/Bar.java");
  });
});
