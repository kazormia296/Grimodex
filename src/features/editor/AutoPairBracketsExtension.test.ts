// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * 約物ペア自動補完 (`editor.autoPairBrackets`) の配線契約。
 *
 * ペア挿入・オーバータイプは InputRule (handleTextInput 経路) で発火するので
 * 1文字送りハーネスで検証。Backspace は物理キーなので handleKeyDown を合成する。
 * 実 IME の二重挿入挙動は happy-dom で再現不能 → 手動QA。
 */

function setSettings(values: Record<string, string>) {
  useSettingsStore.setState((s) => ({ cache: { ...s.cache, ...values } }));
}

function typeText(editor: Editor, text: string) {
  for (const ch of text) {
    const view = editor.view;
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
    );
    if (!handled) {
      view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  }
}

function pressBackspace(editor: Editor): boolean {
  const view = editor.view;
  const event = new KeyboardEvent("keydown", { key: "Backspace" });
  return view.someProp("handleKeyDown", (f) => f(view, event)) === true;
}

describe("auto-pair brackets", () => {
  let editor: Editor;

  beforeEach(() => {
    setSettings({
      "editor.autoPairBrackets": "true",
      "editor.aozoraInput": "false",
      "editor.smartQuotes": "false",
      "editor.smartDashes": "false",
    });
    editor = new Editor({ extensions: getEditorExtensions(), content: "" });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("inserts the closing bracket with caret placed between", () => {
    typeText(editor, "「");
    expect(editor.state.doc.textContent).toBe("「」");
    // caret is between the pair → typing flows inside
    typeText(editor, "あ");
    expect(editor.state.doc.textContent).toBe("「あ」");
  });

  it("pairs every configured 約物", () => {
    for (const [open, close] of [
      ["『", "』"],
      ["（", "）"],
      ["【", "】"],
      ["〔", "〕"],
      ["［", "］"],
      ["〈", "〉"],
      ["｛", "｝"],
    ] as const) {
      editor.commands.clearContent();
      typeText(editor, open);
      expect(editor.state.doc.textContent).toBe(open + close);
    }
  });

  it("overtypes an existing matching close instead of duplicating", () => {
    typeText(editor, "「あ」");
    expect(editor.state.doc.textContent).toBe("「あ」");
    // caret should be after the closing bracket now (typing appends outside)
    typeText(editor, "。");
    expect(editor.state.doc.textContent).toBe("「あ」。");
  });

  it("does not auto-close before a content character", () => {
    editor.commands.setContent("<p>こんにちは</p>");
    editor.commands.setTextSelection(1); // before こ
    typeText(editor, "「");
    expect(editor.state.doc.textContent).toBe("「こんにちは");
  });

  it("smart Backspace deletes both halves of an empty pair", () => {
    typeText(editor, "「");
    expect(editor.state.doc.textContent).toBe("「」");
    const handled = pressBackspace(editor);
    expect(handled).toBe(true);
    expect(editor.state.doc.textContent).toBe("");
  });

  it("Backspace is not hijacked when not inside an empty pair", () => {
    typeText(editor, "あ");
    const handled = pressBackspace(editor);
    // our handler declines (returns false) → default backspace applies
    expect(handled).toBe(false);
  });

  it("OFF: typing an opening bracket does not auto-close", () => {
    setSettings({ "editor.autoPairBrackets": "false" });
    typeText(editor, "「");
    expect(editor.state.doc.textContent).toBe("「");
  });

  it("does not pair 《 (reserved for ruby/emphasis)", () => {
    typeText(editor, "《");
    expect(editor.state.doc.textContent).toBe("《");
  });

  // 回帰: overtype 直後の Backspace で inputRules-undo が net-zero overtype を
  // 巻き戻して閉じ約物を再挿入する (「」→「」」) 不具合。undoable:false で防ぐ。
  it("Backspace right after overtype does not re-insert a stray close", () => {
    typeText(editor, "「」"); // 「→「」(間)、」→ overtype で「」(後ろ)
    expect(editor.state.doc.textContent).toBe("「」");
    pressBackspace(editor);
    // 閉じが増えていないこと (バグ時は "「」」")
    expect(editor.state.doc.textContent).not.toBe("「」」");
    expect(editor.state.doc.textContent).toBe("「」");
  });

  it("does not auto-close before 〇 (ideographic zero, common in 年号)", () => {
    editor.commands.setContent("<p>〇年</p>");
    editor.commands.setTextSelection(1); // before 〇
    typeText(editor, "「");
    expect(editor.state.doc.textContent).toBe("「〇年");
  });
});
