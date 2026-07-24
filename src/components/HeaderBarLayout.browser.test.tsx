/**
 * 実 Chromium で動かす HeaderBarLayout の幾何 invariant テスト。
 *
 * 回帰: ヘッダーのコマンドパレット (中央スロット) が**ウィンドウ中心からズレる**
 * バグ。旧実装は「中央だけ flex-1 + justify-center」で、左右ボタン群の*あいだ*
 * の余白の中央にバーを置いていた。左群 (ロゴ+メニュー+履歴+エクスポート) は右群
 * より広いため、バーの中心がウィンドウ中心から右へズレていた。
 *
 * happy-dom は flex の実寸を計算しないため、`getBoundingClientRect()` で中央
 * スロットの中心がヘッダー中心と一致することを実ブラウザで assert して gate する。
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HeaderBarLayout } from "./HeaderBarLayout";

const HOST_WIDTH = 1200;
const HOST_HEIGHT = 48;

/**
 * 左右で**幅が大きく非対称**な中身を入れて描画する。これが回帰の核心条件:
 * 旧実装ではこの非対称ぶんだけ中央がズレた。新実装 (左右レール flex-1 basis-0)
 * では中身の幅に関係なく中央がウィンドウ中心に来るはず。
 */
function renderHeader(opts: { mac?: boolean; emptyCenter?: boolean } = {}) {
  return render(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: HOST_WIDTH,
        height: HOST_HEIGHT,
      }}
    >
      <HeaderBarLayout
        mac={opts.mac}
        left={
          // 広い左群 (480px, 縮まない) — 旧実装で中央を右へ押していた要素。
          <div
            data-test-left
            style={{ flex: "0 0 auto", width: 480, height: 24 }}
          />
        }
        center={
          opts.emptyCenter ? null : (
            <div data-test-center style={{ width: 200, height: 24 }} />
          )
        }
        right={
          // 狭い右群 (160px, 縮まない)。
          <div
            data-test-right
            style={{ flex: "0 0 auto", width: 160, height: 24 }}
          />
        }
      />
    </div>,
  );
}

async function nextFrame() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function centerX(el: Element): number {
  const r = el.getBoundingClientRect();
  return r.left + r.width / 2;
}

describe("HeaderBarLayout geometry invariants (real Chromium)", () => {
  it("centers the center slot at the header's geometric center despite unequal side widths", async () => {
    const { container } = renderHeader();
    await nextFrame();

    const header = container.querySelector<HTMLElement>("[data-header-bar]");
    const center = container.querySelector<HTMLElement>("[data-test-center]");
    expect(header).not.toBeNull();
    expect(center).not.toBeNull();

    // ヘッダーは host 幅いっぱい (1200) に広がっているはず。
    const headerRect = header!.getBoundingClientRect();
    expect(headerRect.width).toBeGreaterThan(HOST_WIDTH - 2);

    // 中央スロットの中心 = ヘッダーの中心。1px tolerance (subpixel rounding)。
    expect(Math.abs(centerX(center!) - centerX(header!))).toBeLessThan(1);
  });

  it("left and right rails have equal outer width (the property that guarantees centering)", async () => {
    const { container } = renderHeader();
    await nextFrame();

    const leftRail = container.querySelector<HTMLElement>(
      '[data-header-rail="left"]',
    );
    const rightRail = container.querySelector<HTMLElement>(
      '[data-header-rail="right"]',
    );
    expect(leftRail).not.toBeNull();
    expect(rightRail).not.toBeNull();

    const lw = leftRail!.getBoundingClientRect().width;
    const rw = rightRail!.getBoundingClientRect().width;
    expect(Math.abs(lw - rw)).toBeLessThan(1);
  });

  it("stays centered on macOS (symmetric traffic-light reservation, not a left-only shift)", async () => {
    const { container } = renderHeader({ mac: true });
    await nextFrame();

    const header = container.querySelector<HTMLElement>("[data-header-bar]");
    const center = container.querySelector<HTMLElement>("[data-test-center]");
    expect(header).not.toBeNull();
    expect(center).not.toBeNull();

    // mac の pl-20 を左レールだけに入れると中央が +40px ズレる。右レールの
    // pr-20 で対称化しているので、ここでも中心は一致しているはず。
    expect(Math.abs(centerX(center!) - centerX(header!))).toBeLessThan(1);
  });

  it("uses the vacant center rail as an Electron window drag region", async () => {
    document.documentElement.dataset.shell = "electron";
    const { container, unmount } = renderHeader({ emptyCenter: true });
    await nextFrame();

    const centerRail = container.querySelector<HTMLElement>(
      "[data-header-center]",
    );
    expect(centerRail).not.toBeNull();
    expect(centerRail).toBeEmptyDOMElement();
    expect(
      getComputedStyle(centerRail!).getPropertyValue("-webkit-app-region"),
    ).toBe("drag");

    unmount();
    delete document.documentElement.dataset.shell;
  });
});
