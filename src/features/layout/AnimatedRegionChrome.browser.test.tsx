/**
 * 実 Chromium で AnimatedRegionChrome（リージョンの引き出し）を gate する。
 *
 * - 開くとき: カードが stripe 側から滑り出し、動いている間だけ外側の窓に
 *   clip-path が掛かる。動き終えたら clip-path も transform も残さない
 *   （settled 状態の clip-path は Backdrop Root になり、配下の Glass が背後の
 *   ambient shader を blur できない）。
 * - 閉じるとき: 直前の寸法のまま absolute で重ね、stripe へ滑り込ませてから外す。
 *   panel が別の場所へ移ったなら、動かさずにすぐ外す（二重 mount を避ける）。
 *
 * happy-dom は transform の補間と ResizeObserver の実寸を再現しないため browser
 * test 必須。mount-open では `<AnimatePresence initial={false}>` が enter を抑制
 * するので、closed→open の toggle 経路で検証する。
 */
import { beforeEach, describe, it, expect } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { REGION_DRAWER, type RegionChromeId } from "./layoutAnimation";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";
import { useSettingsStore } from "@/features/settings/settingsStore";

const REGIONS = Object.keys(REGION_DRAWER) as RegionChromeId[];

function chromeOf(container: HTMLElement, region: RegionChromeId = "left") {
  return container.querySelector<HTMLElement>(
    `[data-animated-region="${region}"]`,
  );
}

function cardOf(container: HTMLElement, region: RegionChromeId = "left") {
  return (chromeOf(container, region)?.firstElementChild ??
    null) as HTMLElement | null;
}

function translateOf(el: HTMLElement): { x: number; y: number } {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

function expectSettled(container: HTMLElement, region: RegionChromeId) {
  const chrome = chromeOf(container, region);
  const card = cardOf(container, region);
  if (!chrome || !card) throw new Error("region chrome not mounted");
  const cs = getComputedStyle(chrome);
  const cardTransform = getComputedStyle(card).transform;
  if (
    cs.clipPath !== "none" ||
    cs.opacity !== "1" ||
    cardTransform !== "none"
  ) {
    throw new Error(
      `not settled: clip=${cs.clipPath} opacity=${cs.opacity} transform=${cardTransform}`,
    );
  }
}

/** 寸法を持つ親。0 寸法だと引き出す距離が 0 になり動かない。 */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "relative", width: 300, height: 200 }}>
      {children}
    </div>
  );
}

function setLeftSlot(panels: ToolWindowPanelId[], active: boolean) {
  useLayoutStore.setState((state) => ({
    layout: {
      ...state.layout,
      regions: {
        ...state.layout.regions,
        left: {
          ...state.layout.regions.left,
          slots: [
            {
              id: "test-slot",
              sizeRatio: 1,
              panels,
              activePanel: active ? (panels[0] ?? null) : null,
            },
          ],
        },
      },
    },
  }));
}

