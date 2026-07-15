// @vitest-environment happy-dom
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexMatchRow } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { RubyNode } from "./RubyNode";
import { Toolbar, type ToolbarActions } from "./Toolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type ReadingTarget = CodexMatchRow & { readings: string | null };

function target(
  name: string,
  aliases: string | null,
  readings: string | null,
  id = name,
): ReadingTarget {
  return {
    id,
    name,
    type: "character",
    aliases,
    excludedAliases: null,
    readings,
  };
}

function createEditor(text: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit, RubyNode],
    content: `<p>${text}</p>`,
  });
  editor.commands.setTextSelection({ from: 1, to: text.length + 1 });
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
    left: 10,
    right: 10,
    top: 10,
    bottom: 20,
  });
  return editor;
}

function openRuby(editor: Editor, targets: ReadingTarget[]): void {
  useCodexStore.setState({ completionTargets: targets });
  const actionsRef = createRef<ToolbarActions>();
  render(
    <Toolbar
      editor={editor}
      onFindReplace={() => {}}
      actionsRef={actionsRef}
    />,
  );
  act(() => actionsRef.current?.openRuby());
}

afterEach(() => {
  cleanup();
  useCodexStore.setState({ completionTargets: [] });
});

describe("Toolbar Codex reading ruby", () => {
  it("選択文字が Codex 名なら代表読みでルビを即時付与する", () => {
    const editor = createEditor("刹那");

    openRuby(editor, [
      target("刹那", '["セツナ"]', '{"刹那":["せつな","せちな"]}'),
    ]);

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "刹那", annotation: "せつな" } },
    ]);
    expect(
      screen.queryByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).not.toBeInTheDocument();
    editor.destroy();
  });

  it("選択文字が alias なら alias 自身の読みで即時付与する", () => {
    const editor = createEditor("剣聖");

    openRuby(editor, [
      target("刹那", '["剣聖"]', '{"刹那":["せつな"],"剣聖":["けんせい"]}'),
    ]);

    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "剣聖", annotation: "けんせい" } },
    ]);
    editor.destroy();
  });

  it("読みが未設定なら従来どおり入力ダイアログを開く", () => {
    const editor = createEditor("未知");

    openRuby(editor, [target("未知", null, null)]);

    expect(screen.getByPlaceholderText("editor.toolbar.rubyBase")).toHaveValue(
      "未知",
    );
    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "未知" },
    ]);
    editor.destroy();
  });

  it("同じ表記に異なる読みがある場合は自動付与せず入力ダイアログを開く", () => {
    const editor = createEditor("霞");

    openRuby(editor, [
      target("霞", null, '{"霞":["かすみ"]}', "first"),
      target("霞姫", '["霞"]', '{"霞":["かすみひめ"]}', "second"),
    ]);

    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "霞" },
    ]);
    editor.destroy();
  });

  it("hard break を跨ぐ見かけ上同じ表記は自動置換しない", () => {
    const editor = new Editor({
      extensions: [StarterKit, RubyNode],
      content: "<p>刹<br>那</p>",
    });
    editor.commands.setTextSelection({ from: 1, to: 4 });
    expect(editor.state.doc.textBetween(1, 4)).toBe("刹那");
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 10,
      right: 10,
      top: 10,
      bottom: 20,
    });

    openRuby(editor, [target("刹那", null, '{"刹那":["せつな"]}')]);

    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "text", text: "刹" },
      { type: "hardBreak" },
      { type: "text", text: "那" },
    ]);
    editor.destroy();
  });

  it("既存ルビの編集では Codex 読みで上書きせず現在値をダイアログに表示する", () => {
    const editor = new Editor({
      extensions: [StarterKit, RubyNode],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "ruby",
                attrs: { base: "刹那", annotation: "せちな" },
              },
            ],
          },
        ],
      },
    });
    editor.commands.setNodeSelection(1);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 10,
      right: 10,
      top: 10,
      bottom: 20,
    });

    openRuby(editor, [target("刹那", null, '{"刹那":["せつな"]}')]);

    expect(screen.getByPlaceholderText("editor.toolbar.rubyBase")).toHaveValue(
      "刹那",
    );
    expect(
      screen.getByPlaceholderText("editor.toolbar.rubyAnnotation"),
    ).toHaveValue("せちな");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "ruby", attrs: { base: "刹那", annotation: "せちな" } },
    ]);
    editor.destroy();
  });
});
