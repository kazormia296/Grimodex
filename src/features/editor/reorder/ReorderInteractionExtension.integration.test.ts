// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Decoration } from "@tiptap/pm/view";
import { getEditorExtensions } from "../extensions";
import { swapBlockAt } from "../ParagraphMoveExtension";
import {
  reorderUiKey,
  __resetReorderInteractionForTest,
  __reorderDragTestHooks,
} from "./ReorderInteractionExtension";
import { resolveParagraphAtSelection } from "./paragraphFlat";
import { splitSentencesJa } from "./sentenceSplit";
import { useReorderModifierStore } from "./reorderModifierStore";

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "ja",
  };
});

function makeEditor(html: string): Editor {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content: html,
  });
}

function decos(editor: Editor): Decoration[] {
  return reorderUiKey.getState(editor.state)?.decorations.find() ?? [];
}

function classOf(d: Decoration): string {
  return (
    (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs
      ?.class ?? ""
  );
}

describe("ReorderInteractionExtension", () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    useReorderModifierStore.setState({ mode: "none", granularity: "sentence" });
    __resetReorderInteractionForTest();
  });

  it("swapBlockAt swaps a block at an explicit index (drag primitive)", () => {
    editor = makeEditor("<p>first</p><p>second</p><p>third</p>");
    // index 0 を dir=1 で下へ → first と second が入れ替わる
    expect(swapBlockAt(editor.view, 0, 1)).toBe(true);
    expect(editor.state.doc.content.content.map((n) => n.textContent)).toEqual([
      "second",
      "first",
      "third",
    ]);
    // index 2 を dir=1（範囲外）は不可
    expect(swapBlockAt(editor.view, 2, 1)).toBe(false);
  });

  it("mode='none' produces no decorations", () => {
    editor = makeEditor("<p>あいう。えお。</p>");
    expect(decos(editor)).toHaveLength(0);
  });

  it("mode='altShift' bands each sentence unit and rings the caret unit", () => {
    editor = makeEditor("<p>あいう。えお。かきく。</p>");
    editor.commands.setTextSelection(2); // 最初の文「あいう。」内
    useReorderModifierStore.getState().setMode("altShift");

    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit"),
    );
    // 3 文 → 3 帯
    expect(inline).toHaveLength(3);
    // 色帯クラスが循環している
    expect(classOf(inline[0]!)).toContain("reorder-unit-c0");
    expect(classOf(inline[1]!)).toContain("reorder-unit-c1");
    // caret のある最初の unit だけ active
    const active = inline.filter((d) =>
      classOf(d).includes("reorder-unit-active"),
    );
    expect(active).toHaveLength(1);
    expect(classOf(active[0]!)).toContain("reorder-unit-c0");
  });

  it("active unit follows the caret", () => {
    editor = makeEditor("<p>あいう。えお。かきく。</p>");
    useReorderModifierStore.getState().setMode("altShift");
    // 「えお。」内へキャレット移動（"あいう。"=4文字→pos 1..5, "えお。"=pos5..8 くらい）
    editor.commands.setTextSelection(6);
    // 選択変更で再ビルドされる
    const inline = decos(editor).filter((d) =>
      classOf(d).includes("reorder-unit-active"),
    );
    expect(inline).toHaveLength(1);
    expect(classOf(inline[0]!)).toContain("reorder-unit-c1");
  });

  it("mode='alt' adds a handle widget + relative anchor per non-leaf block", () => {
    editor = makeEditor("<p>one</p><p>two</p>");
    useReorderModifierStore.getState().setMode("alt");
    const all = decos(editor);
    const anchors = all.filter((d) =>
      classOf(d).includes("reorder-block-anchor"),
    );
    const handles = all.filter(
      (d) =>
        (d.spec as { key?: string } | undefined)?.key ===
        "reorder-block-handle",
    );
    expect(anchors).toHaveLength(2);
    expect(handles).toHaveLength(2);
  });

  it("single-unit paragraph gets no bands in altShift", () => {
    editor = makeEditor("<p>句点なし本文</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    expect(decos(editor)).toHaveLength(0);
  });

  it("unit drag (mouse) incrementally reorders to the pointer target and clears drag state", () => {
    editor = makeEditor("<p>AAA。BBB。CCC。</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units0 = splitSentencesJa(resolved.flat.text);
    expect(units0).toHaveLength(3);
    // ポインタは常に段落末尾を指す → unit0 を末尾までインクリメンタル移動。
    const endPos = resolved.contentTo - 1;
    editor.view.posAtCoords = () => ({ pos: endPos, inside: -1 });

    __reorderDragTestHooks.startUnitDrag(editor.view, resolved.pos, units0, 0);
    // ドラッグ中の色帯は plugin 状態の drag order から組まれる。
    expect(reorderUiKey.getState(editor.state)?.drag).not.toBeNull();
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup"));

    // AAA。が末尾へ。内容は一切欠落しない。
    expect(editor.state.doc.textContent).toBe("BBB。CCC。AAA。");
    // ドラッグ状態はクリア済み。
    expect(reorderUiKey.getState(editor.state)?.drag).toBeNull();
  });

  it("block drag (mouse) incrementally reorders whole paragraphs to the pointer target", () => {
    editor = makeEditor("<p>one</p><p>two</p><p>three</p>");
    useReorderModifierStore.getState().setMode("alt");
    // ポインタは 3 番目のブロック内を指す。
    const doc = editor.state.doc;
    let thirdStart = 0;
    for (let i = 0; i < 2; i++) thirdStart += doc.child(i).nodeSize;
    editor.view.posAtCoords = () => ({ pos: thirdStart + 2, inside: -1 });

    __reorderDragTestHooks.startBlockDrag(editor.view, 0);
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 200, clientY: 200 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup"));

    expect(editor.state.doc.content.content.map((n) => n.textContent)).toEqual([
      "two",
      "three",
      "one",
    ]);
  });

  it("drag cleanup removes window listeners (no dangling swaps after mouseup)", () => {
    editor = makeEditor("<p>AAA。BBB。CCC。</p>");
    editor.commands.setTextSelection(2);
    useReorderModifierStore.getState().setMode("altShift");
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const units0 = splitSentencesJa(resolved.flat.text);
    editor.view.posAtCoords = () => ({
      pos: resolved.contentTo - 1,
      inside: -1,
    });
    __reorderDragTestHooks.startUnitDrag(editor.view, resolved.pos, units0, 0);
    window.dispatchEvent(new MouseEvent("mouseup"));
    const after = editor.state.doc.textContent;
    // mouseup 後の mousemove は無視される（リスナ解除済み）。
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, clientY: 300 }),
    );
    expect(editor.state.doc.textContent).toBe(after);
  });
});
