import { describe, it, expect, beforeEach } from "vitest";
import {
  registerImportAdapter,
  getImportAdapter,
  listImportAdapters,
  clearImportAdapterRegistryForTests,
} from "./registry";
import { markdownImportAdapter } from "./markdown/markdownImportAdapter";

describe("import adapter registry", () => {
  beforeEach(() => {
    clearImportAdapterRegistryForTests();
  });

  it("registers and retrieves adapters by id+version", () => {
    registerImportAdapter(markdownImportAdapter);
    expect(getImportAdapter("markdown", "1")).toBe(markdownImportAdapter);
    expect(listImportAdapters()).toHaveLength(1);
  });

  it("rejects duplicate id+version registration", () => {
    registerImportAdapter(markdownImportAdapter);
    expect(() => registerImportAdapter(markdownImportAdapter)).toThrow(
      /already registered/,
    );
  });
});
