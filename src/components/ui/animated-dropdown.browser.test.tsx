/**
 * 実 Chromium で動かす AnimatedDropdown(anchored モード)の stacking-context
 * 脱出テスト。
 *
 * Beat ブロックのケバブ等のドロップダウンは `.glass-editor-body` の
 * `backdrop-filter` が作る stacking context / containing block に閉じ込められ、
 * 後から描画される DockView パネルに覆われて「見えなくなる」回帰が起きていた。
 * happy-dom は `backdrop-filter` の stacking context も `getBoundingClientRect()`
 * の実寸も `elementFromPoint()` のヒットテストも再現しないため、この系統は実
 * ブラウザでしか捕まらない。
 *
 * anchored モード(anchorRef 指定)は `document.body` へ portal し `position: fixed`
 * で配置することで祖先 context を脱出する。それを以下で恒久 gate する:
 *   1. メニュー本体が backdrop-filter 祖先の DOM 外(= document.body 直下)に出る
 *   2. position: fixed で配置される
 *   3. 同領域を覆う後発パネルより前面に出る(elementFromPoint がメニューを返す)
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { AnimatedDropdown } from "./animated-dropdown";

afterEach(() => cleanup());

/**
 * backdrop-filter 祖先 + トリガ + anchored ドロップダウン、そしてドロップダウンの
 * 出現領域を覆う後発パネル(z-50)を 1 つの app-root(z:0)配下に置く。
 * 旧 absolute 実装ではドロップダウンが祖先 context に閉じ込められパネルに覆われる。
 */
function Harness() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-testid="app-root"
      style={{ position: "relative", zIndex: 0, width: 600, height: 400 }}
    >
      {/* backdrop-filter が stacking context + containing block を作る祖先 */}
      <div
        data-testid="glass-ancestor"
        style={{
          position: "relative",
          backdropFilter: "blur(8px)",
          // overflow も旧実装では物理クリップの一因だった。
          overflow: "hidden",
          width: 300,
          height: 200,
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          style={{
            position: "absolute",
            top: 40,
            left: 40,
            width: 60,
            height: 20,
          }}
        >
          trigger
        </button>
        <AnimatedDropdown
          open
          onClose={() => {}}
          anchorRef={triggerRef}
          placement="bottom-start"
          className="z-[100]"
        >
          <div
            data-testid="menu-body"
            style={{ width: 200, height: 100, background: "#fff" }}
          >
            menu
          </div>
        </AnimatedDropdown>
      </div>
      {/* ドロップダウン出現領域(トリガ直下)を覆う後発パネル。旧実装ならこれが
          ドロップダウンを隠す。 */}
      <div
        data-testid="covering-panel"
        style={{
          position: "fixed",
          top: 50,
          left: 20,
          width: 280,
          height: 160,
          background: "#000",
          zIndex: 50,
        }}
      />
    </div>
  );
}

describe("AnimatedDropdown anchored mode — glass stacking-context escape", () => {
  it("portals the menu out of the backdrop-filter ancestor into document.body", async () => {
    const { getByTestId } = render(<Harness />);
    const menu = await waitFor(() => getByTestId("menu-body"));
    const glassAncestor = getByTestId("glass-ancestor");

    // メニューは祖先 DOM の外(= portal 先 document.body 配下)にある。
    expect(glassAncestor.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
  });

  it("positions the menu with position: fixed anchored below the trigger", async () => {
    const { getByTestId } = render(<Harness />);
    const menu = await waitFor(() => getByTestId("menu-body"));
    // portal される motion.div(メニュー本体の親)が fixed。
    const positioned = menu.parentElement as HTMLElement;
    expect(getComputedStyle(positioned).position).toBe("fixed");

    await waitFor(() => {
      const r = menu.getBoundingClientRect();
      // 実寸を持ち、トリガ(top≈60 の直下)付近に配置される。
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      expect(r.top).toBeGreaterThan(55);
    });
  });

  it("clamps non-function children to viewport height with internal scroll", async () => {
    // 素の JSX children(タイプ/POV/ケバブ等)は内部スクロールを持たないため、
    // anchored モードで maxHeight クランプ + overflow-y-auto を適用しないと、
    // 項目数が多いメニューが画面外に溢れて押せなくなる(レビュー指摘の回帰)。
    const { getByTestId } = render(<Harness />);
    const menu = await waitFor(() => getByTestId("menu-body"));
    const positioned = menu.parentElement as HTMLElement;
    await waitFor(() => {
      expect(getComputedStyle(positioned).overflowY).toBe("auto");
      // ビューポート可用高さ(px)が inline style に乗っている。
      expect(positioned.style.maxHeight).toMatch(/px$/);
    });
  });

  it("renders in front of a later-painted panel covering the same region", async () => {
    const { getByTestId } = render(<Harness />);
    const menu = await waitFor(() => getByTestId("menu-body"));

    await waitFor(() => {
      const r = menu.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      // 覆っているパネルではなく、メニュー(またはその子孫)が前面に出ている。
      expect(menu.contains(hit) || hit === menu).toBe(true);
    });
  });
});
