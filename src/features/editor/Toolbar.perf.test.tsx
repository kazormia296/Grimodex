// @vitest-environment happy-dom
/**
 * Toolbar のタイピング経路 perf 回帰テスト。
 *
 * 旧実装は transaction/selectionUpdate ごとに tick state を進めて Toolbar
 * 全体（862行）を毎キーストローク再レンダーしていた。現在は useEditorState
 * (deepEqual) で isActive フラグ群だけを購読しており、平文タイピングでは
 * 再レンダーされないことを Profiler のコミット回数で gate する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Profiler } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Toolbar } from "./Toolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function createTestEditor(content = "<p>こんにちは</p>") {
  return new Editor({
    extensions: [StarterKit],
    content,
  });
}

describe("Toolbar typing-path re-renders", () => {
  afterEach(() => {
    cleanup();
  });

  function renderWithProfiler(editor: Editor) {
    const counter = { commits: 0 };
    render(
      <Profiler
        id="toolbar"
        onRender={() => {
          counter.commits++;
        }}
      >
        <Toolbar editor={editor as never} onFindReplace={() => {}} />
      </Profiler>,
    );
    return counter;
  }

  it("does not re-render on plain-text typing transactions", () => {
    const editor = createTestEditor();
    const counter = renderWithProfiler(editor);
    const base = counter.commits;

    act(() => {
      editor.commands.insertContent("あ");
    });
    act(() => {
      editor.commands.insertContent("い");
    });
    act(() => {
      editor.commands.insertContent("う");
    });

    expect(counter.commits).toBe(base);
    editor.destroy();
  });

  it("re-renders when an isActive flag actually flips (bold toggle)", () => {
    const editor = createTestEditor();
    const counter = renderWithProfiler(editor);
    const base = counter.commits;

    act(() => {
      // 空選択での toggleBold は storedMarks を立て isActive("bold") が反転する
      editor.commands.toggleBold();
    });

    expect(counter.commits).toBeGreaterThan(base);
    editor.destroy();
  });

  it("does not re-render on cursor movement within uniform formatting", () => {
    const editor = createTestEditor("<p>こんにちは世界</p>");
    const counter = renderWithProfiler(editor);
    const base = counter.commits;

    act(() => {
      editor.commands.setTextSelection(3);
    });
    act(() => {
      editor.commands.setTextSelection(5);
    });

    expect(counter.commits).toBe(base);
    editor.destroy();
  });
});
