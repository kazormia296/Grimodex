/**
 * 実 Chromium で AnimatedRegionChrome の open 状態 clip-path が region の
 * border-box を **外側** でクリップする（= 隣接パネルの box-shadow を切り落と
 * さない）ことを gate する。
 *
 * 背景 / 守る不変条件:
 *   Framer Motion (motion@12) は clip-path を `inset(...)` から `none` キーワード
 *   へ補間できず、`none` を `inset(0 0 0 0)` に置換する。その結果 open 値が `none`
 *   だと、closed→open 補間を経た settled 状態で computed clip-path が
 *   `inset(0px 0% 0px 0px)` になり、region border-box で gx-panel の box-shadow が
 *   クリップされて region 間 gap にカンバスのグレーが透ける。回避策が
 *   `REGION_OPEN_CLIP = "inset(-200px)"`（layoutAnimation.ts のコメント参照）。
 *
 * なぜ単体テスト/幾何ブラウザテストで足りないのに pixel 回帰は不要か:
 *   この欠陥の **視覚効果**（影が切れてグレーが透ける）は paint-time で起き、
 *   getBoundingClientRect には現れない。しかし **原因** である置換後の clip-path
 *   値は CSSOM に載り `getComputedStyle().clipPath` から parseable な文字列で
 *   読める。よって screenshot/pixel 回帰基盤は不要で、computed clip-path を
 *   assert すれば決定論的に gate できる。happy-dom は WAAPI 補間を実行せず値を
 *   素通しする（`none` → `none` のまま）ため置換を再現できない → browser 必須。
 *
 * 壊さないこと（toggle 経路は load-bearing）:
 *   closed→open の **toggle**（rerender）で開くこと。`render(<X open />)` の
 *   mount-open は `<AnimatePresence initial={false}>` が enter 補間を抑制するため
 *   置換が起きず、バグ値でも computed が `none` のまま通過して gate が死ぬ。
 *
 * 差分検証済み: layoutAnimation.ts の REGION_OPEN_CLIP を `"none"` に戻すと
 *   settled computed が `inset(0px 0% 0px 0px)` になり、各 region で本テストが
 *   「offset must be < 0」で fail する。
 */
import { beforeEach, describe, it, expect } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { REGION_CLIP_PATH, type RegionChromeId } from "./layoutAnimation";
import { useLayoutStore } from "./layoutStore";

/** settled な `inset(...)` から数値 offset を取り出す。`none` 等は [] を返す。 */
function insetOffsets(clipPath: string): number[] {
  const m = clipPath.match(/^inset\((.*)\)$/);
  if (!m) return [];
  return [...m[1].matchAll(/-?\d*\.?\d+/g)].map((x) => parseFloat(x[0]));
}

const REGIONS = Object.keys(REGION_CLIP_PATH) as RegionChromeId[];

describe("AnimatedRegionChrome open clip-path invariant", () => {
  beforeEach(() => {
    useLayoutStore.setState({ initialized: true });
  });

  it("shows startup hydration at its final opacity without an enter animation", () => {
    useLayoutStore.setState({ initialized: false });
    const child = <div>child</div>;
    const { rerender, container } = render(
      <AnimatedRegionChrome region="left" open={false}>
        {child}
      </AnimatedRegionChrome>,
    );

    act(() => {
      useLayoutStore.setState({ initialized: true });
      rerender(
        <AnimatedRegionChrome region="left" open>
          {child}
        </AnimatedRegionChrome>,
      );
    });

    const node = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    );
    expect(node).not.toBeNull();
    expect(getComputedStyle(node!).opacity).toBe("1");
  });

  it.each(REGIONS)(
    "settled open clip-path clips OUTSIDE the border-box (region=%s)",
    async (region) => {
      const child = <div>child</div>;
      const { rerender, container } = render(
        <AnimatedRegionChrome region={region} open={false}>
          {child}
        </AnimatedRegionChrome>,
      );
      // closed→open の toggle で enter 補間を発火させる（mount-open では再現不可。
      // ヘッダ「toggle 経路は load-bearing」参照）。
      rerender(
        <AnimatedRegionChrome region={region} open={true}>
          {child}
        </AnimatedRegionChrome>,
      );

      const el = await waitFor(() => {
        const node = container.querySelector<HTMLElement>(
          "[data-animated-region]",
        );
        if (!node) throw new Error("region chrome not mounted");
        const cs = getComputedStyle(node);
        // opacity と clip-path は同一 transition で駆動されるので、opacity 完了かつ
        // clip に補間途中の calc() が残っていなければ settled とみなせる。
        if (cs.opacity !== "1" || cs.clipPath.includes("calc")) {
          throw new Error(
            `not settled: opacity=${cs.opacity} clip=${cs.clipPath}`,
          );
        }
        return node;
      });

      const clip = getComputedStyle(el).clipPath;
      // (a) bare `none` を弾く（reduced-motion 等で素通しされた経路の保険）。
      expect(clip).toMatch(/^inset\(/);
      // (b) 全 offset が厳密に負 = clip が border-box の外側 → box-shadow 非クリップ。
      //     バグ値 `none` は settled で `inset(0px 0% 0px 0px)` → offset 0 で fail。
      const offsets = insetOffsets(clip);
      expect(offsets.length).toBeGreaterThan(0);
      for (const off of offsets) {
        expect(
          off,
          `region=${region}: clip "${clip}" must clip outside the border-box (every inset offset < 0)`,
        ).toBeLessThan(0);
      }
    },
  );
});
