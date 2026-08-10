import { describe, expect, it, beforeEach } from "vitest";
import {
  clearImportDecoderRegistryForTests,
  getImportDecoder,
  registerImportDecoder,
} from "./registry";
import { textDecoder } from "./textDecoder";
import { markdownDecoder } from "./markdownDecoder";
import { jsonDecoder } from "./jsonDecoder";
import { delimitedTextDecoder } from "./delimitedTextDecoder";
import { htmlDecoder } from "./htmlDecoder";

describe("import decoder registry", () => {
  beforeEach(() => {
    clearImportDecoderRegistryForTests();
  });

  it("registers and retrieves decoders by id+version", () => {
    registerImportDecoder(textDecoder);
    expect(getImportDecoder("text", "1")).toBe(textDecoder);
  });

  it("rejects duplicate id+version registration", () => {
    registerImportDecoder(textDecoder);
    expect(() => registerImportDecoder(textDecoder)).toThrow(/already registered/);
  });

  it("loads default decoders on module import", async () => {
    clearImportDecoderRegistryForTests();
    await import("./registerDefaults");
    expect(getImportDecoder("text", "1")).toBeDefined();
    expect(getImportDecoder("markdown", "1")).toBeDefined();
    expect(getImportDecoder("json", "1")).toBeDefined();
    expect(getImportDecoder("delimited-text", "1")).toBeDefined();
    expect(getImportDecoder("html", "1")).toBeDefined();
  });
});

export { textDecoder, markdownDecoder, jsonDecoder, delimitedTextDecoder, htmlDecoder };
