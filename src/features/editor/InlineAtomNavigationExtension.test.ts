// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection, Selection } from "prosemirror-state";
import { RubyNode } from "./RubyNode";
import { InlineAtomNavigationExtension } from "./InlineAtomNavigationExtension";

function createTestEditor(content = "") {
  return new Editor({
    extensions: [StarterKit, RubyNode, InlineAtomNavigationExtension],
    content,
  });
}

describe("InlineAtomNavigationExtension", () => {
  it("プラグインが正しく登録される", () => {
    const editor = createTestEditor("<p>テスト</p>");
    const plugin = editor.view.state.plugins.find(
      (p) => (p as unknown as { key: string }).key === "inlineAtomNavigation$",
    );
    expect(plugin).toBeDefined();
    editor.destroy();
  });
});

// ——— Ctrl+Home/End ———

describe("handleCtrlEndHome", () => {
  it("Ctrl+End でドキュメント末尾に移動する", () => {
    const editor = createTestEditor("<p>第一段落</p><p>第二段落</p>");
    // カーソルを先頭に
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );

    const endPos = Selection.atEnd(editor.state.doc).to;

    // Ctrl+End をシミュレート
    const event = new KeyboardEvent("keydown", {
      key: "End",
      ctrlKey: true,
      bubbles: true,
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.state.selection.$head.pos).toBe(endPos);
    editor.destroy();
  });

  it("Ctrl+Home でドキュメント先頭に移動する", () => {
    const editor = createTestEditor("<p>第一段落</p><p>第二段落</p>");
    const endPos = Selection.atEnd(editor.state.doc).to;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, endPos),
      ),
    );

    const startPos = Selection.atStart(editor.state.doc).from;

    const event = new KeyboardEvent("keydown", {
      key: "Home",
      ctrlKey: true,
      bubbles: true,
    });
    editor.view.dom.dispatchEvent(event);

    expect(editor.state.selection.$head.pos).toBe(startPos);
    editor.destroy();
  });

  it("Shift+Ctrl+End で選択範囲を末尾まで拡張する", () => {
    const editor = createTestEditor("<p>第一段落</p><p>第二段落</p>");
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );

    const endPos = Selection.atEnd(editor.state.doc).to;

    const event = new KeyboardEvent("keydown", {
      key: "End",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    });
    editor.view.dom.dispatchEvent(event);

    const sel = editor.state.selection as TextSelection;
    expect(sel.$anchor.pos).toBe(1);
    expect(sel.$head.pos).toBe(endPos);
    editor.destroy();
  });

  it("Ctrl なしの End/Home はハンドルしない（ブラウザに委譲）", () => {
    const editor = createTestEditor("<p>テスト</p>");
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)),
    );

    const posBeforeEvent = editor.state.selection.$head.pos;

    // Ctrl なしの End — happy-dom ではブラウザ動作が再現されないため
    // ハンドラが false を返すことを間接的に確認（選択が変わらない）
    const event = new KeyboardEvent("keydown", {
      key: "End",
      ctrlKey: false,
      bubbles: true,
    });
    editor.view.dom.dispatchEvent(event);

    // ブラウザに委譲されるため happy-dom ではカーソル位置は変わらない
    expect(editor.state.selection.$head.pos).toBe(posBeforeEvent);
    editor.destroy();
  });
});

// ——— RubyNode NodeView ———

describe("RubyNode NodeView", () => {
  it("ruby-atom クラスの span wrapper で描画される", () => {
    const editor = createTestEditor(
      '<p>前<ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>後</p>',
    );

    const wrapper = editor.view.dom.querySelector(".ruby-atom");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.tagName).toBe("SPAN");
    expect((wrapper as HTMLElement).contentEditable).toBe("false");

    const ruby = wrapper!.querySelector("ruby");
    expect(ruby).not.toBeNull();
    expect(ruby!.getAttribute("data-base")).toBe("漢字");
    expect(ruby!.getAttribute("data-annotation")).toBe("かんじ");

    editor.destroy();
  });

  it("ruby 内に正しいテキストと rt を含む", () => {
    const editor = createTestEditor(
      '<p><ruby data-base="東京" data-annotation="とうきょう">東京<rp>(</rp><rt>とうきょう</rt><rp>)</rp></ruby></p>',
    );

    const ruby = editor.view.dom.querySelector(".ruby-atom ruby")!;
    const rt = ruby.querySelector("rt");
    expect(rt).not.toBeNull();
    expect(rt!.textContent).toBe("とうきょう");
    expect(ruby.firstChild!.textContent).toBe("東京");

    editor.destroy();
  });

  it("ノード更新時に属性が反映される", () => {
    const editor = createTestEditor(
      '<p><ruby data-base="漢字" data-annotation="かんじ">漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></p>',
    );

    // setRuby で新しいルビを挿入（既存のものを置換）
    editor.commands.setTextSelection({ from: 1, to: 2 });
    editor.commands.setRuby("新字", "しんじ");

    const ruby = editor.view.dom.querySelector(".ruby-atom ruby")!;
    expect(ruby.getAttribute("data-base")).toBe("新字");
    expect(ruby.getAttribute("data-annotation")).toBe("しんじ");
    expect(ruby.querySelector("rt")!.textContent).toBe("しんじ");

    editor.destroy();
  });
});
