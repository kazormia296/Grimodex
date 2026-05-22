// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { applyValidatedLayout } from "./layoutStore";
import {
  buildDefaultLayoutState,
  validateLayoutState,
} from "./layoutStateUtils";
import type { LayoutState } from "./layoutTypes";

const VIEWPORT = { width: 1200, height: 800 };

function validLayout(): LayoutState {
  return buildDefaultLayoutState({ allInactive: true });
}

function invalidLayout(): LayoutState {
  // editor segment の無い center は validateLayoutState で不正と判定される。
  const layout = buildDefaultLayoutState({ allInactive: true });
  layout.center = { editorOpen: true, segments: [] };
  return layout;
}

describe("applyValidatedLayout", () => {
  it("returns the validated candidate when it is valid", () => {
    const candidate = validLayout();
    const fallback = validLayout();
    const result = applyValidatedLayout(candidate, fallback, VIEWPORT);
    expect(result).not.toBe(fallback);
    expect(validateLayoutState(result, { viewport: VIEWPORT }).valid).toBe(
      true,
    );
  });

  it("returns the fallback when the candidate is invalid", () => {
    const fallback = validLayout();
    const result = applyValidatedLayout(invalidLayout(), fallback, VIEWPORT);
    expect(result).toBe(fallback);
  });

  it("does not overwrite the layout with a fresh default on invalid input", () => {
    // 破壊的リセットの回帰防止: 不正な候補では fallback（直前の有効な
    // レイアウト）をそのまま返し、ユーザーのレイアウトを既定値で
    // 上書きしないこと。247 は既定値 260 と区別できる目印。
    const fallback = validLayout();
    fallback.regions.left.size = 247;
    const result = applyValidatedLayout(invalidLayout(), fallback, VIEWPORT);
    expect(result.regions.left.size).toBe(247);
  });
});
