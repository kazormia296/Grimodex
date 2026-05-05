import { describe, it, expect } from "vitest";
import { buildFocusNeighbors } from "./focusNeighbors";
import type { MapNodePositionRecord } from "../types";

function makePos(
  id: string,
  refType: "scene" | "codex" | "note" | "ai_branch",
  ref: string,
): MapNodePositionRecord {
  return {
    id,
    boardId: "b1",
    nodeRefType: refType,
    treeNodeId: refType === "scene" || refType === "note" ? ref : null,
    codexEntryId: refType === "codex" ? ref : null,
    snippetId: null,
    stickyId: null,
    aiBranchId: refType === "ai_branch" ? ref : null,
    x: 0,
    y: 0,
    pinned: 0,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
  };
}

const positions = [
  makePos("p1", "scene", "s1"),
  makePos("p2", "scene", "s2"),
  makePos("p3", "codex", "c1"),
];

const userEdges = [
  {
    id: "ue1",
    boardId: "b1",
    fromPositionId: "p1",
    toPositionId: "p3",
    forwardLabel: null,
    backwardLabel: null,
    labels: "[]",
    style: "solid" as const,
    color: "#000",
    direction: "none" as const,
    createdAt: "",
    updatedAt: "",
  },
];

describe("buildFocusNeighbors", () => {
  it("focused ノード自体は常に connected", () => {
    const result = buildFocusNeighbors("scene:s1", [], [], []);
    expect(result.has("scene:s1")).toBe(true);
  });

  it("visible edges の隣接ノードを含む", () => {
    const edges = [{ source: "scene:s1", target: "scene:s2" }];
    const result = buildFocusNeighbors("scene:s1", edges, [], []);
    expect(result.has("scene:s2")).toBe(true);
  });

  it("visible edges の逆方向隣接ノードも含む", () => {
    const edges = [{ source: "scene:s2", target: "scene:s1" }];
    const result = buildFocusNeighbors("scene:s1", edges, [], []);
    expect(result.has("scene:s2")).toBe(true);
  });

  it("userEdges を show.userEdges=false でも走査する（Fix 2）", () => {
    // edges 配列にはユーザーエッジ含まない（show.userEdges=false 相当）
    const result = buildFocusNeighbors("scene:s1", [], userEdges, positions);
    // p1=scene:s1, p3=codex:c1 がエッジで接続されているので codex:c1 が connected
    expect(result.has("codex:c1")).toBe(true);
  });

  it("関係のないノードは含まれない", () => {
    const edges = [{ source: "scene:s1", target: "scene:s2" }];
    const result = buildFocusNeighbors("scene:s1", edges, [], []);
    expect(result.has("codex:c1")).toBe(false);
  });

  it("focusedNodeId が null の場合は空 Set を返す", () => {
    const result = buildFocusNeighbors(null, [], [], []);
    expect(result.size).toBe(0);
  });
});
