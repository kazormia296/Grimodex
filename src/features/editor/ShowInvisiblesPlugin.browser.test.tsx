/**
 * 空白・改行可視化の幾何 (実 Chromium)。
 * happy-dom は break-word 折り返し・position:relative inline の行ボックス
 * 生成を計算しないため、幻の改行・グリフ位置ずれは browser test で gate する。
 *
 * 重要: このスイートは **実際に同梱する本文フォント** (日本語=Noto Serif JP /
 * 英語=Literata) を読み込む。過去の回帰 (PR #301 系) は、テストがフォントを
 * ロードせず generic serif にフォールバックしていたため「テスト緑・日本語実機だけ
 * 空白マーク左寄り」を検出できなかった。空白マーク (·/□) はフォント由来グリフを
 * 使うと advance / ink がプラットフォーム依存になり横ずれするため、CSS 図形で
 * 描画する方式に変更した。ここではその図形が span (=文字間の隙間) の中央に
 * 対称配置されることを検証する。
 */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { createShowInvisiblesPlugin } from "./ShowInvisiblesPlugin";
import {
  buildEditorContentStyle,
  type EditorContentStyleSettings,
} from "./editorLayout";

// 実アプリが同梱する本文フォント (src/main.tsx と同じ import)。これが無いと
// Chromium は generic serif にフォールバックし、実機の Noto Serif JP / Literata
// とは別物のメトリクスで測ってしまう。
import "@fontsource/noto-serif-jp/japanese-400.css";
import "@fontsource/noto-serif-jp/latin-400.css";
import "@fontsource/literata/latin-400.css";

// 実アプリの言語別デフォルト (LANGUAGE_DEFAULT_OVERRIDES) に合わせる。
const JA_EDITOR_SETTINGS: EditorContentStyleSettings = {
  fontFamily: '"Noto Serif JP"',
  fontSize: 20,
  lineHeight: 2.0,
  maxContentWidth: 720,
  wordBreak: "normal",
  lineBreak: "strict",
  textAutospace: "normal",
  paragraphIndent: 0,
  paragraphSpacing: 8,
};

const EN_EDITOR_SETTINGS: EditorContentStyleSettings = {
  ...JA_EDITOR_SETTINGS,
  fontFamily: '"Literata"',
  lineHeight: 1.6,
  paragraphIndent: 1,
};

const EM = JA_EDITOR_SETTINGS.fontSize; // 1em in px

function gapCenterDelta(paragraph: HTMLElement, span: HTMLElement): number {
  const spanRect = span.getBoundingClientRect();
  const nodes = [...paragraph.childNodes];
  const idx = nodes.indexOf(span);
  const measureEdge = (node: ChildNode | undefined, end: boolean) => {
    if (!node) return null;
    const range = document.createRange();
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text.length) return null;
      const offset = end ? text.length : 0;
      range.setStart(node, Math.max(0, offset - (end ? 1 : 0)));
      range.setEnd(node, end ? text.length : Math.min(1, text.length));
    } else if (node instanceof HTMLElement) {
      range.selectNodeContents(node);
      if (end) range.collapse(false);
    } else {
      return null;
    }
    return range.getBoundingClientRect();
  };
  const prevRect = measureEdge(nodes[idx - 1], true);
  const nextRect = measureEdge(nodes[idx + 1], false);
  if (!prevRect || !nextRect) return 0;
  const gapCenter = (prevRect.right + nextRect.left) / 2;
  const spanCenter = spanRect.left + spanRect.width / 2;
  return spanCenter - gapCenter;
}

/**
 * マーク (::before 図形) のメトリクス。図形は inset+margin:auto で span
 * ボックスに対称配置されるので、
 *  - marginLeft ≈ marginRight  → 図形が span 内で水平中央
 *  - marginTop  ≈ marginBottom → 図形が span 内で垂直中央
 * を満たすはず。transform を使わないので getComputedStyle がそのまま使える。
 */
function markMetrics(span: HTMLElement) {
  const b = getComputedStyle(span, "::before");
  const num = (v: string) => Number.parseFloat(v) || 0;
  return {
    content: b.content,
    width: num(b.width),
    height: num(b.height),
    marginLeft: num(b.marginLeft),
    marginRight: num(b.marginRight),
    marginTop: num(b.marginTop),
    marginBottom: num(b.marginBottom),
    backgroundColor: b.backgroundColor,
    borderTopWidth: num(b.borderTopWidth),
    borderRadius: b.borderTopLeftRadius,
    hMarginSkew: Math.abs(num(b.marginLeft) - num(b.marginRight)),
    vMarginSkew: Math.abs(num(b.marginTop) - num(b.marginBottom)),
  };
}

const invisiblesExtension = Extension.create({
  name: "invisiblesTest",
  addProseMirrorPlugins() {
    return [createShowInvisiblesPlugin()];
  },
});

interface MountOptions {
  withPlugin?: boolean;
  vertical?: boolean;
  english?: boolean;
}

