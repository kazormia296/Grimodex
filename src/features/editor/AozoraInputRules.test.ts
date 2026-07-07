// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";
import { useSettingsStore } from "@/features/settings/settingsStore";

/**
 * 青空文庫記法の入力時自動変換 (`editor.aozoraInput`) の配線契約。
 *
 * InputRule は IME を介さない handleTextInput 経路で発火するため、
 * someProp("handleTextInput") で1文字ずつタイプをシミュレートする
 * (TypographySettingsExtension.test.ts と同じハーネス)。
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

function rubyNodes(
  editor: Editor,
): Array<{ base: string; annotation: string }> {
  const out: Array<{ base: string; annotation: string }> = [];
  editor.state.doc.descendants((node: ProseMirrorNode) => {
    if (node.type.name === "ruby") {
      out.push({
        base: node.attrs.base as string,
        annotation: node.attrs.annotation as string,
      });
    }
  });
  return out;
}

function hasEmphasisDots(editor: Editor, text: string): boolean {
  let found = false;
  editor.state.doc.descendants((node: ProseMirrorNode) => {
    if (
      node.isText &&
      node.text === text &&
      node.marks.some((m) => m.type.name === "emphasisDots")
    ) {
      found = true;
    }
  });
  return found;
}

describe("aozora input rules", () => {
  let editor: Editor;

  beforeEach(() => {
    setSettings({
      "editor.aozoraInput": "true",
      // 他の入力ルールを無効化して分離
      "editor.smartQuotes": "false",
      "editor.smartDashes": "false",
      "editor.autoPairBrackets": "false",
    });
    editor = new Editor({ extensions: getEditorExtensions(), content: "" });
  });

  afterEach(() => {
    editor.destroy();
  });

  it("pipe ruby ｜base《reading》 → ruby node", () => {
    typeText(editor, "｜東雲《しののめ》");
    expect(rubyNodes(editor)).toEqual([
      { base: "東雲", annotation: "しののめ" },
    ]);
    // 記法文字はドキュメントに残らない (ruby は atom で textContent 空)
    expect(editor.state.doc.textContent).toBe("");
  });

  it("auto ruby 漢字《reading》 → ruby node (直前の連続漢字が base)", () => {
    typeText(editor, "漢字《かんじ》");
    expect(rubyNodes(editor)).toEqual([{ base: "漢字", annotation: "かんじ" }]);
    expect(editor.state.doc.textContent).toBe("");
  });

  it("emphasis dots 《《text》》 → emphasisDots mark", () => {
    typeText(editor, "《《強調》》");
    expect(editor.state.doc.textContent).toBe("強調");
    expect(hasEmphasisDots(editor, "強調")).toBe(true);
    expect(rubyNodes(editor)).toEqual([]);
  });

  it("auto-ruby base spans a contiguous kanji run including ヶ (霞ヶ関)", () => {
    typeText(editor, "霞ヶ関《かすみがせき》");
    expect(rubyNodes(editor)).toEqual([
      { base: "霞ヶ関", annotation: "かすみがせき" },
    ]);
  });

  it("mixes ruby with following text", () => {
    typeText(editor, "東雲《しののめ》の空");
    expect(rubyNodes(editor)).toEqual([
      { base: "東雲", annotation: "しののめ" },
    ]);
    expect(editor.state.doc.textContent).toBe("の空");
  });

  it("OFF: leaves notation as literal text", () => {
    setSettings({ "editor.aozoraInput": "false" });
    typeText(editor, "漢字《かんじ》");
    expect(rubyNodes(editor)).toEqual([]);
    expect(editor.state.doc.textContent).toBe("漢字《かんじ》");
  });

  it("toggling at runtime affects the same editor instance", () => {
    setSettings({ "editor.aozoraInput": "false" });
    typeText(editor, "漢字《かんじ》");
    expect(rubyNodes(editor)).toEqual([]);
    setSettings({ "editor.aozoraInput": "true" });
    typeText(editor, "、月《つき》");
    expect(rubyNodes(editor)).toEqual([{ base: "月", annotation: "つき" }]);
  });
});
