// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "./extensions";
import {
  buildEmphasisDotsFallbackDecorations,
  createEmphasisDotsFallbackPlugin,
  emphasisDotsFallbackKey,
} from "./EmphasisDotsFallbackPlugin";

// settingsStore / platform を制御可能にして縦書き / WebKitGTK を切り替える。
let mockVertical = true;
let mockWebKitGtk = true;

vi.mock("@/features/settings/settingsStore", () => {
  const state = {
    getBoolean: (k: string, d: boolean) =>
      k === "editor.verticalMode" ? mockVertical : d,
    get: (_k: string, d: string) => d,
    projectLanguage: "ja",
  };
  const useSettingsStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  // Editor へのトランザクション適用時に他プラグイン (reorder 系) が
  // useSettingsStore.getState() を呼ぶため store API も生やしておく。
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

vi.mock("@/lib/platform", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/platform")>();
  return { ...mod, isWebKitGtk: () => mockWebKitGtk };
});

import { useEmphasisDotsFallback } from "./useEmphasisDotsFallback";

function makeEditor(content?: unknown): Editor {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: content as never,
  });
}

function emphasisPara(text: string, marked: [number, number]) {
  const [from, to] = marked;
  const content = [];
  if (from > 0) content.push({ type: "text", text: text.slice(0, from) });
  content.push({
    type: "text",
    text: text.slice(from, to),
    marks: [{ type: "emphasisDots" }],
  });
  if (to < text.length) content.push({ type: "text", text: text.slice(to) });
  return { type: "doc", content: [{ type: "paragraph", content }] };
}

function fallbackPluginCount(editor: Editor): number {
  return editor.view.state.plugins.filter(
    (p) => p.spec.key === emphasisDotsFallbackKey,
  ).length;
}

describe("buildEmphasisDotsFallbackDecorations", () => {
  it("emphasisDots run を1文字ずつ .emphasis-dot-char に割る", () => {
    const editor = makeEditor(emphasisPara("あ強調語い", [1, 4]));
    const decos = buildEmphasisDotsFallbackDecorations(editor.state.doc);
    // 段落先頭 = pos 1。「強調語」は doc 位置 [2,5)。run の外は作らない。
    const found = decos.find();
    expect(found.map((d) => [d.from, d.to])).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    // CSS (index.css の .emphasis-dot-char 規則) と結合するクラス名の契約。
    // typo/リネームすると native 停止だけが残り傍点が完全に消えるため gate する。
    for (const d of found) {
      expect(
        (d.spec as { class?: string }).class ??
          (d as unknown as { type: { attrs: { class: string } } }).type.attrs
            .class,
      ).toBe("emphasis-dot-char");
    }
    editor.destroy();
  });

  it("registerPlugin 直後 (init 経路) に既存マークへ decoration が付く", () => {
    // 「傍点入りの既存シーンを WebKitGTK×縦書きで開く」体験は init のみに
    // 依存する（動的登録の reconfigure が現在 doc で init を呼ぶ）。
    const editor = makeEditor(emphasisPara("あ強調語い", [1, 4]));
    editor.registerPlugin(createEmphasisDotsFallbackPlugin());
    // トランザクションを一切流さず、登録直後の state を検証する
    const decos = emphasisDotsFallbackKey.getState(editor.state);
    expect(decos?.find().map((d) => [d.from, d.to])).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    editor.destroy();
  });

  it("マークが無い doc では decoration を作らない", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "素のテキスト" }],
        },
      ],
    });
    const decos = buildEmphasisDotsFallbackDecorations(editor.state.doc);
    expect(decos.find().length).toBe(0);
    editor.destroy();
  });

  it("run 内の空白には傍点を打たない（native text-emphasis と同じ）", () => {
    const editor = makeEditor(emphasisPara("あ 　い", [0, 4]));
    const decos = buildEmphasisDotsFallbackDecorations(editor.state.doc);
    // 「あ」「い」のみ（半角空白 pos2 / 全角空白 pos3 はスキップ）
    const found = decos.find();
    expect(found.length).toBe(2);
    expect(found.map((d) => d.from)).toEqual([1, 4]);
    editor.destroy();
  });

  it("サロゲートペアを分断しない（1 grapheme = 1 decoration）", () => {
    const editor = makeEditor(emphasisPara("𠮷野家", [0, 4]));
    const decos = buildEmphasisDotsFallbackDecorations(editor.state.doc);
    const found = decos.find();
    // 𠮷 (2 code units) + 野 + 家 = 3 decorations
    expect(found.length).toBe(3);
    expect(found[0].to - found[0].from).toBe(2);
    editor.destroy();
  });

  it("mark を新規に付けると decoration が追従する（docChanged 再構築）", () => {
    const editor = makeEditor({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "強調される" }] },
      ],
    });
    // 実プラグインを直接登録して apply（docChanged 再構築）経路を検証する
    editor.registerPlugin(createEmphasisDotsFallbackPlugin());
    expect(
      emphasisDotsFallbackKey.getState(editor.state)?.find().length ?? 0,
    ).toBe(0);

    editor
      .chain()
      .setTextSelection({ from: 1, to: 6 })
      .setMark("emphasisDots")
      .run();
    expect(
      emphasisDotsFallbackKey.getState(editor.state)?.find().length ?? 0,
    ).toBe(5);
    editor.destroy();
  });
});

describe("useEmphasisDotsFallback — 動的登録ライフサイクル", () => {
  beforeEach(() => {
    mockVertical = true;
    mockWebKitGtk = true;
  });

  it("縦書き && WebKitGTK で plugin を1つだけ登録する", () => {
    const editor = makeEditor();
    renderHook(() => useEmphasisDotsFallback(editor));
    expect(fallbackPluginCount(editor)).toBe(1);
    editor.destroy();
  });

  it("横書きでは登録しない", () => {
    mockVertical = false;
    const editor = makeEditor();
    renderHook(() => useEmphasisDotsFallback(editor));
    expect(fallbackPluginCount(editor)).toBe(0);
    editor.destroy();
  });

  it("WebKitGTK 以外（Chromium/WKWebView）では登録しない", () => {
    mockWebKitGtk = false;
    const editor = makeEditor();
    renderHook(() => useEmphasisDotsFallback(editor));
    expect(fallbackPluginCount(editor)).toBe(0);
    editor.destroy();
  });

  it("縦書きを ON→OFF→ON してもプラグインは重複せず追従する（リーク無し）", () => {
    const editor = makeEditor();
    const { rerender } = renderHook(() => useEmphasisDotsFallback(editor));
    expect(fallbackPluginCount(editor)).toBe(1);

    mockVertical = false;
    rerender();
    expect(fallbackPluginCount(editor)).toBe(0);

    mockVertical = true;
    rerender();
    expect(fallbackPluginCount(editor)).toBe(1);

    editor.destroy();
  });
});
