import { create } from "zustand";
import type { Editor } from "@tiptap/core";

/**
 * 「現在フォーカス中のコンテンツエディタ」を保持する共有 store。
 *
 * 既存の `editorStore.editor` は primary group の Scene エディタ 1 個のみを
 * 保持し、Codex 越境の挿入対象には使えない（`foreshadowStore.reinsertSetup`
 * も同制約で動作中）。本 store はその制約を解消するための新規インフラ。
 *
 * 用途:
 *  - Trash Bin の D&D / Popover 復元先 (`text-fragment` をエディタ本文に挿入)
 *  - 将来的に foreshadow / pin / snippet の挿入経路にも展開する想定
 *
 * `current` (kind/id) は Zustand state なので Popover の subscribe にも使うが、
 * Editor 参照そのものは re-render を誘発したくないのでモジュール内 ref として
 * 別管理する (`currentEditorRef`)。エディタは EditorPane / CodexContentEditor
 * が onFocus 時に setCurrent 経由で登録する。
 */
export interface FocusedContentEditor {
  kind: "scene" | "codex" | "snippet";
  id: string;
}

interface FocusedContentEditorStore {
  current: FocusedContentEditor | null;
  setCurrent(target: FocusedContentEditor | null, editor?: Editor | null): void;
}

// Editor 参照は state に置かない (Editor は内部で頻繁に変化し、参照同一性も
// 揃わないため selector が無限ループしやすい)。getter/setter で出し入れする。
let currentEditorRef: Editor | null = null;

/** 現在フォーカス中のエディタの Editor 参照を取得 (なければ null)。 */
export function getFocusedEditor(): Editor | null {
  return currentEditorRef;
}

export const useFocusedContentEditorStore = create<FocusedContentEditorStore>(
  (set) => ({
    current: null,
    setCurrent: (target, editor = null) => {
      currentEditorRef = editor;
      set({ current: target });
    },
  }),
);
