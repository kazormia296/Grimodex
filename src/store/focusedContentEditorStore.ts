import { create } from "zustand";

/**
 * 「現在フォーカス中のコンテンツエディタ」を保持する共有 store。
 *
 * 既存の `editorStore.editor` は primary group の Scene エディタ 1 個のみを
 * 保持し、Codex 越境の挿入対象には使えない（`foreshadowStore.reinsertSetup`
 * も同制約で動作中）。本 store はその制約を解消するための新規インフラ。
 *
 * Phase 1 では trash 拾い上げ未実装のため、書き込み (setCurrent) は
 * EditorPane / CodexContentEditor の `onFocus` で行うが、読み出し側は
 * Phase 6 の D&D ピックアップで初めて使われる。
 *
 * 将来的に foreshadow / pin / snippet の挿入経路にも展開する想定。
 */
export interface FocusedContentEditor {
  kind: "scene" | "codex" | "snippet";
  id: string;
}

interface FocusedContentEditorStore {
  current: FocusedContentEditor | null;
  setCurrent(target: FocusedContentEditor | null): void;
}

export const useFocusedContentEditorStore = create<FocusedContentEditorStore>(
  (set) => ({
    current: null,
    setCurrent: (target) => set({ current: target }),
  }),
);
