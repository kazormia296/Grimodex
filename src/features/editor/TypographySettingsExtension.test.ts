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
