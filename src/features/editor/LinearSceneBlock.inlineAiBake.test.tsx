// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { getDocText } from "@/features/editor/RubyNode";

// 本文消失/帰属破壊の回帰ガード (Critical)。
// リニアで `/continue` 等の生成が diffShown のまま (ユーザーが Accept/Reject せず)
// owner ブロックがスクロールアウトで unmount されると、挿入済みの**未 accept**
// 生成テキストが editor doc に残る。直後の autosave flush (useAutoSave の unmount
// cleanup) がそれを persistSceneBody で焼き込むと、AI 生成文が**未帰属の人間文**
// として保存され帰属台帳が壊れる。
// useLinearInlineAi の unmount cleanup は bare reset() ではなく reject() を呼び、
// flush より先に (React の逆順 cleanup) 生成テキストを削除する。この統合テストは
// **実** useInlineAiDiff + 実 useAutoSave + 実エディタで no-bake を保証する
// (LinearSceneBlock.test.tsx 側は useInlineAiDiff を mock するため挿入が起きず
// この経路を検証できない)。

const { mockLoadSceneFull, mockPersist, createdEditors } = vi.hoisted(() => ({
  mockLoadSceneFull: vi.fn(),
  mockPersist: vi.fn().mockResolvedValue(undefined),
  createdEditors: [] as unknown[],
}));

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

vi.mock("@/features/tree/api", () => ({ loadSceneFull: mockLoadSceneFull }));
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
  toast: { error: vi.fn(), info: vi.fn() },
}));
// 実ストリーミング API は import 時に Tauri を引くため遮断 (本テストでは未使用)。
vi.mock("@/features/editor/inlineAi/inlineAiApi", () => ({
  generateInlineAi: vi.fn(),
}));
// fixed overlay の描画は本テストの関心外なので落とす。
vi.mock("@/features/editor/inlineAi/InlineAIToolbar", () => ({
  InlineAIToolbar: () => null,
}));
vi.mock("@/features/editor/inlineAi/InlineAIPalette", () => ({
  InlineAIPalette: () => null,
}));
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
vi.mock("@/features/external-mount/externalRootStore", () => ({
  isFileBackedNode: vi.fn().mockReturnValue(false),
}));
vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: { getState: () => ({ setTabDirty: vi.fn() }) },
}));
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
import { useLinearEditorStore } from "./linearEditorStore";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";

const CONTENT = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "本文。" }] }],
});

const AI_TEXT = "AI生成テキスト";

function lastEditor(): Editor {
  return createdEditors[createdEditors.length - 1] as Editor;
}

beforeEach(() => {
  mockLoadSceneFull.mockReset();
  mockPersist.mockClear();
  createdEditors.length = 0;
  useInlineAiStore.getState().reset();
  useLinearEditorStore.getState().setInlineAiOwner(null);
});

describe("LinearSceneBlock: 未 accept 生成テキストの unmount 焼き込みガード", () => {
  async function renderLoaded() {
    mockLoadSceneFull.mockResolvedValue({
      content: CONTENT,
      unplacedBeatsDoc: "[]",
    });
    const utils = render(
      <LinearSceneBlock
        sceneId="scene-0001"
        isMounted={true}
        isActive={true}
        placeholderHeight={300}
        onHeightChange={() => {}}
        onFocus={() => {}}
      />,
    );
    await waitFor(() => {
      expect(getDocText(lastEditor().state.doc)).toContain("本文。");
    });
    return utils;
  }

  function persistedAnyDocContaining(text: string): boolean {
    return mockPersist.mock.calls.some((c) => getDocText(c[1]).includes(text));
  }

  it("生成中に挿入した未 accept テキストは autosave を arm せず unmount でも焼き込まれない", async () => {
    const { unmount } = await renderLoaded();
    const ed = lastEditor();

    act(() => {
      // 実フロー: 生成中 (status generating) に inlineAiInsert chunk を挿入する。
      // diff プラグインの filterTransaction を通り、onUpdate の autosave ゲート
      // (生成中の owner エディタの編集は schedule しない) に当たる。
      useInlineAiStore.getState().startGeneration({
        commandId: "continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 1,
        abortController: new AbortController(),
        activeEditor: ed,
      });
      const tr = ed.state.tr
        .insertText(AI_TEXT, 1)
        .setMeta("inlineAiInsert", true)
        .setMeta("addToHistory", false);
      ed.view.dispatch(tr);
      useInlineAiStore
        .getState()
        .setGeneratedRange({ from: 1, to: 1 + AI_TEXT.length });
      useInlineAiStore.getState().finishGeneration("claude-sonnet-4-6");
      useLinearEditorStore.getState().setInlineAiOwner("scene-0001");
    });

    expect(useInlineAiStore.getState().status).toBe("diffShown");
    expect(getDocText(ed.state.doc)).toContain(AI_TEXT);

    unmount();

    // chunk は autosave を arm しなかった → flush は未 accept テキストを
    // persistSceneBody へ焼き込まない (帰属破壊・本文消失の回帰ガード)。
    expect(persistedAnyDocContaining(AI_TEXT)).toBe(false);
  });

  it("別エディタが AI セッション中でも、当シーンの通常編集は autosave される (owner-aware ゲート)", async () => {
    const { unmount } = await renderLoaded();
    const ed = lastEditor();

    act(() => {
      // 別エディタ (sentinel) が所有するセッションを進行中にする。
      const foreignEditor = { __id: "foreign" } as unknown as Editor;
      useInlineAiStore.getState().startGeneration({
        commandId: "continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 1,
        abortController: new AbortController(),
        activeEditor: foreignEditor,
      });
      // 当シーンの通常ユーザー編集 (このエディタは owner ではない)。
      ed.commands.insertContentAt(1, "人間の追記");
    });

    unmount();

    // activeEditor !== このエディタなのでゲートされず、通常どおり保存される。
    expect(persistedAnyDocContaining("人間の追記")).toBe(true);
  });
});
