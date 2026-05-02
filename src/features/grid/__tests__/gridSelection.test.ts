import { describe, it, expect } from "vitest";
import { toggleSceneSelection, rangeSelectScenes } from "../gridSelection";

describe("toggleSceneSelection", () => {
  it("追加する", () => {
    const result = toggleSceneSelection(new Set(["a"]), "b");
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("既存 ID を削除する", () => {
    const result = toggleSceneSelection(new Set(["a", "b"]), "a");
    expect(result).toEqual(new Set(["b"]));
  });

  it("空集合に追加する", () => {
    const result = toggleSceneSelection(new Set(), "x");
    expect(result).toEqual(new Set(["x"]));
  });

  it("元の Set を変更しない（immutable）", () => {
    const original = new Set(["a"]);
    toggleSceneSelection(original, "b");
    expect(original.size).toBe(1);
  });
});

describe("rangeSelectScenes", () => {
  const flat = ["s1", "s2", "s3", "s4", "s5"];

  it("前方向の範囲選択", () => {
    const result = rangeSelectScenes(flat, "s1", "s3");
    expect(result).toEqual(new Set(["s1", "s2", "s3"]));
  });

  it("後方向の範囲選択（逆順でも同じ結果）", () => {
    const result = rangeSelectScenes(flat, "s4", "s2");
    expect(result).toEqual(new Set(["s2", "s3", "s4"]));
  });

  it("同じ ID を指定すると1件のみ選択", () => {
    const result = rangeSelectScenes(flat, "s3", "s3");
    expect(result).toEqual(new Set(["s3"]));
  });

  it("anchor が flatOrder に存在しない場合は target のみ選択", () => {
    const result = rangeSelectScenes(flat, "missing", "s2");
    expect(result).toEqual(new Set(["s2"]));
  });

  it("target が flatOrder に存在しない場合は target のみ選択", () => {
    const result = rangeSelectScenes(flat, "s2", "missing");
    expect(result).toEqual(new Set(["missing"]));
  });

  it("Loose 列を含む全範囲", () => {
    const all = ["s1", "s2", "loose1", "loose2"];
    const result = rangeSelectScenes(all, "s2", "loose1");
    expect(result).toEqual(new Set(["s2", "loose1"]));
  });
});
