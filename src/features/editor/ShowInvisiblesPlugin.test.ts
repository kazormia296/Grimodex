// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { getEditorExtensions } from "@/features/editor/extensions";
import { buildInvisibleDecorations } from "@/features/editor/ShowInvisiblesPlugin";

/**
 * 不可視文字の Decoration 構築 (`ShowInvisiblesPlugin`) の契約。
 * ON/OFF ゲートは useShowInvisibles の register/unregister が担うため、
 * ここでは「どの位置にどのクラス/ウィジェットが出るか」を検証する。
 */

function classOf(deco: Decoration): string {
  // inline decoration の class 属性 (内部構造だがテストでは安定)
  return (
    (deco as unknown as { type: { attrs?: { class?: string } } }).type.attrs
      ?.class ?? ""
  );
}

describe("show invisibles decorations", () => {
  let editor: Editor;

  beforeEach(() => {
    editor = new Editor({ extensions: getEditorExtensions(), content: "" });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("marks half-width space, ideographic space, and a hardBreak", () => {
    // tr.insertText で空白を確実に保持する (setContent(HTML) は空白を畳む)
    editor.view.dispatch(editor.state.tr.insertText("a b　c"));
    editor.commands.setHardBreak();
    editor.view.dispatch(editor.state.tr.insertText("d"));

    const decos = buildInvisibleDecorations(editor.state.doc).find();

    // 位置: 1:a 2:space 3:b 4:全角 5:c 6:hardBreak 7:d
    const space = decos.find((d) => d.from === 2 && d.to === 3);
    const ideo = decos.find((d) => d.from === 4 && d.to === 5);
    const brWidget = decos.find((d) => d.from === 6 && d.to === 6);

    expect(space && classOf(space)).toContain("pm-ws-space");
    expect(ideo && classOf(ideo)).toContain("pm-ws-ideographic");
    expect(brWidget).toBeTruthy(); // widget は from===to
  });

  it("marks tab characters", () => {
    editor.view.dispatch(editor.state.tr.insertText("x\ty"));
    const decos = buildInvisibleDecorations(editor.state.doc).find();
    const tab = decos.find((d) => d.from === 2 && d.to === 3);
    expect(tab && classOf(tab)).toContain("pm-ws-tab");
  });

  it("produces no decorations for text without whitespace or breaks", () => {
    editor.view.dispatch(editor.state.tr.insertText("あいうえお"));
    const decos = buildInvisibleDecorations(editor.state.doc).find();
    expect(decos).toHaveLength(0);
  });

  it("rebuilds fresh after edits (no stale decorations)", () => {
    editor.view.dispatch(editor.state.tr.insertText("a b"));
    expect(buildInvisibleDecorations(editor.state.doc).find()).toHaveLength(1);
    // delete the space
    editor.commands.setContent("<p>ab</p>");
    expect(buildInvisibleDecorations(editor.state.doc).find()).toHaveLength(0);
  });
});
