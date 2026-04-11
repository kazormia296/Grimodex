// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "prosemirror-state";
import { RubyNode } from "./RubyNode";
import {
  textblockHasInlineAtom,
  findVisualLineEdge,
  InlineAtomNavigationExtension,
} from "./InlineAtomNavigationExtension";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, RubyNode, InlineAtomNavigationExtension],
    content,
  });
}

// ——— textblockHasInlineAtom ———

describe("textblockHasInlineAtom", () => {
  it("テキストのみの段落では false を返す", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const para = editor.state.doc.child(0);
    expect(textblockHasInlineAtom(para)).toBe(false);
    editor.destroy();
  });

  it("ルビを含む段落では true を返す", () => {
    const editor = createTestEditor(
      '<p>前<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );
    const para = editor.state.doc.child(0);
    expect(textblockHasInlineAtom(para)).toBe(true);
    editor.destroy();
  });

  it("空の段落では false を返す", () => {
    const editor = createTestEditor("<p></p>");
    const para = editor.state.doc.child(0);
    expect(textblockHasInlineAtom(para)).toBe(false);
    editor.destroy();
  });
});

// ——— findVisualLineEdge ———

describe("findVisualLineEdge", () => {
  it("coordsAtPos が同一 bottom を返す間は前進する", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const view = editor.view;

    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      top: 10,
      bottom: 24,
      left: 0,
      right: 10,
    });

    const $start = editor.state.doc.resolve(1);
    const parentEnd = $start.end();
    expect(findVisualLineEdge(view, 1, "right")).toBe(parentEnd);

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("bottom が 8px 以上ずれたら停止し直前の位置を返す", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const view = editor.view;
    let callCount = 0;

    vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      const bottom = callCount++ < 2 ? 24 : 48;
      return { top: bottom - 14, bottom, left: 0, right: 10 };
    });

    expect(findVisualLineEdge(view, 1, "right")).toBe(2);

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("ルビの top が異なっても bottom が同一なら同一行と判定する", () => {
    const editor = createTestEditor(
      '<p>テスト<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>',
    );
    const view = editor.view;

    vi.spyOn(view, "coordsAtPos").mockImplementation(
      (pos: number, _side?: number) => {
        const $pos = view.state.doc.resolve(pos);
        const parentOffset = $pos.parentOffset;
        const isRubyArea = parentOffset >= 3 && parentOffset < 4;
        return {
          top: isRubyArea ? 0 : 10,
          bottom: 24,
          left: parentOffset * 10,
          right: (parentOffset + 1) * 10,
        };
      },
    );

    const $start = view.state.doc.resolve(1);
    expect(findVisualLineEdge(view, 1, "right")).toBe($start.end());

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("atom付近でcoordsAtPosが例外を投げてもスキップして走査を続行する", () => {
    const editor = createTestEditor(
      '<p>テスト<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>',
    );
    const view = editor.view;

    // parentOffset 3..4 (ruby付近) で例外、それ以外は bottom=24
    vi.spyOn(view, "coordsAtPos").mockImplementation(
      (pos: number, _side?: number) => {
        const $pos = view.state.doc.resolve(pos);
        const parentOffset = $pos.parentOffset;
        if (parentOffset >= 3 && parentOffset <= 4)
          throw new Error("atom coord error");
        return { top: 10, bottom: 24, left: 0, right: 10 };
      },
    );

    const $start = view.state.doc.resolve(1);
    const result = findVisualLineEdge(view, 1, "right");
    // 例外位置をスキップして最後まで走査 → parentEnd
    expect(result).toBe($start.end());

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("開始位置で例外の場合はテキストブロック端にフォールバックする", () => {
    const editor = createTestEditor("<p>テスト</p>");
    const view = editor.view;
    vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      throw new Error("layout error");
    });

    const $start = view.state.doc.resolve(1);
    expect(findVisualLineEdge(view, 1, "right")).toBe($start.end());

    vi.restoreAllMocks();
    editor.destroy();
  });
});

// ——— handleArrow ガード条件 ———

describe("handleArrow ガード条件", () => {
  it("atom含有ブロック内でtextOffset>0 のとき1ポジション移動する", () => {
    const editor = createTestEditor(
      '<p>テスト<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>',
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
    );

    const { $head } = editor.state.selection as TextSelection;
    expect($head.textOffset).toBeGreaterThan(0);
    expect(textblockHasInlineAtom($head.parent)).toBe(true);

    const before = $head.pos;
    const handled = editor.commands.command(({ state, dispatch }) => {
      const { selection } = state;
      if (!(selection instanceof TextSelection)) return false;
      if (!selection.empty) return false;
      const h = selection.$head;
      if (!h.parent.isTextblock) return false;
      if (!textblockHasInlineAtom(h.parent)) return false;
      if (h.parentOffset >= h.parent.content.size) return false;
      if (h.textOffset === 0) {
        const adj = h.nodeAfter;
        if (adj && !adj.isText && adj.isAtom) return false;
      }
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, h.pos + 1))
            .scrollIntoView(),
        );
      }
      return true;
    });

    expect(handled).toBe(true);
    expect((editor.state.selection as TextSelection).$head.pos).toBe(
      before + 1,
    );
    editor.destroy();
  });

  it("atom非含有ブロックでは false を返す", () => {
    const editor = createTestEditor("<p>テスト文章です</p>");
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)),
    );

    const handled = editor.commands.command(({ state, dispatch }) => {
      const { selection } = state;
      if (!(selection instanceof TextSelection)) return false;
      if (!selection.empty) return false;
      const h = selection.$head;
      if (!h.parent.isTextblock) return false;
      if (!textblockHasInlineAtom(h.parent)) return false;
      if (h.parentOffset >= h.parent.content.size) return false;
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, h.pos + 1))
            .scrollIntoView(),
        );
      }
      return true;
    });
    expect(handled).toBe(false);
    editor.destroy();
  });

  it("textOffset===0 でatom隣接の場合は false を返す（ProseMirror委譲）", () => {
    const editor = createTestEditor(
      '<p><ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );
    const { $head } = editor.state.selection as TextSelection;
    expect($head.textOffset).toBe(0);
    expect($head.nodeAfter?.type.name).toBe("ruby");

    const handled = editor.commands.command(({ state, dispatch }) => {
      const { selection } = state;
      if (!(selection instanceof TextSelection)) return false;
      if (!selection.empty) return false;
      const h = selection.$head;
      if (!h.parent.isTextblock) return false;
      if (!textblockHasInlineAtom(h.parent)) return false;
      if (h.parentOffset >= h.parent.content.size) return false;
      if (h.textOffset === 0) {
        const adj = h.nodeAfter;
        if (adj && !adj.isText && adj.isAtom) return false;
      }
      if (dispatch) {
        dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, h.pos + 1))
            .scrollIntoView(),
        );
      }
      return true;
    });
    expect(handled).toBe(false);
    editor.destroy();
  });

  it("プラグインが正しく登録される", () => {
    const editor = createTestEditor("<p>テスト</p>");
    const plugin = editor.view.state.plugins.find(
      (p) => (p as unknown as { key: string }).key === "inlineAtomNavigation$",
    );
    expect(plugin).toBeDefined();
    editor.destroy();
  });
});
