// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { DecorationSet } from "@tiptap/pm/view";
import { getEditorExtensions } from "./extensions";
import {
  buildTateChuYokoDecorations,
  createTateChuYokoPlugin,
  tateChuYokoKey,
  type TateChuYokoPolicy,
} from "./TateChuYokoPlugin";

function makeEditor() {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
  });
}

/** Decoration が覆うテキストを from 昇順で返す（位置正しさの検証用）。 */
function decoTexts(doc: ProseMirrorNode, set: DecorationSet): string[] {
  return set
    .find()
    .slice()
    .sort((a, b) => a.from - b.from)
    .map((d) => doc.textBetween(d.from, d.to));
}

function build(
  contentText: string,
  policy: TateChuYokoPolicy,
): { doc: ProseMirrorNode; texts: string[]; set: DecorationSet } {
  const editor = makeEditor();
  editor.commands.setContent({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: contentText }] },
    ],
  });
  const doc = editor.state.doc;
  const set = buildTateChuYokoDecorations(doc, policy);
  const texts = decoTexts(doc, set);
  editor.destroy();
  return { doc, texts, set };
}

describe("buildTateChuYokoDecorations — policy '2' (既定: 2桁のみ)", () => {
  it("2桁の半角数字 run に1つの tcy decoration を当てる", () => {
    const { texts } = build("第12話", "2");
    expect(texts).toEqual(["12"]);
  });

  it("decoration は数字そのものを正確に覆う（位置の正しさ）", () => {
    const { doc, set } = build("第12話", "2");
    const decos = set.find();
    expect(decos).toHaveLength(1);
    expect(doc.textBetween(decos[0].from, decos[0].to)).toBe("12");
  });

  it("1桁は結合しない（縦中横は2文字以上）", () => {
    expect(build("第5話", "2").texts).toEqual([]);
  });

  it("3桁は結合しない（既定では2桁限定）", () => {
    expect(build("123ページ", "2").texts).toEqual([]);
  });

  it("4桁（年号など）は結合しない", () => {
    expect(build("西暦2026年", "2").texts).toEqual([]);
  });

  it("非数字で区切られた複数の2桁 run はそれぞれ結合する", () => {
    expect(build("12時34分", "2").texts).toEqual(["12", "34"]);
  });

  it("全角数字は対象外（mixed で既に正立するため）", () => {
    expect(build("第１２話", "2").texts).toEqual([]);
  });
});

describe("buildTateChuYokoDecorations — policy 'all' (2桁以上すべて)", () => {
  it("3桁を結合する", () => {
    expect(build("123ページ", "all").texts).toEqual(["123"]);
  });

  it("4桁を結合する", () => {
    expect(build("西暦2026年", "all").texts).toEqual(["2026"]);
  });

  it("1桁は 'all' でも結合しない", () => {
    expect(build("第5話", "all").texts).toEqual([]);
  });

  it("2桁も結合する", () => {
    expect(build("第12話", "all").texts).toEqual(["12"]);
  });
});

describe("buildTateChuYokoDecorations — policy 'off'", () => {
  it("off では decoration を一切作らない", () => {
    const { set } = build("第12話", "off");
    expect(set.find()).toHaveLength(0);
  });
});

describe("buildTateChuYokoDecorations — エッジケース", () => {
  it("mark 境界で分割された数字 run も連結して扱う（20<b>26</b> → 2026）", () => {
    // codexDocFlatten で平坦化するため、mark 境界で text node が割れても
    // 1つの run として検出できる（per-node matchAll では割れてしまう罠）。
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "20" },
            { type: "text", text: "26", marks: [{ type: "bold" }] },
          ],
        },
      ],
    });
    const doc = editor.state.doc;
    // 'all' なら 4桁として1つの deco
    expect(decoTexts(doc, buildTateChuYokoDecorations(doc, "all"))).toEqual([
      "2026",
    ]);
    // '2' なら 4桁なので結合しない
    expect(decoTexts(doc, buildTateChuYokoDecorations(doc, "2"))).toEqual([]);
    editor.destroy();
  });

  it("段落（block）境界をまたぐ数字は結合しない", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "12" }] },
        { type: "paragraph", content: [{ type: "text", text: "34" }] },
      ],
    });
    const doc = editor.state.doc;
    const texts = decoTexts(doc, buildTateChuYokoDecorations(doc, "2"));
    expect(texts).toEqual(["12", "34"]);
    editor.destroy();
  });

  it("2段落目の数字でも位置が正しく解決される", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "序章" }] },
        { type: "paragraph", content: [{ type: "text", text: "第12話" }] },
      ],
    });
    const doc = editor.state.doc;
    const decos = buildTateChuYokoDecorations(doc, "2").find();
    expect(decos).toHaveLength(1);
    expect(doc.textBetween(decos[0].from, decos[0].to)).toBe("12");
    editor.destroy();
  });

  it("ruby base 内の数字は対象外（atom は1 PM 位置に潰れるため）", () => {
    const editor = makeEditor();
    editor
      .chain()
      .focus()
      .setContent({ type: "doc", content: [{ type: "paragraph" }] })
      .run();
    editor.commands.setRuby("12", "じゅうに");
    const doc = editor.state.doc;
    expect(decoTexts(doc, buildTateChuYokoDecorations(doc, "all"))).toEqual([]);
    editor.destroy();
  });

  it("mention atom をまたぐ数字 run は結合しない（flat は連結されるが PM 位置に穴が空く）", () => {
    // codexDocFlatten は mention を flat text に含めないため "12"+mention+"34" は
    // flat 上 "1234" の1 run に見えるが、PM 位置が非連続になり contiguity で弾かれる。
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "12" },
            { type: "mention", attrs: { id: "1", label: "ナナ" } },
            { type: "text", text: "34" },
          ],
        },
      ],
    });
    const doc = editor.state.doc;
    expect(decoTexts(doc, buildTateChuYokoDecorations(doc, "all"))).toEqual([]);
    editor.destroy();
  });
});

describe("createTateChuYokoPlugin — hybrid apply", () => {
  it("docChanged で run が新たに成立したら decoration を再構築する（map では拾えない）", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
    });
    editor.registerPlugin(createTateChuYokoPlugin("2"));
    // 初期 "1" は1桁なので deco なし
    expect(tateChuYokoKey.getState(editor.state)!.find()).toHaveLength(0);
    // "1" の直後に "2" を挿入して "12" にする
    editor.commands.insertContentAt(2, "2");
    const set = tateChuYokoKey.getState(editor.state)!;
    expect(decoTexts(editor.state.doc, set)).toEqual(["12"]);
    editor.destroy();
  });

  it("docChanged の無い transaction では同じ DecorationSet を返す（再計算しない）", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第12話" }] },
      ],
    });
    editor.registerPlugin(createTateChuYokoPlugin("2"));
    const before = tateChuYokoKey.getState(editor.state)!;
    expect(decoTexts(editor.state.doc, before)).toEqual(["12"]);
    // doc を変えない transaction（meta のみ）を流す
    editor.view.dispatch(editor.state.tr.setMeta("noop", true));
    const after = tateChuYokoKey.getState(editor.state)!;
    expect(after).toBe(before);
    editor.destroy();
  });

  it("off ポリシーのプラグインは decoration を作らない", () => {
    const editor = makeEditor();
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第12話" }] },
      ],
    });
    editor.registerPlugin(createTateChuYokoPlugin("off"));
    expect(tateChuYokoKey.getState(editor.state)!.find()).toHaveLength(0);
    editor.destroy();
  });
});
