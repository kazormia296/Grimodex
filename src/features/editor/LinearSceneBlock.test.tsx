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

const {
  mockLoadSceneFull,
  mockPersist,
  mockToastError,
  mockToastInfo,
  createdEditors,
} = vi.hoisted(() => ({
  mockLoadSceneFull: vi.fn(),
  mockPersist: vi.fn().mockResolvedValue(undefined),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
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
  toast: { error: mockToastError, info: mockToastInfo },
}));

// Inline AI の配線テスト。実 generate は network を叩くため useInlineAiDiff を
// スパイ化し、「スラッシュ → generate / palette / オーナーゲート」の配線だけを
// 検証する。Toolbar / Palette は状態ゲートを持つ重いコンポーネントなので
// 振る舞いを露出する最小スタブに差し替える。
const inlineAiSpies = vi.hoisted(() => ({
  generate: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  rejectOrAbort: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("@/features/editor/inlineAi/useInlineAiDiff", () => ({
  useInlineAiDiff: () => ({
    generate: inlineAiSpies.generate,
    accept: inlineAiSpies.accept,
    reject: inlineAiSpies.reject,
    rejectOrAbort: inlineAiSpies.rejectOrAbort,
    retry: inlineAiSpies.retry,
    showProvidedText: vi.fn(),
    getActiveStagingId: () => null,
  }),
}));
const mockBuildContext = vi.hoisted(() => vi.fn(() => ({ sentinel: "ctx" })));
vi.mock("@/features/editor/inlineAi/inlineAiContext", () => ({
  buildInlineAiContext: mockBuildContext,
}));
vi.mock("@/features/editor/inlineAi/InlineAIToolbar", () => ({
  InlineAIToolbar: ({
    onAccept,
    onReject,
    onRetry,
  }: {
    onAccept: () => void;
    onReject: () => void;
    onRetry: () => void;
  }) => (
    <div data-testid="inline-ai-toolbar">
      <button data-testid="ai-accept" onClick={onAccept} />
      <button data-testid="ai-reject" onClick={onReject} />
      <button data-testid="ai-retry" onClick={onRetry} />
    </div>
  ),
}));
vi.mock("@/features/editor/inlineAi/InlineAIPalette", () => ({
  InlineAIPalette: ({
    open,
    preselectedCommand,
    onSubmit,
    onClose,
  }: {
    open: boolean;
    preselectedCommand: { id: string } | null;
    onSubmit: (c: unknown, p: string) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div
        data-testid="inline-ai-palette"
        data-command={preselectedCommand?.id ?? ""}
      >
        <button
          data-testid="palette-submit"
          onClick={() => onSubmit(preselectedCommand, "テーマ")}
        />
        <button data-testid="palette-close" onClick={onClose} />
      </div>
    ) : null,
}));

// 実装は本物の useAutoSave を使いつつ、テストから pending を arm できるよう
// 最後に生成されたインスタンスを捕捉する (render〜effect 間の arm 窓は
// テストから直接は再現できないため)。
const autoSaveCtl = vi.hoisted(
  () =>
    ({ last: null }) as {
      last: { schedule: () => void; flush: () => Promise<void> } | null;
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
// dirty 配線 (setTabDirty 呼び出し) はこの spy で assert する。dirtyTabIds は
// 外部 flush (saveScene) の dirty ゲート (dirtyGatedSaveHandler) が参照する
// ため、setTabDirty の呼び出しを反映する実 Set として維持する。
const mockDirtyTabIds = vi.hoisted(() => new Set<string>());
const mockSetTabDirty = vi.hoisted(() =>
  vi.fn((id: string, dirty: boolean) => {
    if (dirty) mockDirtyTabIds.add(id);
    else mockDirtyTabIds.delete(id);
  }),
);
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      setTabDirty: mockSetTabDirty,
      dirtyTabIds: mockDirtyTabIds,
    }),
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
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";

function lastEditor(): Editor {
  return createdEditors[createdEditors.length - 1] as Editor;
}

function renderBlock({ isActive = false }: { isActive?: boolean } = {}) {
  return render(
    <LinearSceneBlock
      sceneId="scene-0001"
      isMounted={true}
      isActive={isActive}
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
  mockToastInfo.mockClear();
  mockSetTabDirty.mockClear();
  mockDirtyTabIds.clear();
  isFileBackedNodeMock.mockReturnValue(false);
  createdEditors.length = 0;
  useExternalWriteStore.getState().clear();
  inlineAiSpies.generate.mockClear();
  inlineAiSpies.accept.mockClear();
  inlineAiSpies.reject.mockClear();
  inlineAiSpies.rejectOrAbort.mockClear();
  inlineAiSpies.retry.mockClear();
  mockBuildContext.mockClear();
  // グローバル単一 store / オーナーはテスト間で漏らさない。
  useInlineAiStore.getState().reset();
  useLinearEditorStore.getState().setInlineAiOwner(null);
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

    // ロード中: skeleton が出て、本文/文字数 ("0 字") は invisible で隠れる
    // (textContent には残るので可視性はクラスで assert する。project 言語
    // 未設定 → 文字数単位 "字" が i18n で出る)
    expect(
      container.querySelector("[data-testid='editor-content-loading']"),
    ).not.toBeNull();
    const hiddenWrap = container.querySelector(".invisible");
    expect(hiddenWrap).not.toBeNull();
    expect(hiddenWrap!.textContent).toContain("0 字");

    resolveLoad({ content: MENTION_CONTENT, unplacedBeatsDoc: "[]" });
    await waitFor(() => {
      expect(
        container.querySelector("[data-testid='editor-content-loading']"),
      ).toBeNull();
    });
    expect(container.textContent).toContain("字");
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

  it("inline-AI がこのエディタで非 idle になったら armed 済み autosave を解除する", async () => {
    // 生成/プレビューの実テキストが doc に入っている間、onUpdate の gate は
    // 「新規 schedule の抑止」しかしない。直前の編集で arm 済みのタイマーが
    // 発火すると、未 accept のプレビュー本文ごと persist される (無帰属 AI
    // テキストの焼き込み)。非 idle 遷移で pending を cancel すること。
    await renderLoaded();
    lastEditor().commands.insertContentAt(1, "編集"); // autosave を arm
    act(() => {
      useInlineAiStore.getState().startGeneration({
        commandId: "continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 0,
        abortController: new AbortController(),
        activeEditor: lastEditor(),
      });
    });
    // cancel 済みなら flush は no-op (pending なし)
    await autoSaveCtl.last!.flush();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("別エディタが inline-AI owner のときは自分の armed autosave を解除しない", async () => {
    // owner 判定は onUpdate の gate と同じ activeEditor 一致。リニアは複数
    // エディタがグローバル単一 store を共有するため、status だけで消すと
    // 他シーンの通常編集の保存が失われる。
    await renderLoaded();
    lastEditor().commands.insertContentAt(1, "編集");
    act(() => {
      useInlineAiStore.getState().startGeneration({
        commandId: "continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 0,
        abortController: new AbortController(),
        activeEditor: null, // 別エディタ (このブロックではない)
      });
    });
    await autoSaveCtl.last!.flush();
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });

  it("保存 (await) 中に入った編集は dirty を維持する (編集世代カウンタ)", async () => {
    // coreSave が doc を捕捉して await している間に次の編集が入った場合、
    // 保存完了時の無条件 setTabDirty(false) がその編集の dirty=true を
    // クロバーすると、外部 flush の dirty ゲートが clean 誤判定 → headless
    // 適用の resync が未保存編集を上書き消失させる (Fix 2 の保証破り)。
    await renderLoaded();
    lastEditor().commands.insertContentAt(1, "編集A");
    expect(mockDirtyTabIds.has("scene-0001")).toBe(true);
    mockPersist.mockImplementationOnce(async () => {
      // 保存の await 中に次の編集が入る
      lastEditor().commands.insertContentAt(1, "編集B");
    });
    mockSetTabDirty.mockClear();
    await saveScene("scene-0001");
    expect(mockPersist).toHaveBeenCalledTimes(1);
    // 世代不一致 → dirty は維持 (解除しない)
    expect(mockSetTabDirty).not.toHaveBeenCalledWith("scene-0001", false);
    expect(mockDirtyTabIds.has("scene-0001")).toBe(true);
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

// B1 回帰ガード: リニアモードで / コマンドが効かなかった件の実行配線。
// SlashCommandExtension は extensions 共有でリニアでも発火していたが、
// CustomEvent を受けて実行するリスナーが EditorPane 専用だった。
describe("LinearSceneBlock: スラッシュコマンド実行配線", () => {
  async function renderLoaded(opts: { isActive?: boolean } = {}) {
    mockLoadSceneFull.mockResolvedValue({
      content: MENTION_CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const utils = renderBlock({ isActive: opts.isActive ?? false });
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("主人公は");
    });
    return utils;
  }

  function dispatchSlashCommand(command: Record<string, unknown>) {
    const ed = lastEditor();
    act(() => {
      ed.view.dom.dispatchEvent(
        new CustomEvent("inlineai:slash-command", {
          detail: { command },
          bubbles: true,
        }),
      );
    });
  }

  function startSession(commandId = "continue") {
    act(() => {
      useInlineAiStore.getState().startGeneration({
        commandId,
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 0,
        abortController: new AbortController(),
      });
    });
  }

  it("insert-node (sceneBeat) は editor に Beat ノードを挿入する", async () => {
    await renderLoaded();

    dispatchSlashCommand({ id: "sceneBeat", kind: "insert-node" });

    const beats: string[] = [];
    lastEditor().state.doc.descendants((node) => {
      if (node.type.name === "sceneBeat") beats.push(node.attrs.id);
    });
    expect(beats).toHaveLength(1);
    expect(inlineAiSpies.generate).not.toHaveBeenCalled();
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  it("引数不要の AI コマンドは generate を呼び、自シーンをオーナーに設定する", async () => {
    await renderLoaded({ isActive: true });

    dispatchSlashCommand({ id: "continue", mode: "insert" });

    expect(inlineAiSpies.generate).toHaveBeenCalledTimes(1);
    expect(inlineAiSpies.generate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "continue" }),
      { sentinel: "ctx" },
    );
    expect(mockToastInfo).not.toHaveBeenCalled();
    expect(useLinearEditorStore.getState().inlineAiOwnerSceneId).toBe(
      "scene-0001",
    );
  });

  it("引数必須の AI コマンドはパレットを開き、submit で arg 付き generate を呼ぶ", async () => {
    const { getByTestId, queryByTestId } = await renderLoaded({
      isActive: true,
    });

    dispatchSlashCommand({ id: "describe", mode: "insert", needsArg: true });

    // まだ generate は呼ばれず、パレットが該当コマンドで開く
    expect(inlineAiSpies.generate).not.toHaveBeenCalled();
    const palette = getByTestId("inline-ai-palette");
    expect(palette.getAttribute("data-command")).toBe("describe");

    act(() => {
      getByTestId("palette-submit").click();
    });

    expect(mockBuildContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ arg: "テーマ" }),
    );
    expect(inlineAiSpies.generate).toHaveBeenCalledTimes(1);
    expect(inlineAiSpies.generate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "describe" }),
      { sentinel: "ctx" },
    );
    // submit でパレットは閉じる
    expect(queryByTestId("inline-ai-palette")).toBeNull();
  });

  it("マウント済みオーナーのセッション進行中は新コマンドを弾く", async () => {
    await renderLoaded({ isActive: true });
    startSession(); // status = generating
    act(() => {
      // owner がマウント済み (editorsById に居る) = 解決可能なツールバーが
      // 画面に出ている状態。scene-0001 は mount 時に自己登録済み。
      useLinearEditorStore.getState().setInlineAiOwner("scene-0001");
    });

    dispatchSlashCommand({ id: "continue", mode: "insert" });

    expect(inlineAiSpies.generate).not.toHaveBeenCalled();
    expect(mockToastInfo).toHaveBeenCalled();
  });

  it("オーナー不在の残存セッション (別モードの残骸) は畳んで続行する", async () => {
    await renderLoaded({ isActive: true });
    startSession(); // status = generating だが owner は null のまま

    dispatchSlashCommand({ id: "continue", mode: "insert" });

    // 解決手段が画面に無いので弾かず、stale を畳んで新規生成へ進む
    expect(mockToastInfo).not.toHaveBeenCalled();
    expect(inlineAiSpies.generate).toHaveBeenCalledTimes(1);
    expect(useLinearEditorStore.getState().inlineAiOwnerSceneId).toBe(
      "scene-0001",
    );
  });

  it("オーナーのときだけ Inline AI ツールバーを描画する", async () => {
    const { queryByTestId } = await renderLoaded({ isActive: true });

    // 初期 (オーナー未設定) は出さない
    expect(queryByTestId("inline-ai-toolbar")).toBeNull();

    // 自シーンがオーナーになると出す
    dispatchSlashCommand({ id: "continue", mode: "insert" });
    expect(queryByTestId("inline-ai-toolbar")).not.toBeNull();

    // 別シーンがオーナーなら消える
    act(() => {
      useLinearEditorStore.getState().setInlineAiOwner("other-scene");
    });
    expect(queryByTestId("inline-ai-toolbar")).toBeNull();
  });

  it("ツールバーの Accept/Reject/Retry は自シーンのハンドラへ配線される", async () => {
    const { getByTestId } = await renderLoaded({ isActive: true });
    dispatchSlashCommand({ id: "continue", mode: "insert" });

    act(() => getByTestId("ai-accept").click());
    expect(inlineAiSpies.accept).toHaveBeenCalledTimes(1);

    act(() => getByTestId("ai-reject").click());
    expect(inlineAiSpies.rejectOrAbort).toHaveBeenCalledTimes(1);

    act(() => getByTestId("ai-retry").click());
    expect(inlineAiSpies.retry).toHaveBeenCalledTimes(1);
  });

  it("オーナー進行中にアンマウントされたらセッションを中止する (本文消失ガード)", async () => {
    // unmount cleanup は reset() でセッションを畳む (in-flight stream の abort)。
    // 未 accept テキストの焼き込みは onUpdate の autosave ゲートが防ぐ — その
    // end-to-end は LinearSceneBlock.inlineAiBake.test.tsx で実エディタ検証する。
    const { unmount } = await renderLoaded({ isActive: true });
    act(() => {
      useLinearEditorStore.getState().setInlineAiOwner("scene-0001");
    });
    startSession();
    expect(useInlineAiStore.getState().status).toBe("generating");

    unmount();

    expect(useInlineAiStore.getState().status).toBe("idle");
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
      `${loadedCount.toLocaleString()} 字`,
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
        `${loadedCount.toLocaleString()} 字`,
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
        `${(loadedCount + 3).toLocaleString()} 字`,
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
