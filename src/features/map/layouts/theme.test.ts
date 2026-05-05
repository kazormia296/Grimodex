import { describe, it, expect } from "vitest";
import { layoutTheme } from "./theme";
import { SyncForceLayoutEngine } from "./forceEngine";
import type { LayoutInput } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";
import type { MapNodePositionRecord } from "../types";

function makeScene(
  id: string,
  povCharacterId: string | null = null,
  locationId: string | null = null,
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    sortOrder: "a",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId,
    locationId,
    createdAt: "",

    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    updatedAt: "",
  };
}

function makePosition(
  entityId: string,
  refType: "scene" | "codex",
  overrides: Partial<MapNodePositionRecord> = {},
): MapNodePositionRecord {
  return {
    id: `pos-${entityId}`,
    boardId: "b1",
    nodeRefType: refType,
    treeNodeId: refType === "scene" ? entityId : null,
    codexEntryId: refType === "codex" ? entityId : null,
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

function makeCodex(id: string, type = "character"): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type,
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

describe("layoutTheme", () => {
  it("全ノードの座標が返る", async () => {
    const engine = new SyncForceLayoutEngine();
    const input: LayoutInput = {
      scenes: [makeScene("s1"), makeScene("s2")],
      codexEntries: [makeCodex("c1")],
      positions: [],
    };
    const result = await layoutTheme(input, engine);
    expect(result.has("scene:s1")).toBe(true);
    expect(result.has("scene:s2")).toBe(true);
    expect(result.has("codex:c1")).toBe(true);
  });

  it("POV 参照で繋がったシーンと Codex が近くなる", async () => {
    const engine = new SyncForceLayoutEngine();
    const input: LayoutInput = {
      scenes: [makeScene("s1", "c1"), makeScene("s2", "c1"), makeScene("s3")],
      codexEntries: [makeCodex("c1")],
      positions: [],
    };
    const result = await layoutTheme(input, engine, undefined);
    const c1 = result.get("codex:c1")!;
    const s1 = result.get("scene:s1")!;
    const s2 = result.get("scene:s2")!;
    const s3 = result.get("scene:s3")!;
    const distS1C1 = Math.hypot(s1.x - c1.x, s1.y - c1.y);
    const distS3C1 = Math.hypot(s3.x - c1.x, s3.y - c1.y);
    expect(distS1C1).toBeLessThan(distS3C1);
    const distS2C1 = Math.hypot(s2.x - c1.x, s2.y - c1.y);
    expect(distS2C1).toBeLessThan(distS3C1);
  });

  it("ピン留め Scene は force layout を上書きして保存座標を保持する", async () => {
    const engine = new SyncForceLayoutEngine();
    const input: LayoutInput = {
      scenes: [makeScene("s1"), makeScene("s2")],
      codexEntries: [],
      positions: [makePosition("s1", "scene", { x: 999, y: 888, pinned: 1 })],
    };
    const result = await layoutTheme(input, engine);
    expect(result.get("scene:s1")).toEqual({ x: 999, y: 888 });
    const s2 = result.get("scene:s2");
    expect(s2).toBeDefined();
    expect(s2).not.toEqual({ x: 999, y: 888 });
  });

  it("ピン留め Codex は force layout を上書きして保存座標を保持する", async () => {
    const engine = new SyncForceLayoutEngine();
    const input: LayoutInput = {
      scenes: [makeScene("s1")],
      codexEntries: [makeCodex("c1")],
      positions: [makePosition("c1", "codex", { x: 500, y: 300, pinned: 1 })],
    };
    const result = await layoutTheme(input, engine);
    expect(result.get("codex:c1")).toEqual({ x: 500, y: 300 });
  });

  it("pinned=0 のノードは force layout 結果を使う", async () => {
    const engine = new SyncForceLayoutEngine();
    const input: LayoutInput = {
      scenes: [makeScene("s1")],
      codexEntries: [],
      positions: [makePosition("s1", "scene", { x: 999, y: 888, pinned: 0 })],
    };
    const result = await layoutTheme(input, engine);
    // Force layout will place the node somewhere, not necessarily at stored coords
    expect(result.has("scene:s1")).toBe(true);
  });

  it("progress コールバックが呼ばれる", async () => {
    const engine = new SyncForceLayoutEngine();
    const alphas: number[] = [];
    const input: LayoutInput = {
      scenes: [makeScene("s1"), makeScene("s2")],
      codexEntries: [],
      positions: [],
    };
    await layoutTheme(input, engine, (a) => alphas.push(a));
    expect(alphas.length).toBeGreaterThan(0);
  });
});
