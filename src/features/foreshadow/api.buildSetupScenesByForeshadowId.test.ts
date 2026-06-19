import { describe, it, expect } from "vitest";
import { buildSetupScenesByForeshadowId } from "./api";

describe("buildSetupScenesByForeshadowId", () => {
  it("非孤立 setup のシーン ID を伏線ごとにまとめる", () => {
    const index = buildSetupScenesByForeshadowId([
      { foreshadowId: "f1", sceneId: "s1" },
      { foreshadowId: "f1", sceneId: "s2" },
      { foreshadowId: "f2", sceneId: "s1" },
    ]);
    expect(index).toEqual({ f1: ["s1", "s2"], f2: ["s1"] });
  });

  it("isOrphan の setup は除外する (setupCount と一致)", () => {
    const index = buildSetupScenesByForeshadowId([
      { foreshadowId: "f1", sceneId: "s1", isOrphan: true },
      { foreshadowId: "f1", sceneId: "s2", isOrphan: false },
    ]);
    expect(index).toEqual({ f1: ["s2"] });
  });

  it("同一シーンの重複は 1 回だけにする", () => {
    const index = buildSetupScenesByForeshadowId([
      { foreshadowId: "f1", sceneId: "s1" },
      { foreshadowId: "f1", sceneId: "s1" },
    ]);
    expect(index).toEqual({ f1: ["s1"] });
  });

  it("sceneId 無しの setup はスキップする", () => {
    const index = buildSetupScenesByForeshadowId([
      { foreshadowId: "f1" },
      { foreshadowId: "f1", sceneId: "s1" },
    ]);
    expect(index).toEqual({ f1: ["s1"] });
  });

  it("空入力は空オブジェクト", () => {
    expect(buildSetupScenesByForeshadowId([])).toEqual({});
  });
});
