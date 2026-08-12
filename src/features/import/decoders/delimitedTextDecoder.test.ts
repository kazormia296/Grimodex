import { describe, expect, it } from "vitest";
import { delimitedTextDecoder, parseDelimitedLine } from "./delimitedTextDecoder";

describe("delimitedTextDecoder", () => {
  it("parses quoted CSV cells", () => {
    expect(parseDelimitedLine('"a,b",c', ",")).toEqual(["a,b", "c"]);
  });

  it("decodes CSV into table rows with structured data", () => {
    const csv = "name,role\nAlice,hero\nBob,villain";
    const bytes = new TextEncoder().encode(csv);
    const decoded = delimitedTextDecoder.decode({
      resourceKey: "codex",
      relativePath: "characters.csv",
      bytes,
    });
    expect(decoded.kind).toBe("table");
    expect(decoded.blocks).toHaveLength(2);
    const data = decoded.structuredData as { headers: string[]; rows: string[][] };
    expect(data.headers).toEqual(["name", "role"]);
    expect(data.rows[0]).toEqual(["Alice", "hero"]);
  });

  it("uses tab delimiter for .tsv extension", () => {
    const tsv = "a\tb\n1\t2";
    const bytes = new TextEncoder().encode(tsv);
    const decoded = delimitedTextDecoder.decode({
      resourceKey: "t",
      relativePath: "data.tsv",
      bytes,
    });
    const data = decoded.structuredData as { headers: string[] };
    expect(data.headers).toEqual(["a", "b"]);
  });
});
