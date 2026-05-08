// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import {
  createTrashBinCapturePlugin,
  META_ORIGIN,
  META_PAUSED,
  META_SKIP,
} from "./TrashBinCapturePlugin";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import type {
  TextFragmentPayload,
  TrashOrigin,
} from "@/features/trash-bin/types";

function createTestEditor(content: string, origin: TrashOrigin | null) {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content,
  });
  editor.registerPlugin(createTrashBinCapturePlugin());
  if (origin !== null) {
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta(META_ORIGIN, origin);
        return true;
      })
      .run();
  }
  return editor;
}

function deleteRange(editor: Editor, from: number, to: number) {
  editor.view.dispatch(editor.state.tr.delete(from, to));
}

function pendingTexts(): string[] {
  return useTrashBinStore
    .getState()
    .pendingQueue.map((p) => (p.data.payload as TextFragmentPayload).text);
}

describe("TrashBinCapturePlugin", () => {
  beforeEach(() => {
    // store をリセット
    useTrashBinStore.setState({
      items: new Map(),
      pendingQueue: [],
      isCapturing: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("origin が設定されていなければキャプチャされない", () => {
    const editor = createTestEditor("<p>これはテスト文章です</p>", null);
    deleteRange(editor, 1, 5);
    expect(pendingTexts()).toEqual([]);
    editor.destroy();
  });

  it("Scene 削除はキャプチャされ、payload にテキストが入る", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>これはテスト文章です</p>", {
      kind: "scene",
      id: "scene-1",
    });
    deleteRange(editor, 1, 5); // 「これはテ」削除
    vi.advanceTimersByTime(600); // バッファ flush
    expect(pendingTexts()).toEqual(["これはテ"]);
    expect(useTrashBinStore.getState().pendingQueue[0].originSceneId).toBe(
      "scene-1",
    );
    editor.destroy();
  });

  it("Backspace 連打 (隣接削除) は 1 件に合体される", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    // 5 → 4 → 3 → 2 (Backspace = 右端から 1 文字ずつ削除、to が前回の from)
    deleteRange(editor, 5, 6); // 「お」
    deleteRange(editor, 4, 5); // 「え」
    deleteRange(editor, 3, 4); // 「う」
    deleteRange(editor, 2, 3); // 「い」
    vi.advanceTimersByTime(600); // 連打停止後 500ms で flush
    expect(pendingTexts()).toEqual(["いうえお"]);
    expect(useTrashBinStore.getState().pendingQueue.length).toBe(1);
    editor.destroy();
  });

  it("Delete 連打 (同じ位置から右削除) は 1 件に合体される", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    deleteRange(editor, 1, 2); // 「あ」 from=1, to=2
    deleteRange(editor, 1, 2); // 「い」 from=1, to=2 (同じ位置から続けて Delete)
    deleteRange(editor, 1, 2); // 「う」
    vi.advanceTimersByTime(600);
    expect(pendingTexts()).toEqual(["あいう"]);
    editor.destroy();
  });

  it("1 文字削除のみ (合体されず単独) はノイズとして破棄される", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    deleteRange(editor, 1, 2); // 「あ」のみ
    // バッファには入っているが、500ms 経って flush されると 2 文字未満で破棄
    vi.advanceTimersByTime(600);
    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
    editor.destroy();
  });

  it("複数段落の全選択削除 (Ctrl+A → Delete 相当) もキャプチャされる", () => {
    vi.useFakeTimers();
    // doc には 1 ブロック必要なので ProseMirror は空段落 1 個を含む slice を
    // 差し込んで全文を replace する。slice.size > 0 でも textBetween が空なら
    // 実質「全消し」として扱う。
    const editor = createTestEditor(
      "<p>段落いちのテキスト</p><p>段落にのテキスト</p>",
      { kind: "scene", id: "s1" },
    );
    const docSize = editor.state.doc.content.size;
    deleteRange(editor, 0, docSize);
    vi.advanceTimersByTime(600);
    const texts = pendingTexts();
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("段落いちのテキスト");
    expect(texts[0]).toContain("段落にのテキスト");
    editor.destroy();
  });

  it("挿入はキャプチャされない", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>テスト</p>", {
      kind: "scene",
      id: "s1",
    });
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText("追加", 1, 1);
        return true;
      })
      .run();
    vi.advanceTimersByTime(600);
    expect(pendingTexts()).toEqual([]);
    editor.destroy();
  });

  it("置換 (slice.size > 0) はキャプチャされない", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    // 範囲 1..5 を 「XYZ」 に置換
    editor.view.dispatch(editor.state.tr.insertText("XYZ", 1, 5));
    vi.advanceTimersByTime(600);
    expect(pendingTexts()).toEqual([]);
    editor.destroy();
  });

  it("paused === true の間はキャプチャされない", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "codex",
      id: "c1",
    });
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta(META_PAUSED, true);
        return true;
      })
      .run();
    deleteRange(editor, 1, 4);
    vi.advanceTimersByTime(600);
    expect(pendingTexts()).toEqual([]);
    editor.destroy();
  });

  it("META_SKIP / programmaticDelete が立った transaction はスキップ", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta(META_SKIP, true);
        tr.delete(1, 4);
        return true;
      })
      .run();
    vi.advanceTimersByTime(600);
    expect(pendingTexts()).toEqual([]);
    editor.destroy();
  });

  it("バッファ段階の Undo (history$) でフラッシュ前にバッファごと破棄", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    deleteRange(editor, 1, 4); // 「あいう」削除、まだバッファ段階
    // バッファ flush 前 (500ms 未満) に Undo
    vi.advanceTimersByTime(100);
    editor.view.dispatch(
      editor.state.tr.setMeta("history$", { redo: false, undo: true }),
    );
    vi.advanceTimersByTime(600); // 残り時間進めても flush されない
    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
    editor.destroy();
  });

  it("pendingQueue 段階の Undo でも保留が破棄される", () => {
    vi.useFakeTimers();
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    deleteRange(editor, 1, 4);
    vi.advanceTimersByTime(600); // バッファ flush → pending に入る
    expect(useTrashBinStore.getState().pendingQueue.length).toBe(1);

    editor.view.dispatch(
      editor.state.tr.setMeta("history$", { redo: false, undo: true }),
    );
    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
    editor.destroy();
  });

  it("isCapturing === false の間は enqueue されない", () => {
    useTrashBinStore.setState({ isCapturing: false });
    const editor = createTestEditor("<p>あいうえお</p>", {
      kind: "scene",
      id: "s1",
    });
    // 削除自体は走り flush 試行までいくが、enqueuePending 内で isCapturing 判定で no-op
    vi.useFakeTimers();
    deleteRange(editor, 1, 4);
    vi.advanceTimersByTime(600);
    expect(useTrashBinStore.getState().pendingQueue).toEqual([]);
    editor.destroy();
  });
});
