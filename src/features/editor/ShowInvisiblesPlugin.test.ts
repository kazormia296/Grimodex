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

function widgetDecorations(
  doc: Parameters<typeof buildInvisibleDecorations>[0],
) {
  return buildInvisibleDecorations(doc)
    .find()
    .filter((d) => d.from === d.to);
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
    const paraEnd = decos.find((d) => d.from === 8 && d.to === 8);

    expect(space && classOf(space)).toContain("pm-ws-space");
    expect(ideo && classOf(ideo)).toContain("pm-ws-ideographic");
    expect(brWidget).toBeTruthy(); // widget は from===to
    expect(paraEnd).toBeTruthy();
  });

  it("marks tab characters", () => {
    editor.view.dispatch(editor.state.tr.insertText("x\ty"));
    const decos = buildInvisibleDecorations(editor.state.doc).find();
    const tab = decos.find((d) => d.from === 2 && d.to === 3);
    expect(tab && classOf(tab)).toContain("pm-ws-tab");
  });

  it("produces no whitespace decorations for text without whitespace or breaks", () => {
    editor.view.dispatch(editor.state.tr.insertText("あいうえお"));
    const decos = buildInvisibleDecorations(editor.state.doc).find();
    const inline = decos.filter((d) => d.from !== d.to);
    expect(inline).toHaveLength(0);
    expect(decos.some((d) => d.from === d.to)).toBe(true); // 段落末 ¶
  });

  it("rebuilds fresh after edits (no stale decorations)", () => {
    editor.view.dispatch(editor.state.tr.insertText("a b"));
    const withSpace = buildInvisibleDecorations(editor.state.doc).find();
    expect(withSpace.filter((d) => d.from !== d.to)).toHaveLength(1);
    // delete the space
    editor.commands.setContent("<p>ab</p>");
    const withoutSpace = buildInvisibleDecorations(editor.state.doc).find();
    expect(withoutSpace.filter((d) => d.from !== d.to)).toHaveLength(0);
  });

  it("adds paragraph-end widgets for top-level, list, and blockquote blocks only", () => {
    editor.commands.setContent(
      "<p>top</p>" +
        "<ul><li><p>one</p></li><li><p>two</p></li></ul>" +
        "<blockquote><p>quote</p></blockquote>" +
        '<div data-type="generated-prose-block"><p>nested</p></div>' +
        "<h4>skip</h4>",
    );
    const widgets = widgetDecorations(editor.state.doc);
    const hasWidgetAt = (nodePos: number, nodeSize: number) =>
      widgets.some((w) => w.from === nodePos + nodeSize - 1);

    editor.state.doc.descendants((node, pos, parent) => {
      if (node.type.name === "paragraph") {
        const expectWidget = ["doc", "listItem", "blockquote"].includes(
          parent?.type.name ?? "",
        );
        expect(hasWidgetAt(pos, node.nodeSize)).toBe(expectWidget);
      }
      if (node.type.name === "heading") {
        const level = node.attrs.level as number;
        const expectWidget =
          parent?.type.name === "doc" && level >= 1 && level <= 3;
        expect(hasWidgetAt(pos, node.nodeSize)).toBe(expectWidget);
      }
    });
  });

  it("adds paragraph-end widgets for doc-level headings h1–h3", () => {
    editor.commands.setContent("<h1>a</h1><h2>b</h2><h3>c</h3>");
    const widgets = widgetDecorations(editor.state.doc);
    const hasWidgetAt = (nodePos: number, nodeSize: number) =>
      widgets.some((w) => w.from === nodePos + nodeSize - 1);

    editor.state.doc.descendants((node, pos, parent) => {
      if (node.type.name !== "heading" || parent?.type.name !== "doc") return;
      const level = node.attrs.level as number;
      expect(hasWidgetAt(pos, node.nodeSize)).toBe(level >= 1 && level <= 3);
    });
    expect(widgets.length).toBeGreaterThanOrEqual(3);
  });
});
