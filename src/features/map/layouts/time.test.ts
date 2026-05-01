import { describe, it, expect } from "vitest";
import { layoutTime } from "./time";
import type { LayoutInput } from "./types";

function makeScene(
  id: string,
  storyTimeOrder: string | null,
  povCharacterId: string | null = null,
): LayoutInput["scenes"][0] {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    sortOrder: "a",
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId,
    locationId: null,
    createdAt: "",

    charCount: 0,
    unplacedBeatPreview: null,
    updatedAt: "",
  };
}

const EMPTY_INPUT: LayoutInput = {
  scenes: [],
  codexEntries: [],
  positions: [],
};

describe("layoutTime", () => {
  it("storyTimeOrder があるシーンは X 軸に昇順で並ぶ", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [
        makeScene("s1", "b"),
        makeScene("s2", "a"),
        makeScene("s3", "c"),
      ],
    });
    // Sorted: s2(a) → s1(b) → s3(c)
    const x2 = result.get("scene:s2")!.x;
    const x1 = result.get("scene:s1")!.x;
    const x3 = result.get("scene:s3")!.x;
    expect(x2).toBeLessThan(x1);
    expect(x1).toBeLessThan(x3);
  });

  it("storyTimeOrder が null のシーンは scheduled シーンの右側に配置される", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [makeScene("s1", "a"), makeScene("s_unscheduled", null)],
    });
    const x1 = result.get("scene:s1")!.x;
    const xu = result.get("scene:s_unscheduled")!.x;
    expect(xu).toBeGreaterThan(x1);
  });

  it("全シーンが unscheduled の場合も座標が返る", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [makeScene("s1", null), makeScene("s2", null)],
    });
    expect(result.has("scene:s1")).toBe(true);
    expect(result.has("scene:s2")).toBe(true);
    expect(result.get("scene:s1")!.x).toBeLessThan(result.get("scene:s2")!.x);
  });

  it("scheduled シーンは Y = 200 (Y_BASE) で水平に並ぶ", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [makeScene("s1", "a"), makeScene("s2", "b")],
    });
    expect(result.get("scene:s1")!.y).toBe(200);
    expect(result.get("scene:s2")!.y).toBe(200);
  });

  it("unscheduled シーンは Y = 440 (Y_BASE + 240) に配置される", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [makeScene("s1", "a"), makeScene("s_u", null)],
    });
    expect(result.get("scene:s_u")!.y).toBe(440);
  });

  it("POV が設定されたシーンは POV 別レーンに配置される", () => {
    const result = layoutTime({
      ...EMPTY_INPUT,
      scenes: [makeScene("s1", "a", "c1"), makeScene("s2", "b", "c2")],
      codexEntries: [],
    });
    // c1 is lane 0 → Y = 200; c2 is lane 1 → Y = 440
    expect(result.get("scene:s1")!.y).toBe(200);
    expect(result.get("scene:s2")!.y).toBe(440);
  });

  it("codex エントリは scheduled シーンより上に配置される", () => {
    const result = layoutTime({
      scenes: [makeScene("s1", "a")],
      codexEntries: [
        {
          id: "c1",
          projectId: "p1",
          parentId: null,
          type: "character",
          name: "C",
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
        },
      ],
      positions: [],
    });
    const sceneY = result.get("scene:s1")!.y;
    const codexY = result.get("codex:c1")!.y;
    expect(codexY).toBeLessThan(sceneY);
  });
});
