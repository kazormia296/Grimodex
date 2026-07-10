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
 * 描画する方式に変更した。
 *
 * さらに図形は「abspos ::before」ではなく「span 自身の background / mask」で
 * 描く。WebKitGTK は縦書き (vertical-rl) で inline を包含ブロックとする abspos
 * の paint を leading 分ズラすバグを持ち、computed style は正常値のまま paint
 * だけズレるため Chromium 実行のこのスイートでは直接検出できない。よってここでは
 * (a) span が文字間の隙間の中央にいること、(b) WebKitGTK で壊れる技法
 * (inline+abspos) に依存していないこと (::before 非使用・background/mask 使用・
 * ↵/¶ アンカーの inline-block 化) を gate する。
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

/** gapCenterDelta の縦書き版 — 字送り軸が縦なので top/bottom で測る。
 *  測定不能 (隣接ノードの矩形が取れない) は 0 ではなく null を返す —
 *  0 は「中央一致」と同値になり vacuous pass を生むため。 */
function gapCenterDeltaVertical(
  paragraph: HTMLElement,
  span: HTMLElement,
): number | null {
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
  if (!prevRect || !nextRect) return null;
  const gapCenter = (prevRect.bottom + nextRect.top) / 2;
  const spanCenter = spanRect.top + spanRect.height / 2;
  return spanCenter - gapCenter;
}

/**
 * マークの描画スタイル。図形は span 自身の background / mask で描く
 * (background は span ボックス基準なので、box 中央配置がエンジン保証される)。
 * ::before が none であることは「WebKitGTK 縦書きで paint がズレる
 * inline+abspos 技法に戻っていない」ことの gate。
 */
