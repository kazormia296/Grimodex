import { describe, it, expect } from "vitest";
import { layoutFingerprint } from "./layoutFingerprint";
import type { MapNodePositionRecord } from "../types";
import type { SceneLayoutInput } from "./types";
import type { CodexEntry } from "@/features/codex/api";

function makePosition(
  id: string,
  overrides: Partial<MapNodePositionRecord> = {},
): MapNodePositionRecord {
  return {
    id,
    boardId: "b1",
    nodeRefType: "scene",
    treeNodeId: "s1",
    codexEntryId: null,
    snippetId: null,
    stickyId: null,
    aiBranchId: null,
    x: 0,
    y: 0,
    pinned: 0,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function makeScene(id: string): SceneLayoutInput {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    sortOrder: "a",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "",
    updatedAt: "",
  };
}

function makeCodex(id: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type: "character",
    name: id,
    aliases: null,
    excludedAliases: null,
    summary: null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "",
    updatedAt: "",
  };
}

describe("layoutFingerprint", () => {
  const base = {
    boardId: "b1",
    scenes: [makeScene("s1")],
    codexEntries: [makeCodex("c1")],
    positions: [
      makePosition("pos-s1", { treeNodeId: "s1", x: 10, y: 20 }),
      makePosition("pos-c1", {
        nodeRefType: "codex",
        treeNodeId: null,
        codexEntryId: "c1",
        x: 100,
        y: 200,
      }),
    ],
    userEdges: [] as { fromPositionId: string; toPositionId: string }[],
  };

  it("x,y 変更のみでは fingerprint が変わらない", () => {
    const fp1 = layoutFingerprint(base);
    const fp2 = layoutFingerprint({
      ...base,
      positions: base.positions.map((p) => ({
        ...p,
        x: p.x + 500,
        y: p.y + 500,
      })),
    });
    expect(fp2).toBe(fp1);
  });

  it("unpin すると fingerprint が変わる", () => {
    const pinned = layoutFingerprint({
      ...base,
      positions: [makePosition("pos-s1", { pinned: 1 })],
    });
    const unpinned = layoutFingerprint({
      ...base,
      positions: [makePosition("pos-s1", { pinned: 0 })],
    });
    expect(unpinned).not.toBe(pinned);
  });

  it("user edge 追加で fingerprint が変わる", () => {
    const without = layoutFingerprint(base);
    const withEdge = layoutFingerprint({
      ...base,
      userEdges: [{ fromPositionId: "pos-s1", toPositionId: "pos-c1" }],
    });
    expect(withEdge).not.toBe(without);
  });
});
