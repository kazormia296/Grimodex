// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
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
    paragraphSpacing: 8,
    spellCheck: false,
  }),
}));

const isFileBackedNodeMock = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: isFileBackedNodeMock,
}));

// tabStore は layoutStore→codexStore の eager 連鎖を引き込むため最小モック。
// dirty 配線 (setTabDirty 呼び出し) はこの spy で assert する。
const mockSetTabDirty = vi.hoisted(() => vi.fn());
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({ setTabDirty: mockSetTabDirty }),
  },
}));
// conflict バナーは i18n + tabStore に依存するので描画だけ落とす
// (バナー自体の挙動は ExternalEditConflictBanner 側の責務)。
vi.mock("@/features/editor/ExternalEditConflictBanner", () => ({
  ExternalEditConflictBanner: () => null,
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

import { useLinearEditorStore } from "./linearEditorStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

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
  mockSetTabDirty.mockClear();
  isFileBackedNodeMock.mockReturnValue(false);
  createdEditors.length = 0;
  useExternalWriteStore.getState().clear();
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

  it("mount で editor registry に登録され、unmount で解除される", async () => {
    // Toolbar / SceneMetaPanel が「active シーンの editor」をフォーカス無しで
    // 引くための registry (フォーカス依存だとリニア入場直後にツールバーが
    // 消える)。
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { unmount } = renderBlock();
    await waitFor(() => {
      expect(
        useLinearEditorStore.getState().editorsById["scene-0001"],
      ).toBeDefined();
    });
    expect(useLinearEditorStore.getState().editorsById["scene-0001"]).toBe(
      lastEditor(),
    );
    unmount();
    expect(
      useLinearEditorStore.getState().editorsById["scene-0001"],
    ).toBeUndefined();
  });

  it("ロード完了まで skeleton を表示し、完了後に本文と文字数を出す", async () => {
    let resolveLoad!: (v: {
      content: string;
      unplacedBeatsDoc: string;
    }) => void;
    mockLoadSceneFull.mockReturnValue(
      new Promise((res) => {
        resolveLoad = res;
      }),
    );
    const { container } = renderBlock();

    // ロード中: skeleton が出て、本文/文字数 ("0 chars") は invisible で隠れる
    // (textContent には残るので可視性はクラスで assert する)
    expect(
      container.querySelector("[data-testid='editor-content-loading']"),
    ).not.toBeNull();
    const hiddenWrap = container.querySelector(".invisible");
    expect(hiddenWrap).not.toBeNull();
    expect(hiddenWrap!.textContent).toContain("0 chars");

    resolveLoad({ content: MENTION_CONTENT, unplacedBeatsDoc: "[]" });
    await waitFor(() => {
      expect(
        container.querySelector("[data-testid='editor-content-loading']"),
      ).toBeNull();
    });
    expect(container.textContent).toContain("chars");
  });

  it("editor.spellCheck 設定が本文ラッパーの spellcheck 属性に届く", async () => {
    // 設定UIのみ存在し contenteditable に届かなかった配線漏れの regression
    // gate。spellcheck は属性継承するため、ラッパー div に付けば中の
    // contenteditable に効く。
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { container } = renderBlock();
    await waitFor(() => {
      expect(container.querySelector("div[spellcheck]")).not.toBeNull();
    });
    expect(
      container.querySelector("div[spellcheck]")!.getAttribute("spellcheck"),
    ).toBe("false");
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

// リニアモードが flush/dirty/resync インフラ (editorSaveRegistry /
// dirtyTabIds / sceneContentStore / reload-scene / reloadNonce) に乗っている
// ことの回帰テスト。未配線だと: agent 書き込み・Codex 改名波及が stale DB を
// read-modify-write して直近編集を消す / 外部ファイル変更が未保存編集を
// サイレント上書きする / 取り込み・resync が editor doc に届かず次の autosave
// が外部変更を巻き戻す — いずれも本文消失級 (2026-06-12 横断レビュー)。
describe("LinearSceneBlock: flush/dirty/resync インフラ配線", () => {
  async function renderLoaded() {
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const utils = renderBlock();
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });
    return utils;
  }

  it("saveScene(sceneId) で外部から flush できる (editorSaveRegistry 配線)", async () => {
    const { unmount } = await renderLoaded();
    const { registeredSaveHandlerIds } =
      await import("@/features/editor/editorSaveRegistry");
    expect(registeredSaveHandlerIds()).toContain("scene-0001");

    lastEditor().commands.insertContentAt(1, "追記");
    await saveScene("scene-0001");
    expect(mockPersist).toHaveBeenCalledWith("scene-0001", expect.anything());

    unmount();
    expect(registeredSaveHandlerIds()).not.toContain("scene-0001");
  });

  it("編集で dirty を立て、保存成功と unmount で解除する (dirtyTabIds 配線)", async () => {
    const { unmount } = await renderLoaded();
    expect(mockSetTabDirty).not.toHaveBeenCalledWith("scene-0001", true);

    lastEditor().commands.insertContentAt(1, "追記");
    expect(mockSetTabDirty).toHaveBeenCalledWith("scene-0001", true);

    mockSetTabDirty.mockClear();
    await saveScene("scene-0001");
    expect(mockSetTabDirty).toHaveBeenCalledWith("scene-0001", false);

    mockSetTabDirty.mockClear();
    unmount();
    expect(mockSetTabDirty).toHaveBeenCalledWith("scene-0001", false);
  });

  it("保存スキップ時 (未ロード窓) は dirty を解除しない", async () => {
    mockLoadSceneFull.mockReturnValue(new Promise(() => {}));
    renderBlock();
    await waitFor(() => {
      expect(createdEditors.length).toBeGreaterThan(0);
    });
    await saveScene("scene-0001");
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockSetTabDirty).not.toHaveBeenCalledWith("scene-0001", false);
  });

  it("setLiveContent (agent 書き込み/改名波及の resync) を editor doc に反映する", async () => {
    await renderLoaded();
    const RESYNC_GROUP = -1; // autoApplyProse / renameEngine の sentinel
    useSceneContentStore.getState().setLiveContent(
      "scene-0001",
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "エージェントが追記した本文" }],
          },
        ],
      },
      RESYNC_GROUP,
    );
    // rAF coalesce 越しに doc が追従する
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain(
        "エージェントが追記した本文",
      );
    });
    // emitUpdate:false なので resync 自体は autosave を arm しない
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("external-mount:reload-scene で取り込み内容を反映し dirty を解除する", async () => {
    await renderLoaded();
    const RELOADED = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "外部エディタで書き換えた本文" }],
        },
      ],
    });
    mockSetTabDirty.mockClear();
    window.dispatchEvent(
      new CustomEvent("external-mount:reload-scene", {
        detail: { sceneId: "scene-0001", content: RELOADED },
      }),
    );
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain(
        "外部エディタで書き換えた本文",
      );
    });
    expect(mockSetTabDirty).toHaveBeenCalledWith("scene-0001", false);
  });

  it("別シーン宛の reload-scene は無視する", async () => {
    await renderLoaded();
    window.dispatchEvent(
      new CustomEvent("external-mount:reload-scene", {
        detail: { sceneId: "other-scene", content: "{}" },
      }),
    );
    expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
  });

  it("reloadNonce が進んだら DB から再ロードする (外部 write feed 配線)", async () => {
    await renderLoaded();
    expect(mockLoadSceneFull).toHaveBeenCalledTimes(1);
    useExternalWriteStore.getState().bumpReloadNonce("scene-0001");
    await waitFor(() => {
      expect(mockLoadSceneFull).toHaveBeenCalledTimes(2);
    });
  });
});

