/**
 * 傍点（圏点）の CSS 契約（実 Chromium）。
 *
 * WebKitGTK でも native text-emphasis で描く。旧「vertical-rl スクローラ」
 * 構造では WebKitGTK の縦書き emphasis 描画が壊れており per-char 背景ドットの
 * フォールバックを使っていたが、スクローラ非縦書き化以降は native が正しく
 * 描画される（実機確認済み）ため撤去した。ここでは
 *  (a) data-engine=webkitgtk + 縦書きでも native の sesame が無効化されて
 *      いないこと（フォールバック時代の text-emphasis:none の再導入 gate）
 *  (b) 撤去したフォールバック用スタイル (.emphasis-dot-char) が残骸として
 *      効いていないこと
 * を gate する。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

function Fixture() {
  return (
    <div className="editor-vertical" style={{ height: 400, fontSize: 20 }}>
      <div className="tiptap">
        <p>
          前
          <span data-testid="mark-span" className="emphasis-dots">
            強調
          </span>
          後
        </p>
      </div>
    </div>
  );
}

describe("傍点の native text-emphasis 契約", () => {
  afterEach(() => {
    delete document.documentElement.dataset.engine;
    cleanup();
  });

  it.each(["webkitgtk", null])(
    "data-engine=%s でも native sesame が有効なまま",
    (engine) => {
      if (engine) document.documentElement.dataset.engine = engine;
      render(<Fixture />);
      const markSpan = document.querySelector(
        "[data-testid='mark-span']",
      ) as HTMLElement;
      const cs = getComputedStyle(markSpan);
      expect(cs.textEmphasisStyle).toBe("sesame");
      expect(cs.textEmphasisPosition).toContain("over");
      // フォールバック残骸（背景ドット・padding）が効いていない
      expect(cs.backgroundImage).toBe("none");
      expect(cs.paddingRight).toBe("0px");
    },
  );
});
