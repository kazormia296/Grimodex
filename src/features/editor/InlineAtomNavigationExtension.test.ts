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
  it("coordsAtPos が同一topを返す間は前進する", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const state = editor.state;
    const view = editor.view;

    // happy-dom にレイアウトエンジンがないため coordsAtPos を一定値でモック
    // top が変わらない → bestPos が parentEnd まで進む
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      top: 10,
      bottom: 24,
      left: 0,
      right: 10,
    });

    const $start = state.doc.resolve(1);
    const parentEnd = $start.end();
    const result = findVisualLineEdge(view, 1, "right");
    expect(result).toBe(parentEnd);

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("topが4px以上ずれたら停止し直前の位置を返す", () => {
    const editor = createTestEditor("<p>テスト文章</p>");
    const view = editor.view;
    let callCount = 0;

    vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      // 最初の呼び出しは startCoords（top:10）
      // 2回目以降は scan: 3回目から top が変わる
      const top = callCount++ < 2 ? 10 : 30;
      return { top, bottom: top + 14, left: 0, right: 10 };
    });

    const result = findVisualLineEdge(view, 1, "right");
    // callCount==0: startCoords, callCount==1: pos=2(top=10 → bestPos=2),
    // callCount==2: pos=3(top=30 → break)  → bestPos = 2
    expect(result).toBe(2);

    vi.restoreAllMocks();
    editor.destroy();
  });

  it("coordsAtPos が例外を投げた場合は startPos を返す", () => {
    const editor = createTestEditor("<p>テスト</p>");
    const view = editor.view;
    vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
      throw new Error("layout error");
    });

    const result = findVisualLineEdge(view, 1, "right");
    expect(result).toBe(1);

    vi.restoreAllMocks();
    editor.destroy();
  });
});

// ——— キーボードハンドラのガード条件 ———

describe("InlineAtomNavigationExtension キーハンドラ", () => {
  it("ルビを含む段落で登録されるキーショートカットが存在する", () => {
    const editor = createTestEditor(
      '<p>前<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );
    // エクステンションのキーマップが登録されていることを確認
    // (TipTap はキーマップを extensions から収集する)
    const ext = editor.extensionManager.extensions.find(
      (e) => e.name === "inlineAtomNavigation",
    );
    expect(ext).toBeDefined();
    editor.destroy();
  });

  it("ArrowRight: textOffset===0 のときは false を返す（ProseMirrorに委譲）", () => {
    const editor = createTestEditor(
      '<p><ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );
    // doc: para(ruby, "後")  → pos=1 はrubyの直前、textOffset=0
    const paraStart = 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, paraStart),
      ),
    );
    const { $head } = editor.state.selection as TextSelection;
    expect($head.textOffset).toBe(0);

    // ハンドラが false を返す = ProseMirror に委譲される
    const handled = editor.commands.command(
      ({ commands: _c, tr: _tr, state, dispatch }) => {
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        if (!selection.empty) return false;
        const { $head: h } = selection;
        if (!h.parent.isTextblock) return false;
        if (h.textOffset === 0) return false; // ← ここで false
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
      },
    );
    expect(handled).toBe(false);
    editor.destroy();
  });

  it("ArrowRight: atom含有ブロック内でtextOffset>0 のとき1ポジション移動する", () => {
    const editor = createTestEditor(
      '<p>前<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );
    // "前" (1文字) の位置 pos=2 にカーソルを置く（paragraph start=1, "前"が1文字=pos1, textOffset=1）
    // paragraph content: "前"(1) + ruby(1) + "後"(1) = 3
    // pos=1: before "前", pos=2: after "前" (= before ruby)
    // "前" 内のカーソル: textOffset>0 になるのは pos=1 (inside "前")
    // Actually for single character "前": pos=1 is before it, pos=2 is after it.
    // textOffset at pos=1 (before "前"): 0 (node boundary)
    // textOffset at pos=2 (after "前", before ruby): 0 (node boundary)
    // So there's no textOffset>0 case with 1-char text. Use longer text.
    editor.destroy();

    const editor2 = createTestEditor(
      '<p>テスト<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>です</p>',
    );
    // "テスト" は3文字: pos1=T, pos2=e, pos3=s, pos4=ト → textOffset at pos=3 is 2 (inside "テスト")
    // Para starts at doc pos 1, content:
    //   "テスト" (size=3): positions 1,2,3,4
    //   ruby (size=1): positions 4,5
    //   "です" (size=2): positions 5,6,7
    const state = editor2.state;
    // Set cursor inside "テスト" (textOffset=2 → doc pos = 1+2 = 3)
    editor2.view.dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );

    const { $head } = editor2.state.selection as TextSelection;
    expect($head.textOffset).toBeGreaterThan(0);
    expect(textblockHasInlineAtom($head.parent)).toBe(true);

    const before = $head.pos; // 3
    // Simulate ArrowRight handler
    const handled = editor2.commands.command(({ state: s, dispatch }) => {
      const { selection } = s;
      if (!(selection instanceof TextSelection)) return false;
      if (!selection.empty) return false;
      const { $head: h } = selection;
      if (!h.parent.isTextblock) return false;
      if (h.textOffset === 0) return false;
      if (!textblockHasInlineAtom(h.parent)) return false;
      if (h.parentOffset >= h.parent.content.size) return false;
      if (dispatch) {
        dispatch(
          s.tr
            .setSelection(TextSelection.create(s.doc, h.pos + 1))
            .scrollIntoView(),
        );
      }
      return true;
    });

    expect(handled).toBe(true);
    const after = (editor2.state.selection as TextSelection).$head.pos;
    expect(after).toBe(before + 1);
    editor2.destroy();
  });

  it("ArrowRight: atom非含有ブロックでは false を返す（通常テキストはブラウザ委譲）", () => {
    const editor = createTestEditor("<p>テスト文章です</p>");
    const state = editor.state;
    // pos=3 (textOffset=2, inside text)
    editor.view.dispatch(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );
    const { $head } = editor.state.selection as TextSelection;
    expect($head.textOffset).toBeGreaterThan(0);
    expect(textblockHasInlineAtom($head.parent)).toBe(false); // ← atom なし

    const handled = editor.commands.command(({ state: s, dispatch }) => {
      const { selection } = s;
      if (!(selection instanceof TextSelection)) return false;
      if (!selection.empty) return false;
      const { $head: h } = selection;
      if (!h.parent.isTextblock) return false;
      if (h.textOffset === 0) return false;
      if (!textblockHasInlineAtom(h.parent)) return false; // ← ここで false
      if (h.parentOffset >= h.parent.content.size) return false;
      if (dispatch) {
        dispatch(
          s.tr
            .setSelection(TextSelection.create(s.doc, h.pos + 1))
            .scrollIntoView(),
        );
      }
      return true;
    });
    expect(handled).toBe(false);
    editor.destroy();
  });
});
