import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import { useEditorStore } from "./editorStore";

interface LinearEditorState {
  /** The TipTap editor instance that currently has focus. */
  focusedEditor: Editor | null;
  /** The scene ID whose editor currently has focus. */
  focusedSceneId: string | null;
  /** Set by external navigation (Scenes panel, tab click) to request scrolling. */
  pendingScrollToId: string | null;
  /**
   * マウント中の LinearSceneBlock の editor 一覧 (sceneId → Editor)。
   * Toolbar / SceneMetaPanel が「active シーンの editor」をフォーカス
   * (クリック) 無しで参照するための registry。focusedEditor はクリック
   * するまで null なので、これが無いとリニア入場直後にツールバーが消える。
   */
  editorsById: Record<string, Editor>;

  /**
   * 進行中の Inline AI セッションを所有するシーン ID。
   * useInlineAiStore はグローバル単一だがリニアは 1 シーン 1 エディタで複数
   * ブロックが同時マウントされるため、「どのシーンが今の AI 提案の主か」を
   * これで一意に決める。Inline AI ツールバーはこの owner ブロックでのみ
   * マウントされ (=画面に 1 個だけ)、Accept/Reject/Retry が生成を開始した
   * エディタへ正しくルーティングされる。null = セッションなし。
   */
  inlineAiOwnerSceneId: string | null;

  setFocusedEditor: (editor: Editor | null, sceneId: string | null) => void;
  setPendingScrollToId: (id: string | null) => void;
  registerEditor: (sceneId: string, editor: Editor) => void;
  unregisterEditor: (sceneId: string, editor: Editor) => void;
  setInlineAiOwner: (sceneId: string | null) => void;
}

export const useLinearEditorStore = create<LinearEditorState>()((set) => ({
  focusedEditor: null,
  focusedSceneId: null,
  pendingScrollToId: null,
  editorsById: {},
  inlineAiOwnerSceneId: null,

  setFocusedEditor(editor, sceneId) {
    set({ focusedEditor: editor, focusedSceneId: sceneId });
    // Keep global editorStore in sync for ChatPanel inserts
    useEditorStore.getState().setEditor(editor);
  },

  setPendingScrollToId(id) {
    set({ pendingScrollToId: id });
  },

  registerEditor(sceneId, editor) {
    set((s) => ({ editorsById: { ...s.editorsById, [sceneId]: editor } }));
  },

  unregisterEditor(sceneId, editor) {
    set((s) => {
      // 同一シーンの新インスタンスが先に register していたら消さない
      // (remount 時の register→旧 unregister の順序競合ガード)
      if (s.editorsById[sceneId] !== editor) return s;
      const next = { ...s.editorsById };
      delete next[sceneId];
      return { editorsById: next };
    });
  },

  setInlineAiOwner(sceneId) {
    set({ inlineAiOwnerSceneId: sceneId });
  },
}));