function mount(
  content: unknown,
  options: MountOptions & {
    editorSettings?: EditorContentStyleSettings;
  } = {},
): { el: HTMLElement; editor: Editor } {
  const {
    withPlugin = true,
    vertical = false,
    english = false,
    editorSettings = JA_EDITOR_SETTINGS,
  } = options;
  const wrapper = document.createElement("div");
  wrapper.className = [
    "editor-show-invisibles",
    vertical ? "editor-vertical" : "",
    // 実アプリでは英語プロジェクトのみ付く (EditorContentArea.tsx)。
    english ? "editor-en-typography" : "",
  ]
    .filter(Boolean)
    .join(" ");
  Object.assign(wrapper.style, {
    width: vertical ? "500px" : "320px",
    height: vertical ? "400px" : undefined,
    padding: vertical ? "48px" : "24px",
    overflow: vertical ? "auto" : undefined,
    ...buildEditorContentStyle(editorSettings),
  });
  document.body.appendChild(wrapper);

  const mountEl = document.createElement("div");
  wrapper.appendChild(mountEl);

  const extensions = [StarterKit];
  if (withPlugin) extensions.push(invisiblesExtension);

  const editor = new Editor({
    element: mountEl,
    extensions,
    content: content as never,
  });
  return { el: wrapper, editor };
}

