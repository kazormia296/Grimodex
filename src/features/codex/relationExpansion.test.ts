import { describe, it, expect } from "vitest";
import { expandCodexRelationsBFS } from "./relationExpansion";
import type { CodexRelationRow } from "./codexRelationApi";
import type { CodexEntry } from "./api";

function makeEntry(id: string, name: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type: "character",
    name,
    aliases: null,
    excludedAliases: null,
    summary: `${name} summary`,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeRel(from: string, to: string, label: string): CodexRelationRow {
  return {
    id: `rel-${from}-${to}`,
    projectId: "p1",
    fromCodexId: from,
    toCodexId: to,
    relationType: "custom",
    label,
    depthHint: null,
    sourceMapEdgeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("expandCodexRelationsBFS", () => {
  const entries = [
    makeEntry("a", "Alice"),
    makeEntry("b", "Bob"),
    makeEntry("c", "Carol"),
  ];

  it("returns empty when no relations", () => {
    expect(expandCodexRelationsBFS(["a"], [], entries, new Set(["a"]))).toEqual(
      [],
    );
  });

  it("expands one hop with via label", () => {
    const relations = [makeRel("a", "b", "師匠")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a"]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("b");
    expect(result[0]?.relationVia).toContain("師匠");
    expect(result[0]?.relationVia).toContain("Alice");
  });

  it("skips ids already in L4 exclude set", () => {
    const relations = [makeRel("a", "b", "師匠")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a", "b"]),
    );
    expect(result).toHaveLength(0);
  });

  it("BFS reaches depth 2", () => {
    const relations = [makeRel("a", "b", "友"), makeRel("b", "c", "同僚")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a"]),
    );
    expect(result.map((r) => r.id).sort()).toEqual(["b", "c"]);
  });

  it("encodes direction: forward traversal uses 'from {fromName}'", () => {
    const relations = [makeRel("a", "b", "師匠")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a"]),
    );
    expect(result[0]?.relationVia).toBe("from Alice via 師匠");
  });

  it("encodes direction: backward traversal uses 'to {toName}'", () => {
    const relations = [makeRel("a", "b", "師匠")];
    const result = expandCodexRelationsBFS(
      ["b"],
      relations,
      entries,
      new Set(["b"]),
    );
    expect(result[0]?.id).toBe("a");
    expect(result[0]?.relationVia).toBe("to Bob via 師匠");
  });

  it("respects maxDepth option (1 = no second hop)", () => {
    const relations = [makeRel("a", "b", "友"), makeRel("b", "c", "同僚")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a"]),
      { maxDepth: 1 },
    );
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("respects maxEntries option", () => {
    const relations = [makeRel("a", "b", "友"), makeRel("a", "c", "敵")];
    const result = expandCodexRelationsBFS(
      ["a"],
      relations,
      entries,
      new Set(["a"]),
      { maxEntries: 1 },
    );
    expect(result).toHaveLength(1);
  });
});
