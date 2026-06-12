// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * editor.smartQuotes / editor.smartDashes 設定の配線契約。
 *
 * 旧実装は Typography 拡張を無条件ロードしており、設定トグル (default OFF)
 * と無関係に変換が常時 ON だった（設定UIのみ存在する配線漏れ）。この
 * テストは「設定が変換を実際に制御する」ことと「quotes/dashes 以外の
 * Typography 変換（ellipsis 等）は従来どおり常時 ON」を gate する。
 *
 * 入力ルールは IME を介さない handleTextInput 経路で発火するため、
 * ProseMirror の流儀どおり someProp("handleTextInput") で1文字ずつ
 * タイプをシミュレートする。
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

describe("typography settings gating", () => {
  let editor: Editor;

  beforeEach(() => {
    setSettings({
      "editor.smartQuotes": "false",
      "editor.smartDashes": "false",
    });
    editor = new Editor({ extensions: getEditorExtensions(), content: "" });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("smartQuotes OFF (default): straight quotes stay straight", () => {
    typeText(editor, '"');
    expect(editor.state.doc.textContent).toBe('"');
  });

  it("smartDashes OFF (default): -- stays as two hyphens", () => {
    typeText(editor, "--");
    expect(editor.state.doc.textContent).toBe("--");
  });

  it("smartQuotes ON: converts double and single quotes", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, '"');
    expect(editor.state.doc.textContent).toBe("“");
    typeText(editor, " '");
    expect(editor.state.doc.textContent).toBe("“ ‘");
  });

  // 上流 Typography の open ルールは英語専用の区切りクラス（空白・括弧等）
  // しか見ないため、日本語文字の直後の " が常に閉じグリフになっていた。
  // 開きは「CJK 直後も開き文脈」、閉じは「段落内の未クローズ開きがあれば
  // 閉じ」のパリティ判定で決める（B6 回帰ガード）。
  it("smartQuotes ON: opens after Japanese text and closes by pairing", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, '彼は"こんにちは"と言った');
    expect(editor.state.doc.textContent).toBe("彼は“こんにちは”と言った");
  });

  it("smartQuotes ON: keeps English behavior (word-final close, apostrophe)", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, `He said "don't panic"`);
    expect(editor.state.doc.textContent).toBe("He said “don’t panic”");
  });

  it("smartQuotes ON: single quotes pair in Japanese context", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, "強調は'ここ'だけ");
    expect(editor.state.doc.textContent).toBe("強調は‘ここ’だけ");
  });

  // apostrophe（語中の ’）は閉じグリフと同一文字のため、素朴にパリティを
  // 数えると開きを相殺してしまい、空白を挟んだ本来の閉じが開きに化ける
  // （`'can't '` → `‘can’t ‘`）。語中 close はパリティから除外する。
  it("smartQuotes ON: word-internal apostrophe does not poison pairing", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, "'can't '");
    expect(editor.state.doc.textContent).toBe("‘can’t ’");
  });

  it("smartQuotes ON: apostrophe inside a quoted phrase keeps the close", () => {
    setSettings({ "editor.smartQuotes": "true" });
    typeText(editor, "'don't go' she said");
    expect(editor.state.doc.textContent).toBe("‘don’t go’ she said");
  });

  it("smartDashes ON: converts -- to em dash", () => {
    setSettings({ "editor.smartDashes": "true" });
    typeText(editor, "--");
    expect(editor.state.doc.textContent).toBe("—");
  });

  it("other typography transforms stay always-on regardless of settings", () => {
    typeText(editor, "...");
    expect(editor.state.doc.textContent).toBe("…");
  });

  it("toggling at runtime affects the same editor instance (no recreation)", () => {
    typeText(editor, "--");
    expect(editor.state.doc.textContent).toBe("--");
    setSettings({ "editor.smartDashes": "true" });
    typeText(editor, " --");
    expect(editor.state.doc.textContent).toBe("-- —");
  });
});
