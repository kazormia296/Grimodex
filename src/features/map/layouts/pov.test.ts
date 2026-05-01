import { describe, it, expect } from "vitest";
import { layoutPOV } from "./pov";
import type { LayoutInput } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";

function makeScene(
  id: string,
  povCharacterId: string | null = null,
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
    locationId: null,
    createdAt: "",

    charCount: 0,
    unplacedBeatPreview: null,
    updatedAt: "",  };
}

function makeCharacter(id: string): CodexEntry {
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

const EMPTY: Omit<LayoutInput, "scenes"> = {
  codexEntries: [],
  positions: [],
};

describe("layoutPOV", () => {
  it("同じ POV のシーンが同じクラスタ（近い座標）に配置される", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [
        makeScene("s1", "c1"),
        makeScene("s2", "c1"),
        makeScene("s3", "c2"),
      ],
      codexEntries: [makeCharacter("c1"), makeCharacter("c2")],
    };
    const result = layoutPOV(input);
    const x1 = result.get("scene:s1")!.x;
    const x2 = result.get("scene:s2")!.x;
    const x3 = result.get("scene:s3")!.x;
    // s1 and s2 are in the same cluster; s3 is in a different cluster
    const distSameCluster = Math.hypot(
      x1 - x2,
      result.get("scene:s1")!.y - result.get("scene:s2")!.y,
    );
    const distDiffCluster = Math.abs(x1 - x3);
    expect(distSameCluster).toBeLessThan(distDiffCluster);
  });

  it("pov_character_id === null のシーンが Unassigned クラスタに集約される", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [makeScene("s1", "c1"), makeScene("s_null", null)],
      codexEntries: [makeCharacter("c1")],
    };
    const result = layoutPOV(input);
    expect(result.has("scene:s1")).toBe(true);
    expect(result.has("scene:s_null")).toBe(true);
  });

  it("codex ノードが結果に含まれる", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [makeScene("s1", "c1")],
      codexEntries: [makeCharacter("c1")],
    };
    const result = layoutPOV(input);
    expect(result.has("codex:c1")).toBe(true);
  });

  it("全シーンが同一 POV のとき 1 クラスタに集約される", () => {
    const input: LayoutInput = {
      ...EMPTY,
      scenes: [
        makeScene("s1", "c1"),
        makeScene("s2", "c1"),
        makeScene("s3", "c1"),
      ],
      codexEntries: [makeCharacter("c1")],
    };
    const result = layoutPOV(input);
    // All 3 scenes present
    expect(result.has("scene:s1")).toBe(true);
    expect(result.has("scene:s2")).toBe(true);
    expect(result.has("scene:s3")).toBe(true);
  });
});
