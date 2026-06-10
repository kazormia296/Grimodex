// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorStatsFooter } from "./EditorStatsFooter";
import { useTreeStore } from "@/features/tree/treeStore";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(async () => ({})),
}));

function createTestEditor(content = "<p>こんにちは</p>") {
  return new Editor({
    extensions: [StarterKit],
    content,
  });
}

describe("EditorStatsFooter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds counts when loading completes", () => {
    const editor = createTestEditor("<p>あいうえお</p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={false}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId("char-count").textContent).toContain("5 chars");
    editor.destroy();
  });

  it("recomputes after typing with a 200ms trailing debounce", () => {
    const editor = createTestEditor("<p></p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={false}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId("char-count").textContent).toContain("0 chars");

    act(() => {
      editor.commands.insertContent("こんにちは");
    });
    // debounce 未経過: まだ更新されない
    expect(screen.getByTestId("char-count").textContent).toContain("0 chars");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("char-count").textContent).toContain("5 chars");
    editor.destroy();
  });

  it("syncs charCount to tree store for scenes (at fire time)", () => {
    const setCharCount = vi.fn();
    useTreeStore.setState({
      setCharCount: setCharCount as never,
    });
    const editor = createTestEditor("<p></p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={true}
        isLoading={false}
      />,
    );
    setCharCount.mockClear(); // ロード時シードの分を除く

    act(() => {
      editor.commands.insertContent("あい");
    });
    expect(setCharCount).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(setCharCount).toHaveBeenCalledWith("scene-1", 2);
    editor.destroy();
  });

  it("does not sync to tree store for codex/snippet content", () => {
    const setCharCount = vi.fn();
    useTreeStore.setState({
      setCharCount: setCharCount as never,
    });
    const editor = createTestEditor("<p>あ</p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "codex-1"}
        syncToTree={false}
        isLoading={false}
      />,
    );
    act(() => {
      editor.commands.insertContent("い");
      vi.advanceTimersByTime(200);
    });
    expect(setCharCount).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("coalesces a typing burst into a single recompute (perf contract)", () => {
    const setCharCount = vi.fn();
    useTreeStore.setState({
      setCharCount: setCharCount as never,
    });
    const editor = createTestEditor("<p></p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={true}
        isLoading={false}
      />,
    );
    setCharCount.mockClear();

    // 200ms 窓内の連打は trailing debounce で 1 回の full-doc walk に畳む
    act(() => {
      editor.commands.insertContent("あ");
      vi.advanceTimersByTime(100);
      editor.commands.insertContent("い");
      vi.advanceTimersByTime(100);
      editor.commands.insertContent("う");
      vi.advanceTimersByTime(200);
    });
    expect(setCharCount).toHaveBeenCalledTimes(1);
    expect(setCharCount).toHaveBeenCalledWith("scene-1", 3);
    editor.destroy();
  });

  it("cleans up a pending timer on unmount without errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const editor = createTestEditor("<p></p>");
    const { unmount } = render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={false}
        isLoading={false}
      />,
    );
    act(() => {
      editor.commands.insertContent("あ");
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    editor.destroy();
  });

  it("rebinds the update subscription when the editor instance is swapped", () => {
    const editorA = createTestEditor("<p></p>");
    const editorB = createTestEditor("<p>あいうえお</p>");
    const props = {
      getSyncSceneId: () => "scene-1",
      syncToTree: false,
      isLoading: false,
    };
    const { rerender } = render(
      <EditorStatsFooter editor={editorA as never} {...props} />,
    );
    rerender(<EditorStatsFooter editor={editorB as never} {...props} />);
    // 差し替えで B の値に再シードされる
    expect(screen.getByTestId("char-count").textContent).toContain("5 chars");

    // 旧 editor A への編集はもう反映されない
    act(() => {
      editorA.commands.insertContent("xxxxxxxxxx");
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("char-count").textContent).toContain("5 chars");

    // 新 editor B への編集は反映される
    act(() => {
      editorB.commands.insertContent("か");
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("char-count").textContent).toContain("6 chars");
    editorA.destroy();
    editorB.destroy();
  });

  it("reads the sync scene id at fire time (not at keystroke time)", () => {
    const setCharCount = vi.fn();
    useTreeStore.setState({
      setCharCount: setCharCount as never,
    });
    let currentSceneId = "scene-A";
    const editor = createTestEditor("<p></p>");
    render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => currentSceneId}
        syncToTree={true}
        isLoading={false}
      />,
    );
    setCharCount.mockClear();

    // キーストローク後 200ms 以内に scene が切り替わったケース:
    // 旧実装はキーストローク時の id にキャプチャしていたため
    // 旧 scene へ新 doc の count を書く cross-scene 汚染があった。
    act(() => {
      editor.commands.insertContent("あ");
      currentSceneId = "scene-B";
      vi.advanceTimersByTime(200);
    });
    expect(setCharCount).toHaveBeenCalledWith("scene-B", 1);
    editor.destroy();
  });

  it("waits while loading and seeds when isLoading flips to false", () => {
    const editor = createTestEditor("<p>あいう</p>");
    const { rerender } = render(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={false}
        isLoading={true}
      />,
    );
    expect(screen.getByTestId("char-count").textContent).toContain("0 chars");

    rerender(
      <EditorStatsFooter
        editor={editor as never}
        getSyncSceneId={() => "scene-1"}
        syncToTree={false}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId("char-count").textContent).toContain("3 chars");
    editor.destroy();
  });
});
