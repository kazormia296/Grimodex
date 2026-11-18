import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import fixture from "./fixtures/reading-order-parity.json";
import { buildReadingOrder } from "./sceneTimeIndex";

/**
 * The TS half of the reading-order parity (chat IR S1-B, DR-CHATIR-S1-30, G6 (c)
 * conditions 1 to 3). The `rust` expectations in the fixture are for the cargo
 * test of S1-A2; nothing here runs them, so these tests do not hold the two
 * implementations equal.
 */

interface FixtureNode {
  id: string;
  parentId: string | null;
  nodeType: string;
  sortOrder: string;
  archived: boolean;
}

interface FixtureCase {
  id: string;
  nodes: FixtureNode[];
  ts: { readingOrder: string[] };
  rust:
    | { kind: "order"; sceneIds: string[] }
    | { kind: "error"; code: string; reason: string };
}

function toTreeNode(node: FixtureNode): TreeNodeData {
  return {
    id: node.id,
    projectId: "p1",
    parentId: node.parentId,
    nodeType: node.nodeType as TreeNodeData["nodeType"],
    title: node.id,
    synopsis: null,
    intent: null,
    sortOrder: node.sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    archivedAt: node.archived ? "2026-01-01T00:00:00.000Z" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const cases = fixture.cases as FixtureCase[];

function orderedSceneIds(order: Map<string, number>): string[] {
  return [...order.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

describe("reading-order parity fixture (TS half)", () => {
  it("has the cases the design names", () => {
    expect(cases.map((c) => c.id)).toEqual([
      "baseline-nested",
      "duplicate-sort-order-same-parent",
      "duplicate-sort-order-at-root",
      "orphan-scene",
      "scene-with-live-child",
      "note-with-live-child",
      "unknown-node-type",
      "archived-subtree",
    ]);
    for (const c of cases) {
      expect(["order", "error"]).toContain(c.rust.kind);
    }
  });

  for (const c of cases) {
    it(`buildReadingOrder: ${c.id}`, () => {
      const order = buildReadingOrder(c.nodes.map(toTreeNode));
      expect(orderedSceneIds(order)).toEqual(c.ts.readingOrder);
      // Indexes are dense from 0.
      expect([...order.values()].sort((a, b) => a - b)).toEqual(
        c.ts.readingOrder.map((_, index) => index),
      );
    });
  }

  it("returns a value, not an error, where Rust rejects the tree (the split the fixture records)", () => {
    const rejected = cases.filter((c) => c.rust.kind === "error");
    expect(rejected.length).toBe(6);
    for (const c of rejected) {
      expect(() => buildReadingOrder(c.nodes.map(toTreeNode))).not.toThrow();
    }
  });

  it("does not depend on the input row order", () => {
    for (const c of cases) {
      const reversed = [...c.nodes].reverse().map(toTreeNode);
      expect(orderedSceneIds(buildReadingOrder(reversed))).toEqual(
        c.ts.readingOrder,
      );
    }
  });

  it("agrees with the rust expectation where Rust returns an order", () => {
    for (const c of cases) {
      if (c.rust.kind !== "order") continue;
      expect(c.ts.readingOrder).toEqual(c.rust.sceneIds);
    }
  });
});
