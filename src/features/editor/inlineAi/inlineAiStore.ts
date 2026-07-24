import { create } from "zustand";
import type { Editor } from "@tiptap/core";
import type { InlineAiState, InlineAiMode } from "./inlineAiTypes";
import type { GroupIndex } from "../tabStore";

interface InlineAiStoreState extends InlineAiState {
  /**
   * ストリーミング中の中止制御用 AbortController。
   * 永続化対象外（store は persist していない）。
   */
  abortController: AbortController | null;
  /**
   * このセッションを所有するエディタ。グローバル単一 store を複数エディタが
   * 共有するリニアモード (1シーン1エディタ) / 分割ビュー (2ペイン) で、diff
   * 装飾とストリーミング中の入力ガード (InlineAIDiffPlugin) を「生成中のエディタ
   * だけ」に効かせるための識別子。null のときはゲートしない (= 旧挙動)。
   * 永続化対象外。
   */
  activeEditor: Editor | null;
  /** Split-pane owner of activeEditor. Null for linear/legacy editors. */
  activeEditorGroup: GroupIndex | null;
  /**
   * ペンディング中 (生成中/diff表示中) に離脱系操作がブロックされたとき増える
   * ワンショットの注意喚起カウンタ。InlineAIToolbar が購読して shake する。
   * 永続化対象外。reset では戻さない (単調増加の UI ping)。
   */
  attentionNonce: number;
  /** attentionNonce を +1 して Toolbar の注意喚起アニメを発火する。 */
  requestAttention: () => void;
  startGeneration: (params: {
    commandId: string;
    mode: InlineAiMode;
    originalRange: { from: number; to: number } | null;
    originalText: string;
    insertPos: number | null;
    abortController: AbortController;
    /** 生成を所有するエディタ。省略時は null = ゲート無効 (旧挙動)。 */
    activeEditor?: Editor | null;
    activeEditorGroup?: GroupIndex | null;
  }) => void;
  appendChunk: (chunk: string) => void;
  finishGeneration: (model: string) => void;
  setGeneratedRange: (range: { from: number; to: number }) => void;
  setError: (error: string) => void;
  /**
   * ストリーミング中の中止。受信済みテキストは破棄せず、status は
   * diffShown に遷移して Accept/Reject 可能な状態にする。
   */
  abortGeneration: (model: string) => void;
  reset: () => void;
}

const INITIAL_STATE: InlineAiState = {
  status: "idle",
  mode: "insert",
  activeCommandId: null,
  originalRange: null,
  originalText: "",
  generatedText: "",
  insertPos: null,
  generatedRange: null,
  error: null,
  model: null,
  stagingId: null,
};

export const useInlineAiStore = create<InlineAiStoreState>()((set, get) => ({
  ...INITIAL_STATE,
  abortController: null,
  activeEditor: null,
  activeEditorGroup: null,
  attentionNonce: 0,

  requestAttention() {
    set((s) => ({ attentionNonce: s.attentionNonce + 1 }));
  },

  startGeneration({
    commandId,
    mode,
    originalRange,
    originalText,
    insertPos,
    abortController,
    activeEditor = null,
    activeEditorGroup = null,
  }) {
    set({
      status: "generating",
      mode,
      activeCommandId: commandId,
      originalRange,
      originalText,
      insertPos,
      generatedText: "",
      generatedRange: null,
      error: null,
      model: null,
      stagingId: null,
      abortController,
      activeEditor,
      activeEditorGroup,
    });
  },

  appendChunk(chunk) {
    set((s) => ({ generatedText: s.generatedText + chunk }));
  },

  finishGeneration(model) {
    set({ status: "diffShown", model, abortController: null });
  },

  setGeneratedRange(range) {
    set({ generatedRange: range });
  },

  setError(error) {
    set({ status: "error", error, abortController: null });
  },

  abortGeneration(model) {
    const ac = get().abortController;
    ac?.abort();
    // 受信済みテキストは保持したまま diffShown に遷移し、
    // Accept/Reject/Retry を可能にする。
    set({ status: "diffShown", model, abortController: null });
  },

  reset() {
    const ac = get().abortController;
    ac?.abort();
    set({
      ...INITIAL_STATE,
      abortController: null,
      activeEditor: null,
      activeEditorGroup: null,
    });
  },
}));
