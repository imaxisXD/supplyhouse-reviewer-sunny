import { describe, it, expect } from "bun:test";
import { ftlParser } from "../../indexing/parsers/ftl.ts";

const parse = (code: string, filePath = "template.ftl") =>
  ftlParser.parse(code, filePath);

describe("FTL parser - macros", () => {
  it("extracts macro blocks as functions", () => {
    const code = `<#macro greeting name>
Hello \${name}
</#macro>

<#macro footer>
Bye
</#macro>`;
    const result = parse(code);
    expect(result.functions.length).toBe(2);
    expect(result.functions[0]!.name).toBe("macro:greeting");
    expect(result.functions[0]!.startLine).toBe(1);
    expect(result.functions[1]!.name).toBe("macro:footer");
  });

  it("falls back to single template function when no macros exist", () => {
    const code = `Hello world`;
    const result = parse(code, "emails/welcome.ftl");
    expect(result.functions.length).toBe(1);
    expect(result.functions[0]!.name).toBe("welcome.ftl");
    expect(result.functions[0]!.startLine).toBe(1);
  });
});
