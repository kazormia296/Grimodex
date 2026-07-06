/**
 * 本文レイヤーのチャネル CSS 解決（実 Chromium）。
 * Editorパネル Refine (1e→2b) の契約:
 * - 点線 = コメント族: 自分のコメント=琥珀 / 読者コメント=菫（pseudo_comment）
 * - 波線 = 校閲の指摘: 校閲アノテーションも Lint も同じ重要度色
 *   (error/warning/info、suggestion=info)
 * - .dark でチャネル色が暗背景向けに差し替わる
 * - 段落ガター記号は横書きで段落のインライン開始側（左）、縦書きで
 *   段落頭の上部余白に回る（論理プロパティの物理マップ）
 * happy-dom は text-decoration の computed 解決も論理プロパティの
 * 物理マップも行わないため、ここで gate する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { CommentMark } from "./CommentMark";
import { createGutterMarksPlugin } from "./GutterMarksPlugin";
import { useCursorSettingsStore } from "./cursorSettingsStore";

// --deco-* トークンの期待値 (index.css)
const LIGHT = {
  comment: "rgb(217, 154, 38)", // #d99a26
  readerComment: "rgb(139, 92, 246)", // #8b5cf6
  foreshadowSetup: "rgb(91, 111, 216)", // #5b6fd8
  issueError: "rgb(239, 68, 68)", // #ef4444
  issueWarning: "rgb(217, 141, 31)", // #d98d1f
  issueInfo: "rgb(59, 130, 246)", // #3b82f6
};
const DARK_COMMENT = "rgb(227, 176, 74)"; // #e3b04a

describe("本文レイヤーチャネルの CSS 解決", () => {
  it("コメント=点線 / 校閲・Lint=重要度色の波線 に解決され、同じ severity は同色になる", () => {
    render(
      <div className="tiptap">
        <p>
          <span className="comment-deco" data-testid="deco-comment">
            コメント
          </span>
          <span
            className="pe-annotation pe-annotation-severity-warning"
            data-testid="deco-review"
          >
            校閲
          </span>
          <span
            className="lint-deco lint-deco--warning"
            data-testid="deco-lint"
          >
            リント
          </span>
        </p>
      </div>,
    );
    const comment = getComputedStyle(
      document.querySelector("[data-testid='deco-comment']")!,
    );
    const review = getComputedStyle(
      document.querySelector("[data-testid='deco-review']")!,
    );
    const lint = getComputedStyle(
      document.querySelector("[data-testid='deco-lint']")!,
    );

    expect(comment.textDecorationStyle).toBe("dotted");
    expect(comment.textDecorationColor).toBe(LIGHT.comment);

    expect(review.textDecorationStyle).toBe("wavy");
    expect(review.textDecorationColor).toBe(LIGHT.issueWarning);

    expect(lint.textDecorationStyle).toBe("wavy");
    expect(lint.textDecorationColor).toBe(LIGHT.issueWarning);

    // 統合契約: 同じ severity なら校閲と Lint は同色（ソースで色を分けない）
    expect(review.textDecorationColor).toBe(lint.textDecorationColor);
    expect(comment.textDecorationStyle).not.toBe(review.textDecorationStyle);
  });

  it("校閲は severity で色分けされる (error=赤 / warning=橙 / suggestion・info=青)", () => {
    render(
      <div className="tiptap">
        <p>
          {(["error", "warning", "suggestion", "info"] as const).map((sev) => (
            <span
              key={sev}
              className={`pe-annotation pe-annotation-severity-${sev}`}
              data-testid={`pe-${sev}`}
            >
              {sev}
            </span>
          ))}
        </p>
      </div>,
    );
    const colorOf = (sev: string) =>
      getComputedStyle(document.querySelector(`[data-testid='pe-${sev}']`)!)
        .textDecorationColor;
    expect(colorOf("error")).toBe(LIGHT.issueError);
    expect(colorOf("warning")).toBe(LIGHT.issueWarning);
    expect(colorOf("suggestion")).toBe(LIGHT.issueInfo);
    expect(colorOf("info")).toBe(LIGHT.issueInfo);
  });

  it("pseudo_comment (読者コメント) は菫色の点線下線で、背景ハイライトを持たない", () => {
    render(
      <div className="tiptap">
        <p>
          <span
            className="pe-annotation pe-annotation-severity-info pe-annotation-pseudo_comment"
            data-testid="pe-pseudo"
          >
            読者コメント
          </span>
        </p>
      </div>,
    );
    const cs = getComputedStyle(
      document.querySelector("[data-testid='pe-pseudo']")!,
    );
    expect(cs.textDecorationStyle).toBe("dotted");
    expect(cs.textDecorationColor).toBe(LIGHT.readerComment);
    // 帰属ハイライト (面) と混同しない: 背景は透明のまま
    expect(cs.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("伏線は破線で、data-show-foreshadow-marks ゲートが効く", () => {
    render(
      <div>
        <div data-show-foreshadow-marks="true">
          <p>
            <span data-foreshadow-setup data-testid="fs-on">
              ふり
            </span>
            <span data-foreshadow-payoff data-testid="fs-payoff">
              回収
            </span>
          </p>
        </div>
        <div data-show-foreshadow-marks="false">
          <p>
            <span data-foreshadow-setup data-testid="fs-off">
              ふり
            </span>
          </p>
        </div>
      </div>,
    );
    const on = getComputedStyle(
      document.querySelector("[data-testid='fs-on']")!,
    );
    expect(on.textDecorationStyle).toBe("dashed");
    expect(on.textDecorationColor).toBe(LIGHT.foreshadowSetup);
    const payoff = getComputedStyle(
      document.querySelector("[data-testid='fs-payoff']")!,
    );
    expect(payoff.textDecorationStyle).toBe("dashed");
    expect(payoff.textDecorationColor).not.toBe(on.textDecorationColor);
    const off = getComputedStyle(
      document.querySelector("[data-testid='fs-off']")!,
    );
    expect(off.textDecorationLine).toBe("none");
  });

  it(".dark でチャネル色が暗背景向けに切り替わる", () => {
    render(
      <div className="dark">
        <p>
          <span className="comment-deco" data-testid="deco-comment-dark">
            コメント
          </span>
        </p>
      </div>,
    );
    const cs = getComputedStyle(
      document.querySelector("[data-testid='deco-comment-dark']")!,
    );
    expect(cs.textDecorationColor).toBe(DARK_COMMENT);
  });
});

// ── 段落ガター記号の幾何 ─────────────────────────────────────

const gutterTestExtension = Extension.create({
  name: "gutterTest",
  addProseMirrorPlugins() {
    return [createGutterMarksPlugin()];
  },
});

const COMMENTED_DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "コメントの付いた段落テキスト。",
          marks: [{ type: "comment", attrs: { text: "めも" } }],
        },
      ],
    },
  ],
};

function mountEditor(vertical: boolean): { el: HTMLElement; editor: Editor } {
  const el = document.createElement("div");
  el.className = vertical ? "editor-vertical" : "";
  el.style.cssText = "width:500px;height:400px;padding:48px;overflow:auto";
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, CommentMark, gutterTestExtension],
    content: COMMENTED_DOC,
  });
  return { el, editor };
}

describe("段落ガター記号の幾何", () => {
  beforeEach(() => {
    useCursorSettingsStore.setState({ showComments: true });
  });

  it("横書き: ガター行が段落テキストのインライン開始側（左）に出る", async () => {
    const { el, editor } = mountEditor(false);
    try {
      const row = await waitFor(() => {
        const r = el.querySelector(".gutter-marks__row") as HTMLElement | null;
        expect(r).toBeTruthy();
        return r!;
      });
      expect(row.querySelectorAll(".gutter-mark")).toHaveLength(1);
      const p = el.querySelector(".tiptap p") as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const pRect = p.getBoundingClientRect();
      expect(rowRect.width).toBeGreaterThan(0);
      expect(rowRect.height).toBeGreaterThan(0);
      // 段落の左（インライン開始）マージンに収まる
      expect(rowRect.right).toBeLessThanOrEqual(pRect.left + 1);
    } finally {
      editor.destroy();
      el.remove();
    }
  });

  it("縦書き: ガター行が段落頭の上部余白に回る", async () => {
    const { el, editor } = mountEditor(true);
    try {
      const row = await waitFor(() => {
        const r = el.querySelector(".gutter-marks__row") as HTMLElement | null;
        expect(r).toBeTruthy();
        return r!;
      });
      const p = el.querySelector(".tiptap p") as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const pRect = p.getBoundingClientRect();
      expect(rowRect.height).toBeGreaterThan(0);
      // 縦書きのインライン開始 = 上端 → 段落より上に出る
      expect(rowRect.bottom).toBeLessThanOrEqual(pRect.top + 1);
    } finally {
      editor.destroy();
      el.remove();
    }
  });

  it("レイヤーOFFではガターが出ない", async () => {
    useCursorSettingsStore.setState({ showComments: false });
    const { el, editor } = mountEditor(false);
    try {
      await waitFor(() => {
        expect(el.querySelector(".tiptap p")).toBeTruthy();
      });
      expect(el.querySelector(".gutter-marks")).toBeNull();
    } finally {
      editor.destroy();
      el.remove();
    }
  });

  it("狭幅: editor-gutter-reserve が張り出し分を予約しアイコンがクリップされない", async () => {
    // 予約なしの対照: 狭いコンテナ (padding なし) ではガター行が左へはみ出す
    const bare = document.createElement("div");
    bare.style.cssText = "width:300px;height:200px;overflow:auto";
    document.body.appendChild(bare);
    const bareEditor = new Editor({
      element: bare,
      extensions: [StarterKit, CommentMark, gutterTestExtension],
      content: COMMENTED_DOC,
    });
    try {
      const row = await waitFor(() => {
        const r = bare.querySelector(".gutter-marks__row") as HTMLElement;
        expect(r).toBeTruthy();
        return r;
      });
      expect(row.getBoundingClientRect().left).toBeLessThan(
        bare.getBoundingClientRect().left,
      );
    } finally {
      bareEditor.destroy();
      bare.remove();
    }

    // 予約あり: --gutter-reserve の padding-inline-start でコンテナ内に収まる
    const el = document.createElement("div");
    el.className = "editor-gutter-reserve";
    el.style.cssText = "width:300px;height:200px;overflow:auto";
    el.style.setProperty("--gutter-reserve", "calc(14px + 0.6em)");
    document.body.appendChild(el);
    const editor = new Editor({
      element: el,
      extensions: [StarterKit, CommentMark, gutterTestExtension],
      content: COMMENTED_DOC,
    });
    try {
      const row = await waitFor(() => {
        const r = el.querySelector(".gutter-marks__row") as HTMLElement;
        expect(r).toBeTruthy();
        return r;
      });
      const rowRect = row.getBoundingClientRect();
      expect(rowRect.width).toBeGreaterThan(0);
      expect(rowRect.left).toBeGreaterThanOrEqual(
        el.getBoundingClientRect().left,
      );
    } finally {
      editor.destroy();
      el.remove();
    }
  });
});
