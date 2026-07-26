/**
 * 実 Chromium で AnimatedRegionChrome が enter 完了後に clip-path を残さない
 * ことを gate する。
 *
 * enter 中は `inset(...)` 同士を補間する必要がある。Motion は `inset(...)` と
 * `none` を直接補間すると `none` を `inset(0)` に置換し、region border-box で
 * panel shadow を切ってしまうため、アニメーション終端までは負の inset を使う。
 * 一方、settled 状態に clip-path が残ると Backdrop Root が常設され、配下の
 * backdrop-filter が region 外側の ambient shader を参照できない。したがって
 * enter 完了時だけ `none` に切り替えるのが守るべき不変条件。
 *
 * happy-dom は WAAPI 補間と transitionEnd を再現しないため browser test 必須。
 * また mount-open では `<AnimatePresence initial={false}>` が enter を抑制する
 * ので、closed→open の toggle 経路で検証する。
 */
import { beforeEach, describe, it, expect } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { REGION_CLIP_PATH, type RegionChromeId } from "./layoutAnimation";
import { useLayoutStore } from "./layoutStore";
import { useSettingsStore } from "@/features/settings/settingsStore";

const REGIONS = Object.keys(REGION_CLIP_PATH) as RegionChromeId[];

describe("AnimatedRegionChrome settled clip-path invariant", () => {
  beforeEach(() => {
    useLayoutStore.setState({ initialized: true });
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "false" },
    }));
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

  it("restores enter motion after startup hydration on the same StrictMode instance", async () => {
    useLayoutStore.setState({ initialized: false });
    const child = <div>child</div>;
    const view = (open: boolean) => (
      <StrictMode>
        <AnimatedRegionChrome region="left" open={open}>
          {child}
        </AnimatedRegionChrome>
      </StrictMode>
    );
    const { rerender, container } = render(view(false));

    act(() => {
      useLayoutStore.setState({ initialized: true });
      rerender(view(true));
    });
    const hydrated = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    );
    expect(hydrated).not.toBeNull();
    expect(getComputedStyle(hydrated!).opacity).toBe("1");

    rerender(view(false));
    await waitFor(() => {
      expect(
        container.querySelector('[data-animated-region="left"]'),
      ).toBeNull();
    });

    rerender(view(true));
    const reopened = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    );
    expect(reopened).not.toBeNull();
    expect(parseFloat(getComputedStyle(reopened!).opacity)).toBeLessThan(1);
    await waitFor(() => {
      expect(getComputedStyle(reopened!).opacity).toBe("1");
    });
  });

  it("leaves no clip-path when app Reduced Motion skips the enter animation", async () => {
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "true" },
    }));
    const child = <div>child</div>;
    const { rerender, container } = render(
      <AnimatedRegionChrome region="left" open={false}>
        {child}
      </AnimatedRegionChrome>,
    );

    rerender(
      <AnimatedRegionChrome region="left" open>
        {child}
      </AnimatedRegionChrome>,
    );

    const node = container.querySelector<HTMLElement>(
      '[data-animated-region="left"]',
    );
    expect(node).not.toBeNull();
    expect(getComputedStyle(node!).opacity).toBe("1");
    await waitFor(() => {
      expect(getComputedStyle(node!).clipPath).toBe("none");
    });
  });

  it.each(REGIONS)(
    "removes the clip-path Backdrop Root after enter settles (region=%s)",
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

      await waitFor(() => {
        const node = container.querySelector<HTMLElement>(
          "[data-animated-region]",
        );
        if (!node) throw new Error("region chrome not mounted");
        const cs = getComputedStyle(node);
        if (cs.opacity !== "1" || cs.clipPath !== "none") {
          throw new Error(
            `not settled: opacity=${cs.opacity} clip=${cs.clipPath}`,
          );
        }
      });
    },
  );
});
