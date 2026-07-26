// @vitest-environment happy-dom
//
// Scenes ツリーのキーボードナビゲーションで「フォーカスバイパス」が効くことを gate。
//
// 回帰の背景: Dockview → region/slot 置換前は focusEditorPanel() が
// `panel.api.setActive()`（エディタパネルを前面化するだけで DOM フォーカスは
// 動かさない）だった。置換後 requestEditorFocus() → editorFocusHandler() が
// ProseMirror を直接 focus() するようになり、矢印ナビの都度 DOM フォーカスが
// ツリー(tabIndex=0 コンテナ)からエディタへ奪われる。すると次の矢印キーは
// ツリーの onKeyDown に届かず「連続ナビゲーション」が 1 手で止まる。
//
// 契約: プレビュー系の遷移（Arrow / Space）はエディタへフォーカスを奪わない
// （requestEditorFocus を呼ばない）→ ツリーがフォーカスを保持し連続ナビできる。
// 明示的に開く Enter / Ctrl+Enter は従来どおりフォーカスを移す。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useScenesKeyboard } from "./useScenesKeyboard";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

function scene(id: string): TreeNodeData {
  return { id, parentId: null, nodeType: "scene" } as unknown as TreeNodeData;
}

const s1 = scene("s1");
const s2 = scene("s2");
const flatNodes = [s1, s2];
const nodeMap: Record<string, TreeNodeData> = { s1, s2 };

function makeArgs(activeSceneId: string) {
  return {
    flatNodes,
    nodeMap,
    activeSceneId,
    selectedIds: [] as string[],
    expandedIds: [] as string[],
    setActiveScene: vi.fn(),
    toggleExpand: vi.fn(),
    setPendingRenameId: vi.fn(),
    initiateDelete: vi.fn(),
    treeRef: { current: null },
    filterRef: { current: null },
  };
}

function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    // 非 INPUT ターゲット（ツリーコンテナ）を模す。INPUT だと handler は即 return。
    target: { tagName: "DIV" } as unknown as HTMLElement,
    ...extra,
  } as unknown as React.KeyboardEvent;
}

let requestEditorFocus: ReturnType<typeof vi.spyOn>;
let openPreview: ReturnType<typeof vi.spyOn>;
let openPinned: ReturnType<typeof vi.spyOn>;
let selectNode: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  requestEditorFocus = vi
    .spyOn(useLayoutStore.getState(), "requestEditorFocus")
    .mockImplementation(() => {});
  openPreview = vi
    .spyOn(useTabStore.getState(), "openPreview")
    .mockImplementation(() => {});
  openPinned = vi
    .spyOn(useTabStore.getState(), "openPinned")
    .mockImplementation(() => {});
  selectNode = vi
    .spyOn(useTreeStore.getState(), "selectNode")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useScenesKeyboard フォーカスバイパス（連続ナビゲーション）", () => {
  it("ArrowDown はプレビューを開くがエディタへフォーカスを奪わない", () => {
    const { result } = renderHook(() => useScenesKeyboard(makeArgs("s1")));
    result.current(keyEvent("ArrowDown"));

    expect(openPreview).toHaveBeenCalledWith("s2");
    expect(selectNode).toHaveBeenCalledWith("s2", false);
    // 核心: フォーカスを奪わない → ツリーが focus を保持し次の矢印も届く。
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  it("ArrowUp もエディタへフォーカスを奪わない", () => {
    const { result } = renderHook(() => useScenesKeyboard(makeArgs("s2")));
    result.current(keyEvent("ArrowUp"));

    expect(openPreview).toHaveBeenCalledWith("s1");
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  it("Space（現在シーンのプレビュー）もフォーカスを奪わない", () => {
    const { result } = renderHook(() => useScenesKeyboard(makeArgs("s1")));
    result.current(keyEvent(" "));

    expect(openPreview).toHaveBeenCalledWith("s1");
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  it("Enter は明示的に開くので従来どおりエディタへフォーカスを移す", () => {
    const args = makeArgs("s1");
    const { result } = renderHook(() => useScenesKeyboard(args));
    result.current(keyEvent("Enter"));

    expect(openPinned).toHaveBeenCalledWith("s1");
    expect(args.setActiveScene).toHaveBeenCalledWith("s1");
    // Enter は「開いて編集」なのでフォーカス移動は正しい挙動。
    expect(requestEditorFocus).toHaveBeenCalled();
  });
});