// perf 契約: タイピング中の文字数同期は 200ms trailing debounce で 1 回に
// 畳む (EditorStatsFooter と同じ)。毎打鍵で getDocText の O(doc) 全文走査と
// setCharCount によるブロック全体再レンダーを払わない — EditorPane では
// 5675145c で除去済みの固定費がリニア経路に残っていた回帰の gate。
describe("LinearSceneBlock: 文字数同期の debounce (perf 契約)", () => {
  it("打鍵バーストを 1 回の charCount 同期に畳み、200ms 休止後に表示へ反映する", async () => {
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { container, unmount } = render(
      <LinearSceneBlock
        sceneId="scene-0001"
        isMounted={true}
        isActive={false}
        placeholderHeight={300}
        onHeightChange={() => {}}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });
    const loadedCount = getDocText(lastEditor().state.doc).length;
    expect(container.textContent).toContain(
      `${loadedCount.toLocaleString()} chars`,
    );

    const origSetCharCount = useTreeStore.getState().setCharCount;
    const mockSetCharCount = vi.fn();
    useTreeStore.setState({ setCharCount: mockSetCharCount as never });
    vi.useFakeTimers();
    try {
      // 200ms 窓内の連打: tree 同期はまだ走らず、表示も据え置き
      act(() => {
        lastEditor().commands.insertContentAt(1, "あ");
        vi.advanceTimersByTime(100);
        lastEditor().commands.insertContentAt(1, "い");
        vi.advanceTimersByTime(100);
        lastEditor().commands.insertContentAt(1, "う");
      });
      expect(mockSetCharCount).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        `${loadedCount.toLocaleString()} chars`,
      );

      // 休止 200ms で 1 回だけ full-doc walk + 同期
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(mockSetCharCount).toHaveBeenCalledTimes(1);
      expect(mockSetCharCount).toHaveBeenCalledWith(
        "scene-0001",
        loadedCount + 3,
      );
      expect(container.textContent).toContain(
        `${(loadedCount + 3).toLocaleString()} chars`,
      );
    } finally {
      vi.useRealTimers();
      useTreeStore.setState({ setCharCount: origSetCharCount as never });
    }
    unmount();
  });

  it("pending の debounce タイマーは unmount 後に charCount 同期を発火しない", async () => {
    // console.error 監視は React 19 が unmount 後 setState に警告を出さない
    // ためヴァキュアス (mutation レビューで確認)。「unmount 後に tree 同期が
    // 走らない」を直接 assert する — cleanup の clearTimeout と isDestroyed
    // ガードの両方が消えたときに確実に落ちる。
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const { unmount } = render(
      <LinearSceneBlock
        sceneId="scene-0001"
        isMounted={true}
        isActive={false}
        placeholderHeight={300}
        onHeightChange={() => {}}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });
    const origSetCharCount = useTreeStore.getState().setCharCount;
    const mockSetCharCount = vi.fn();
    useTreeStore.setState({ setCharCount: mockSetCharCount as never });
    vi.useFakeTimers();
    try {
      lastEditor().commands.insertContentAt(1, "あ");
      unmount();
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(mockSetCharCount).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      useTreeStore.setState({ setCharCount: origSetCharCount as never });
    }
  });
});