function longWordDoc(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function para(text: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

const LONG_WORD = "あ".repeat(40);

describe("空白・改行可視化の幾何", () => {
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    // 実フォントを実際にフェッチ・パースさせてから測る (fallback serif で
    // 測ると実機と別メトリクスになり、この回帰を素通しする)。
    await Promise.allSettled([
      document.fonts.load(`400 ${EM}px "Noto Serif JP"`, "あい　 "),
      document.fonts.load(`400 ${EM}px "Literata"`, "ab "),
    ]);
    await document.fonts.ready;
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("実フォント (Noto Serif JP / Literata) が実際にロードされている", () => {
    // この前提が崩れると以下のマーク幾何テストは実機を反映しなくなる。
    expect(document.fonts.check(`${EM}px "Noto Serif JP"`)).toBe(true);
    expect(document.fonts.check(`${EM}px "Literata"`)).toBe(true);
  });

  it("空白マーク有り段落が素の段落より高くならない（幻の改行なし）", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: `${LONG_WORD} ${LONG_WORD}` }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: `${LONG_WORD}${LONG_WORD}` }],
        },
      ],
    };
    const { el, editor } = mount(doc);
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withSpace = (ps[0] as HTMLElement).getBoundingClientRect();
    const plain = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(plain.height).toBeGreaterThan(30);
    expect(withSpace.height).toBeLessThanOrEqual(plain.height + 1);
  });

  it("段落末 ¶ が本文の次行に単独行として落ちない", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: LONG_WORD }],
        },
      ],
    };
    const withInvisibles = mount(doc, { withPlugin: true });
    const plain = mount(doc, { withPlugin: false });
    cleanups.push(() => {
      withInvisibles.editor.destroy();
      withInvisibles.el.remove();
      plain.editor.destroy();
      plain.el.remove();
    });

    const markedP = withInvisibles.el.querySelector(
      ".tiptap > p",
    ) as HTMLElement;
    const plainP = plain.el.querySelector(".tiptap > p") as HTMLElement;
    const markedRect = markedP.getBoundingClientRect();
    const plainRect = plainP.getBoundingClientRect();
    expect(plainRect.height).toBeGreaterThan(30);
    expect(markedRect.height).toBeLessThanOrEqual(plainRect.height + 1);
    expect(withInvisibles.el.querySelector(".pm-ws-para-end")).toBeTruthy();
  });

  it("hardBreak 前の ↵ ウィジェットが余分な行を生まない", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "一行目" },
            { type: "hardBreak" },
            { type: "text", text: "二行目" },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "一行目" },
            { type: "hardBreak" },
            { type: "text", text: "二行目" },
          ],
        },
      ],
    };
    const { el, editor } = mount(doc);
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withPlugin = (ps[0] as HTMLElement).getBoundingClientRect();
    const plain = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(withPlugin.height).toBeLessThanOrEqual(plain.height + 1);
  });

  it("日本語: 全角空白マーク □ が span (=文字間) の中央に対称配置される", () => {
    const { el, editor } = mount(para("あ　い"), {
      editorSettings: JA_EDITOR_SETTINGS,
    });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const span = el.querySelector(".pm-ws-ideographic") as HTMLElement;
    expect(span).toBeTruthy();
    const p = el.querySelector(".tiptap > p") as HTMLElement;
    const spanRect = span.getBoundingClientRect();
    const m = markMetrics(span);
    console.warn(
      "[invisibles:ja-ideographic]",
      JSON.stringify({
        gapDelta: gapCenterDelta(p, span),
        spanW: spanRect.width,
        m,
      }),
    );

    // 全角空白セル ≈ 1em。
    expect(spanRect.width).toBeGreaterThan(EM * 0.7);
    expect(spanRect.width).toBeLessThan(EM * 1.3);
    // マークはフォントグリフではなく CSS 図形 (content 空・border ありの中空四角)。
    expect(m.content === '""' || m.content === "" || m.content === "none").toBe(
      true,
    );
    expect(m.borderTopWidth).toBeGreaterThan(0);
    // 図形サイズはフォント非依存 (0.5em)。glyph 方式の advance ばらつき
    // (Linux 0.6em / Windows 2em) を排除したことの gate。
    expect(m.width + m.borderTopWidth * 2).toBeGreaterThan(EM * 0.4);
    expect(m.width + m.borderTopWidth * 2).toBeLessThan(EM * 0.65);
    // span 内で水平・垂直とも中央 (対称マージン)。
    expect(m.hMarginSkew).toBeLessThan(0.6);
    expect(m.vMarginSkew).toBeLessThan(1.5);
    // span 自体が文字間の隙間中央にいる。両方満たせば「隙間の中央」に見える。
    expect(Math.abs(gapCenterDelta(p, span))).toBeLessThan(2);
  });

  it("日本語: 半角空白マーク · が span の中央に対称配置される", () => {
    const { el, editor } = mount(para("あ い"), {
      editorSettings: JA_EDITOR_SETTINGS,
    });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const span = el.querySelector(".pm-ws-space") as HTMLElement;
    expect(span).toBeTruthy();
    const p = el.querySelector(".tiptap > p") as HTMLElement;
    const spanRect = span.getBoundingClientRect();
    const m = markMetrics(span);
    console.warn(
      "[invisibles:ja-space]",
      JSON.stringify({
        gapDelta: gapCenterDelta(p, span),
        spanW: spanRect.width,
        m,
      }),
    );

    expect(spanRect.width).toBeGreaterThan(0);
    expect(spanRect.width).toBeLessThan(EM);
    // 中黒相当のドット (背景色あり・content 空・角丸)。
    expect(m.content === '""' || m.content === "" || m.content === "none").toBe(
      true,
    );
    expect(m.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(m.backgroundColor).not.toBe("transparent");
    expect(m.width).toBeGreaterThan(0);
    expect(m.width).toBeLessThan(EM * 0.4);
    // 幅≈高さ (ドット)。
    expect(Math.abs(m.width - m.height)).toBeLessThan(1);
    // span 内で対称中央。span 幅が狭くてもマージン対称なら中央。
    expect(m.hMarginSkew).toBeLessThan(0.6);
    expect(m.vMarginSkew).toBeLessThan(1.5);
    expect(Math.abs(gapCenterDelta(p, span))).toBeLessThan(2);
  });

  it("英語 (control): 半角空白マーク · も span 中央に対称配置される", () => {
    const { el, editor } = mount(para("a b"), {
      editorSettings: EN_EDITOR_SETTINGS,
      english: true,
    });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const span = el.querySelector(".pm-ws-space") as HTMLElement;
    expect(span).toBeTruthy();
    const p = el.querySelector(".tiptap > p") as HTMLElement;
    const m = markMetrics(span);
    console.warn(
      "[invisibles:en-space]",
      JSON.stringify({ gapDelta: gapCenterDelta(p, span), m }),
    );
    expect(m.hMarginSkew).toBeLessThan(0.6);
    expect(m.vMarginSkew).toBeLessThan(1.5);
    expect(Math.abs(gapCenterDelta(p, span))).toBeLessThan(2);
  });

  it("縦書き: 段落末 ¶ が幻の改行(余分な列)を作らない", () => {
    const doc = longWordDoc(LONG_WORD);
    const withInvisibles = mount(doc, { withPlugin: true, vertical: true });
    const plain = mount(doc, { withPlugin: false, vertical: true });
    cleanups.push(() => {
      withInvisibles.editor.destroy();
      withInvisibles.el.remove();
      plain.editor.destroy();
      plain.el.remove();
    });

    const markedP = withInvisibles.el.querySelector(
      ".tiptap > p",
    ) as HTMLElement;
    const plainP = plain.el.querySelector(".tiptap > p") as HTMLElement;
    const markedRect = markedP.getBoundingClientRect();
    const plainRect = plainP.getBoundingClientRect();
    expect(plainRect.width).toBeGreaterThan(30);
    expect(markedRect.width).toBeLessThanOrEqual(plainRect.width + 1);
    expect(withInvisibles.el.querySelector(".pm-ws-para-end")).toBeTruthy();
  });

  it("縦書き: 空白マークが幻の改行(余分な列)を作らない", () => {
    const spaced = longWordDoc(`${LONG_WORD} ${LONG_WORD}`);
    const plain = longWordDoc(`${LONG_WORD}${LONG_WORD}`);
    const doc = {
      type: "doc",
      content: [...spaced.content, ...plain.content],
    };
    const { el, editor } = mount(doc, { vertical: true });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const ps = el.querySelectorAll(".tiptap > p");
    const withSpace = (ps[0] as HTMLElement).getBoundingClientRect();
    const noSpace = (ps[1] as HTMLElement).getBoundingClientRect();
    expect(noSpace.width).toBeGreaterThan(30);
    expect(withSpace.width).toBeLessThanOrEqual(noSpace.width + 1);
  });
});
