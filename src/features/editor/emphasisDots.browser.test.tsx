/**
 * 傍点（圏点）の WebKitGTK 縦書きフォールバックの CSS 契約（実 Chromium）。
 *
 * WebKitGTK 本体の「native text-emphasis が縦書きで半文字ズレ + 先頭マーク
 * 欠落」バグは Chromium では再現できないため、ここで gate するのは:
 *  (a) html[data-engine="webkitgtk"] × .editor-vertical でだけ native
 *      text-emphasis が none になりフォールバック背景が有効になること
 *      （二重描画の回帰防止）。
 *  (b) フォールバックが「span 背景 + ブロック軸 padding」方式であること —
 *      abspos ::after は WebKitGTK 縦書きの inline 包含ブロック paint ズレを
 *      踏むため使わない（ShowInvisibles と同じ技法 gate）。
 *  (c) ブロック軸 padding がレイアウト（字送り・列送り）に影響しないこと。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EmphasisDotsMark } from "./EmphasisDotsMark";
import { createEmphasisDotsFallbackPlugin } from "./EmphasisDotsFallbackPlugin";

const FONT_PX = 20;

function Fixture() {
  return (
    <div className="editor-vertical" style={{ height: 400, fontSize: FONT_PX }}>
      <div className="tiptap">
        <p data-testid="p-fallback">
          前
          <span data-testid="mark-span" className="emphasis-dots">
            <span data-testid="dot-char-1" className="emphasis-dot-char">
              強
            </span>
            <span className="emphasis-dot-char">調</span>
          </span>
          後
        </p>
        <p data-testid="p-plain">前強調後</p>
      </div>
    </div>
  );
}

describe("傍点フォールバック (WebKitGTK 縦書き)", () => {
  afterEach(() => {
    delete document.documentElement.dataset.engine;
    cleanup();
  });

  it("data-engine=webkitgtk: native 傍点を止め、背景方式のフォールバックが有効になる", () => {
    document.documentElement.dataset.engine = "webkitgtk";
    render(<Fixture />);
    const markSpan = document.querySelector(
      "[data-testid='mark-span']",
    ) as HTMLElement;
    const dotChar = document.querySelector(
      "[data-testid='dot-char-1']",
    ) as HTMLElement;

    // native text-emphasis 停止（フォールバックとの二重描画防止）
    expect(getComputedStyle(markSpan).textEmphasisStyle).toBe("none");

    const cs = getComputedStyle(dotChar);
    // 技法 gate: abspos 擬似要素ではなく span 背景で描く
    expect(getComputedStyle(dotChar, "::after").content).toBe("none");
    expect(cs.backgroundImage).toContain("radial-gradient");
    expect(cs.backgroundRepeat).toBe("no-repeat");
    // ドットの描画域はブロック軸 padding (物理 right = 列間) に確保する
    expect(cs.paddingRight).toBe(`${FONT_PX / 2}px`);
  });

  it("data-engine=webkitgtk: ブロック軸 padding は字送り・列送りに影響しない", () => {
    document.documentElement.dataset.engine = "webkitgtk";
    render(<Fixture />);
    const withFallback = (
      document.querySelector("[data-testid='p-fallback']") as HTMLElement
    ).getBoundingClientRect();
    const plain = (
      document.querySelector("[data-testid='p-plain']") as HTMLElement
    ).getBoundingClientRect();

    // 同じ4文字の段落 — 字送り (縦書きでは height) が一致する
    expect(plain.height).toBeGreaterThan(FONT_PX * 3);
    expect(Math.abs(withFallback.height - plain.height)).toBeLessThan(1);
    // 列送り (縦書きでは width = 列の太さ) も padding で膨らまない
    expect(Math.abs(withFallback.width - plain.width)).toBeLessThan(1);
  });

  it("data-engine なし (Chromium 等): native 傍点のままフォールバック背景は無効", () => {
    render(<Fixture />);
    const markSpan = document.querySelector(
      "[data-testid='mark-span']",
    ) as HTMLElement;
    const dotChar = document.querySelector(
      "[data-testid='dot-char-1']",
    ) as HTMLElement;

    expect(getComputedStyle(markSpan).textEmphasisStyle).not.toBe("none");
    const cs = getComputedStyle(dotChar);
    expect(cs.backgroundImage).toBe("none");
    expect(cs.paddingRight).toBe("0px");
  });

  it("dark テーマ: --emphasis-dot-ink が dark 用の色に切り替わる", () => {
    // .dark も data-engine も <html> 自身に付く — 子孫結合子で書くと
    // 絶対にマッチしない dead rule になるため、複合セレクタの適用を gate。
    document.documentElement.dataset.engine = "webkitgtk";
    document.documentElement.classList.add("dark");
    try {
      render(<Fixture />);
      const dotChar = document.querySelector(
        "[data-testid='dot-char-1']",
      ) as HTMLElement;
      const ink = getComputedStyle(dotChar)
        .getPropertyValue("--emphasis-dot-ink")
        .trim();
      expect(ink).toBe("oklch(0.7 0 0)");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("実 Editor + プラグインで .emphasis-dot-char span が DOM に現れる", async () => {
    // 静的 fixture では検出できない「プラグインのクラス名と CSS 側クラス名の
    // 結合」を実 Editor で gate する（typo リネームで両者が乖離すると
    // native 停止だけが残り傍点が完全に消える）。
    document.documentElement.dataset.engine = "webkitgtk";
    const host = document.createElement("div");
    host.className = "editor-vertical";
    const inner = document.createElement("div");
    host.appendChild(inner);
    document.body.appendChild(host);
    const editor = new Editor({
      element: inner,
      extensions: [StarterKit, EmphasisDotsMark],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "強調",
                marks: [{ type: "emphasisDots" }],
              },
            ],
          },
        ],
      },
    });
    try {
      editor.registerPlugin(createEmphasisDotsFallbackPlugin());
      await waitFor(() => {
        const chars = host.querySelectorAll(".emphasis-dot-char");
        expect(chars.length).toBe(2);
      });
      const char = host.querySelector(".emphasis-dot-char") as HTMLElement;
      // CSS 側とも結合している（背景ドットが実際に有効）
      expect(getComputedStyle(char).backgroundImage).toContain(
        "radial-gradient",
      );
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