function markStyle(span: HTMLElement) {
  const s = getComputedStyle(span);
  return {
    beforeContent: getComputedStyle(span, "::before").content,
    backgroundImage: s.backgroundImage,
    backgroundPosition: s.backgroundPosition,
    backgroundSize: s.backgroundSize,
    backgroundRepeat: s.backgroundRepeat,
    maskImage: s.maskImage || s.webkitMaskImage,
    maskPosition: s.maskPosition || s.webkitMaskPosition,
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
    const m = markStyle(span);
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
    // マークは span 背景の CSS 図形 (中空四角 = 4 本のストライプ)。
    // ::before が none = inline+abspos 技法に依存していない (WebKitGTK gate)。
    expect(m.beforeContent).toBe("none");
    expect(m.backgroundImage.match(/linear-gradient/g)?.length).toBe(4);
    // 色は --pm-ws-ink (muted-foreground 45%) が gradient へ焼き込まれる。
    // alpha 0 (不可視) への退行を gate — computed には `/ 0.45)` 形式で現れる。
    expect(m.backgroundImage).toMatch(/\/ 0\.45\)/);
    // 図形サイズはフォント非依存 (0.5em = EM/2)。glyph 方式の advance ばらつき
    // (Linux 0.6em / Windows 2em) を排除したことの gate。
    const sizes = m.backgroundSize.split(",").map((s) => s.trim());
    expect(sizes.length).toBe(4);
    expect(sizes[0]).toBe(`${EM / 2}px 1px`);
    expect(sizes[2]).toBe(`1px ${EM / 2}px`);
    // 4 本のストライプが上下左右の辺に配置される (中央へ潰れる退行を gate)。
    // EM=20px なので calc は px 決定的に解決される。
    expect(m.backgroundPosition).toBe(
      `50% calc(50% - ${EM / 4}px), 50% calc(50% + ${EM / 4}px), calc(50% - ${EM / 4}px) 50%, calc(50% + ${EM / 4}px) 50%`,
    );
    // background は span ボックス基準なので box 中央配置はエンジン保証。
    // span 自体が文字間の隙間中央にいれば「隙間の中央」に見える。
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
    const m = markStyle(span);
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
    // 中黒相当のドット = span 背景の radial-gradient。::before 非使用
    // (WebKitGTK 縦書き abspos paint バグ回避技法の gate)。
    expect(m.beforeContent).toBe("none");
    expect(m.backgroundImage).toContain("radial-gradient");
    // 色の alpha 0 (不可視) への退行を gate。
    expect(m.backgroundImage).toMatch(/\/ 0\.45\)/);
    // 物理 center は点対称図形なので縦書きでもそのまま成立する。
    expect(m.backgroundPosition).toBe("50% 50%");
    expect(m.backgroundRepeat).toBe("no-repeat");
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
    const m = markStyle(span);
    console.warn(
      "[invisibles:en-space]",
      JSON.stringify({ gapDelta: gapCenterDelta(p, span), m }),
    );
    expect(m.beforeContent).toBe("none");
    expect(m.backgroundImage).toContain("radial-gradient");
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

  it.each([1.0, 2.0, 3.0])(
    "縦書き lh=%s: 全角空白マークが background 方式で隙間中央にいる",
    (lineHeight) => {
      // line-height をパラメタライズする理由: WebKitGTK の abspos paint ズレは
      // leading に比例し、lh=2 でだけ偶然相殺して見える修正案 (translate 方式)
      // が存在した。技法 gate (background) は lh 非依存で成立すること。
      const { el, editor } = mount(para("あ　い"), {
        vertical: true,
        editorSettings: { ...JA_EDITOR_SETTINGS, lineHeight },
      });
      cleanups.push(() => {
        editor.destroy();
        el.remove();
      });

      const span = el.querySelector(".pm-ws-ideographic") as HTMLElement;
      expect(span).toBeTruthy();
      const p = el.querySelector(".tiptap > p") as HTMLElement;
      const m = markStyle(span);
      // WebKitGTK で paint がズレる inline+abspos 技法に依存しない (::before 無し)
      expect(m.beforeContent).toBe("none");
      expect(m.backgroundImage).toContain("linear-gradient");
      // 縦書きでは字送り軸 (縦) の隙間中央に span がいる
      const delta = gapCenterDeltaVertical(p, span);
      expect(delta).not.toBeNull();
      expect(Math.abs(delta!)).toBeLessThan(2);
    },
  );

  it("↵/¶ アンカーは inline-block (WebKitGTK 縦書き abspos paint バグ回避)", () => {
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
      ],
    };
    const { el, editor } = mount(doc, { vertical: true });
    cleanups.push(() => {
      editor.destroy();
      el.remove();
    });

    const br = el.querySelector(".pm-ws-br") as HTMLElement;
    const paraEnd = el.querySelector(".pm-ws-para-end") as HTMLElement;
    expect(br).toBeTruthy();
    expect(paraEnd).toBeTruthy();
    for (const anchor of [br, paraEnd]) {
      const cs = getComputedStyle(anchor);
      // inline 包含ブロックだと WebKitGTK 縦書きで ::before が列から外れる
      expect(cs.display).toBe("inline-block");
      expect(cs.width).toBe("0px");
      expect(cs.overflow).toBe("visible");
    }
  });

  it("タブ → は background 方式で、縦書きでは下向き矢印 + 行頭(上)寄せに切り替わる", () => {
    const horizontal = mount(para("あ\tい"), { vertical: false });
    const vertical = mount(para("あ\tい"), { vertical: true });
    cleanups.push(() => {
      horizontal.editor.destroy();
      horizontal.el.remove();
      vertical.editor.destroy();
      vertical.el.remove();
    });

    const hSpan = horizontal.el.querySelector(".pm-ws-tab") as HTMLElement;
    const vSpan = vertical.el.querySelector(".pm-ws-tab") as HTMLElement;
    expect(hSpan).toBeTruthy();
    expect(vSpan).toBeTruthy();

    const hm = markStyle(hSpan);
    const vm = markStyle(vSpan);
    // 矢印は ::before グリフではなく span 背景の SVG (abspos 非依存)。
    // 論理 inset と物理 top の衝突 (旧実装) の回帰 gate。
    expect(hm.beforeContent).toBe("none");
    expect(vm.beforeContent).toBe("none");
    expect(hm.backgroundImage).toContain("data:image/svg+xml");
    expect(vm.backgroundImage).toContain("data:image/svg+xml");
    // mask を使わないこと: mask は選択ハイライトや同一 span にマージされる
    // 他 decoration の background-color まで矢印形に切り抜いてしまう。
    expect(hm.maskImage === "none" || hm.maskImage === "").toBe(true);
    // 横書き: 行頭=左・行内中央 / 縦書き: 行頭=上・行内中央
    expect(hm.backgroundPosition).toBe("0% 50%");
    expect(vm.backgroundPosition).toBe("50% 0%");
    // 縦書きは下向き矢印 SVG に差し替わる (パスが異なる)
    expect(vm.backgroundImage).not.toBe(hm.backgroundImage);
  });
});
