import { describe, it, expect } from "vitest";
import {
  findDuplicateNodeKeys,
  findNodeParentCycles,
  validateImportSourceNodes,
} from "./adapterValidation";
import type { ImportSourceNode } from "../core/importSourceNode";

describe("adapterValidation", () => {
  it("detects duplicate node keys", () => {
    const nodes: ImportSourceNode[] = [
      { key: "a", parentKey: null, title: "A", orderIndex: 0, kind: "folder" },
      { key: "a", parentKey: null, title: "A2", orderIndex: 1, kind: "folder" },
    ];
    expect(findDuplicateNodeKeys(nodes)).toEqual(["a"]);
  });

  it("detects parent cycles", () => {
    const nodes: ImportSourceNode[] = [
      { key: "a", parentKey: "b", title: "A", orderIndex: 0, kind: "folder" },
      { key: "b", parentKey: "a", title: "B", orderIndex: 1, kind: "folder" },
    ];
    expect(findNodeParentCycles(nodes)).toEqual(["a", "b"]);
  });

  it("returns diagnostics for invalid nodes", () => {
    const nodes: ImportSourceNode[] = [
      { key: "x", parentKey: "x", title: "X", orderIndex: 0, kind: "scene" },
    ];
    const diagnostics = validateImportSourceNodes(nodes);
    expect(diagnostics.some((d) => d.code === "node-parent-cycle")).toBe(true);
  });
});
