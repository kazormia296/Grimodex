import { create } from "zustand";
import type { InlineAiState, InlineAiMode } from "./inlineAiTypes";

interface InlineAiStoreState extends InlineAiState {
  /**
   * ストリーミング中の中止制御用 AbortController。
   * 永続化対象外（store は persist していない）。
   */
  abortController: AbortController | null;
  startGeneration: (params: {
    commandId: string;
    mode: InlineAiMode;
    originalRange: { from: number; to: number } | null;
    originalText: string;
    insertPos: number | null;
    abortController: AbortController;
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

  startGeneration({
    commandId,
    mode,
    originalRange,
    originalText,
    insertPos,
    abortController,
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
    set({ ...INITIAL_STATE, abortController: null });
  },
}));
