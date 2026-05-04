import { describe, it, expect } from "vitest";
import { layoutPlace } from "./place";
import type { LayoutInput } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";

function makeScene(id: string, locationId: string | null = null): TreeNodeData {
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
    povCharacterId: null,
    locationId,
    createdAt: "",

    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    updatedAt: "",
  };
}

function makeLocation(id: string): CodexEntry {
  return {
    id,
    projectId: "p1",
    parentId: null,
    type: "location",
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

const EMPTY: Omit<LayoutInput, "scenes"> = {
  codexEntries: [],
  positions: [],
};

describe("layoutPlace", () => {
  it("同じ location のシーンが同じクラスタに配置される", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [
        makeScene("s1", "loc1"),
        makeScene("s2", "loc1"),
        makeScene("s3", "loc2"),
      ],
      codexEntries: [makeLocation("loc1"), makeLocation("loc2")],
    };
    const result = layoutPlace(input);
    const pos1 = result.get("scene:s1")!;
    const pos2 = result.get("scene:s2")!;
    const pos3 = result.get("scene:s3")!;
    const distSame = Math.hypot(pos1.x - pos2.x, pos1.y - pos2.y);
    const distDiff = Math.abs(pos1.x - pos3.x);
    expect(distSame).toBeLessThan(distDiff);
  });

  it("location_id === null のシーンが Unassigned クラスタに入る", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [makeScene("s1", "loc1"), makeScene("s_null", null)],
      codexEntries: [makeLocation("loc1")],
    };
    const result = layoutPlace(input);
    expect(result.has("scene:s1")).toBe(true);
    expect(result.has("scene:s_null")).toBe(true);
  });

  it("location codex ノードが結果に含まれる", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [makeScene("s1", "loc1")],
      codexEntries: [makeLocation("loc1")],
    };
    const result = layoutPlace(input);
    expect(result.has("codex:loc1")).toBe(true);
  });
});
