// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { getDocText } from "@/features/editor/RubyNode";

// リニアモードの本文消失バグの回帰テスト (コンポーネント結合)。
// - 読み込み成功: doc が保持され、編集後の unmount flush は persistSceneBody
//   (保存正本) に到達する。
// - 読み込み失敗 (スキーマ未知ノード等): editable が落ち、autosave/flush が
//   保存を **スキップ** する — 失敗 doc の保存こそが本文を空で上書きする
//   消失経路だったため、これが最終防衛線。
// - file-backed scene は EditorPane と同じ縮小スキーマ (taskList あり) を使う。

const { mockLoadSceneFull, mockPersist, mockToastError, createdEditors } =
  vi.hoisted(() => ({
    mockLoadSceneFull: vi.fn(),
    mockPersist: vi.fn().mockResolvedValue(undefined),
    mockToastError: vi.fn(),
    createdEditors: [] as unknown[],
  }));

// 実 Editor (headless) を使う: スキーマ選択と setContent の挙動こそが
// テスト対象。useEditor / EditorContent (PM view の DOM mount) だけ
// 差し替え、ReactNodeViewRenderer 等は実物を残す (partial mock)。
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  const { Editor } = await import("@tiptap/core");
  const { useState, useEffect } = await import("react");
  return {
    ...actual,
    useEditor: (config: Record<string, unknown>, _deps?: unknown[]) => {
      const [editor] = useState(() => {
        const e = new Editor(config as never);
        createdEditors.push(e);
        return e;
      });
      useEffect(() => {
        return () => {
          editor.destroy();
        };
      }, [editor]);
      return editor;
    },
    EditorContent: () => <div data-testid="editor-content" />,
  };
});

vi.mock("@/features/tree/api", () => ({
  loadSceneFull: mockLoadSceneFull,
}));
vi.mock("@/features/editor/persistSceneBody", () => ({
  persistSceneBody: mockPersist,
}));
vi.mock("@/features/attribution/api", () => ({
  loadAuthorshipSpans: vi.fn().mockResolvedValue([]),
  spansToMarkData: vi.fn().mockReturnValue([]),
}));
vi.mock("@/features/editor/useCodexHighlight", () => ({
  useCodexHighlight: vi.fn(),
}));
vi.mock("@/features/attribution/useAttribution", () => ({
  useAttribution: vi.fn(),
}));
vi.mock("@/features/editor/useCharacterFade", () => ({
  useCharacterFade: vi.fn(),
}));
vi.mock("@/features/license/useLicenseEditableSync", () => ({
  useLicenseEditableSync: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

// 実装は本物の useAutoSave を使いつつ、テストから pending を arm できるよう
// 最後に生成されたインスタンスを捕捉する (render〜effect 間の arm 窓は
// テストから直接は再現できないため)。
const autoSaveCtl = vi.hoisted(
  () =>
    ({ last: null }) as {
      last: { schedule: () => void } | null;
    },
);
vi.mock("@/hooks/useAutoSave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAutoSave")>();
  return {
    ...actual,
    useAutoSave: (saveFn: () => Promise<void>, delayMs?: number) => {
      const inst = actual.useAutoSave(saveFn, delayMs);
      autoSaveCtl.last = inst;
      return inst;
    },
  };
});
vi.mock("@/features/settings/hooks/useEditorSettings", () => ({
  useEditorSettings: () => ({
    autoSaveDelay: 600000,
    showLineNumbers: false,
    linearBeatDisplay: "full",
    fontFamily: "serif",
    fontSize: 16,
    lineHeight: 1.8,
    maxContentWidth: 800,
    wordBreak: "normal",
    lineBreak: "auto",
    paragraphIndent: 0,
  }),
}));

const isFileBackedNodeMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: isFileBackedNodeMock,
}));

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", StubResizeObserver);

import { LinearSceneBlock } from "./LinearSceneBlock";

const MENTION_CONTENT = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "主人公は" },
        { type: "mention", attrs: { id: "entry-1", label: "アリス" } },
        { type: "text", text: "と出会った。" },
      ],
    },
  ],
});

const TASKLIST_CONTENT = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "GFM タスク本文" }],
            },
          ],
        },
      ],
    },
  ],
});

const ALIEN_CONTENT = JSON.stringify({
  type: "doc",
  content: [{ type: "node-from-the-future" }],
});

function lastEditor(): Editor {
  return createdEditors[createdEditors.length - 1] as Editor;
}

function renderBlock() {
  return render(
    <LinearSceneBlock
      sceneId="scene-0001"
      isMounted={true}
      isActive={false}
      placeholderHeight={300}
      onHeightChange={() => {}}
      onFocus={() => {}}
    />,
  );
}

beforeEach(() => {
  mockLoadSceneFull.mockReset();
  mockPersist.mockClear();
  mockToastError.mockClear();
  isFileBackedNodeMock.mockReturnValue(false);
  createdEditors.length = 0;
});

describe("LinearSceneBlock: 本文消失ガード", () => {
  it("mention 入りシーンを失わずロードし、編集後の unmount flush は persistSceneBody に到達する", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { unmount } = renderBlock();

    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });
    expect(lastEditor().isEditable).toBe(true);
    expect(mockToastError).not.toHaveBeenCalled();

    // ユーザー編集 → autosave pending → unmount flush → 保存正本へ
    lastEditor().commands.insertContentAt(1, "追記");
    unmount();
    expect(mockPersist).toHaveBeenCalledWith("scene-0001", expect.anything());
  });

  it("スキーマ未知ノードで読み込み失敗したら editable を落とし、保存をスキップする", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: ALIEN_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { unmount } = renderBlock();

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(lastEditor().isEditable).toBe(false);

    // 仮に doc が編集されても (commands は editable を無視する)、
    // 失敗 doc の保存 = 本文の空上書きなので flush は skip される。
    lastEditor().commands.insertContentAt(0, "x");
    unmount();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("setEditable の doc 未変更 'update' では autosave が arm されない", async () => {
    // TipTap の setEditable は既定で 'update' を emit する (steps 空)。
    // これが schedule を arm すると「編集していないのに保存」が走り、
    // 未ロード窓では本文消失の引き金になる (実機で useLicenseEditableSync の
    // mount 同期が踏んでいた経路)。docChanged ゲートの回帰テスト。
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { unmount } = renderBlock();
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });

    // doc を変えずに 'update' を emit (license 同期と同じ呼び方)
    lastEditor().setEditable(false);
    lastEditor().setEditable(true);
    unmount();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("ロード完了前に autosave が arm されても unmount flush は空 doc を保存しない", async () => {
    // ロードを解決しないことで「未ロード窓」を固定する。実機ログでは
    // EditorPane 側の同型の穴 (mount 直後の空エディタ + ロード前に arm された
    // pending + switchScene 冒頭の flush) が空 doc を DB に書き込み
    // 「リニアモード解除で本文全消失」になっていた。未ロード doc の保存禁止
    // (loadFailedRef 初期値 true) は mount 時点から効く必要がある。
    mockLoadSceneFull.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderBlock();

    // 未ロード窓で autosave が arm されたケース (arm 経路は問わない)
    autoSaveCtl.last!.schedule();
    unmount();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("file-backed シーンは縮小スキーマでロードされ taskList を保持する", async () => {
    isFileBackedNodeMock.mockReturnValue(true);
    mockLoadSceneFull.mockResolvedValue({
      content: TASKLIST_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    renderBlock();

    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("GFM タスク本文");
    });
    expect(lastEditor().schema.nodes.taskList).toBeDefined();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