describe("AnimatedRegionChrome drawer", () => {
  beforeEach(() => {
    useLayoutStore.setState({ initialized: true });
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "false" },
    }));
  });

  it("shows startup hydration at its final position without an enter animation", () => {
    useLayoutStore.setState({ initialized: false });
    const child = <div>child</div>;
    const view = (open: boolean) => (
      <Frame>
        <AnimatedRegionChrome region="left" open={open}>
          {child}
        </AnimatedRegionChrome>
      </Frame>
    );
    const { rerender, container } = render(view(false));

    act(() => {
      useLayoutStore.setState({ initialized: true });
      rerender(view(true));
    });

    expect(chromeOf(container)).not.toBeNull();
    expectSettled(container, "left");
  });

  it("restores the slide after startup hydration on the same StrictMode instance", async () => {
    useLayoutStore.setState({ initialized: false });
    const child = <div>child</div>;
    const view = (open: boolean) => (
      <StrictMode>
        <Frame>
          <AnimatedRegionChrome region="left" open={open}>
            {child}
          </AnimatedRegionChrome>
        </Frame>
      </StrictMode>
    );
    const { rerender, container } = render(view(false));

    act(() => {
      useLayoutStore.setState({ initialized: true });
      rerender(view(true));
    });
    expectSettled(container, "left");

    rerender(view(false));
    await waitFor(() => {
      expect(chromeOf(container)).toBeNull();
    });

    rerender(view(true));
    const card = cardOf(container);
    expect(card).not.toBeNull();
    // 開き始めは stripe 側（左）に引いた位置にいて、窓が掛かっている。
    expect(translateOf(card!).x).toBeLessThan(0);
    expect(getComputedStyle(chromeOf(container)!).clipPath).not.toBe("none");
    await waitFor(() => expectSettled(container, "left"));
  });

  it("leaves no clip-path or transform when app Reduced Motion skips the slide", async () => {
    useSettingsStore.setState((state) => ({
      cache: { ...state.cache, "display.reduceMotion": "true" },
    }));
    const child = <div>child</div>;
    const view = (open: boolean) => (
      <Frame>
        <AnimatedRegionChrome region="left" open={open}>
          {child}
        </AnimatedRegionChrome>
      </Frame>
    );
    const { rerender, container } = render(view(false));
    rerender(view(true));
    expectSettled(container, "left");

    // 閉じるのも即時。
    rerender(view(false));
    await waitFor(() => expect(chromeOf(container)).toBeNull(), {
      timeout: 100,
    });
  });

  it.each(REGIONS)(
    "removes the clip-path Backdrop Root and transform after the slide settles (region=%s)",
    async (region) => {
      const child = <div>child</div>;
      const view = (open: boolean) => (
        <Frame>
          <AnimatedRegionChrome region={region} open={open}>
            {child}
          </AnimatedRegionChrome>
        </Frame>
      );
      const { rerender, container } = render(view(false));
      rerender(view(true));

      const card = cardOf(container, region)!;
      const { x, y } = translateOf(card);
      const drawer = REGION_DRAWER[region];
      const moved = drawer.axis === "x" ? x : y;
      expect(Math.sign(moved)).toBe(drawer.sign);

      await waitFor(() => expectSettled(container, region));
    },
  );

  it("keeps the content while sliding closed, overlaid at its last size", async () => {
    setLeftSlot(["chat"], true);
    const view = (open: boolean) => (
      <Frame>
        <AnimatedRegionChrome region="left" open={open}>
          <div data-testid="content">child</div>
        </AnimatedRegionChrome>
      </Frame>
    );
    const { rerender, container, queryByTestId } = render(view(true));

    // 閉じただけ（chat は左の slot に残る）。
    act(() => {
      setLeftSlot(["chat"], false);
      rerender(view(false));
    });
    const chrome = chromeOf(container)!;
    expect(chrome).not.toBeNull();
    expect(chrome.dataset.exiting).toBe("true");
    expect(queryByTestId("content")).not.toBeNull();
    const cs = getComputedStyle(chrome);
    expect(cs.position).toBe("absolute");
    expect(parseFloat(cs.width)).toBe(300);
    expect(chrome.hasAttribute("inert")).toBe(true);

    await waitFor(() => {
      expect(translateOf(cardOf(container)!).x).toBeLessThan(-1);
    });
    await waitFor(() => expect(chromeOf(container)).toBeNull());
  });

  it("drops the content at once when its panel moved elsewhere", async () => {
    setLeftSlot(["chat"], true);
    const view = (open: boolean) => (
      <Frame>
        <AnimatedRegionChrome region="left" open={open}>
          <div>child</div>
        </AnimatedRegionChrome>
      </Frame>
    );
    const { rerender, container } = render(view(true));

    // chat が別のリージョンへ移り、左の slot から消えた。
    act(() => {
      setLeftSlot([], false);
      rerender(view(false));
    });
    await waitFor(() => expect(chromeOf(container)).toBeNull(), {
      timeout: 100,
    });
  });
});
