import { create } from "zustand";
import type { InlineAiState, InlineAiMode } from "./inlineAiTypes";

interface InlineAiStoreState extends InlineAiState {
  startGeneration: (params: {
    commandId: string;
    mode: InlineAiMode;
    originalRange: { from: number; to: number } | null;
    originalText: string;
    insertPos: number | null;
  }) => void;
  appendChunk: (chunk: string) => void;
  finishGeneration: (model: string) => void;
  setGeneratedRange: (range: { from: number; to: number }) => void;
  setError: (error: string) => void;
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
};

export const useInlineAiStore = create<InlineAiStoreState>()((set) => ({
  ...INITIAL_STATE,

  startGeneration({ commandId, mode, originalRange, originalText, insertPos }) {
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
    });
  },

  appendChunk(chunk) {
    set((s) => ({ generatedText: s.generatedText + chunk }));
  },

  finishGeneration(model) {
    set({ status: "diffShown", model });
  },

  setGeneratedRange(range) {
    set({ generatedRange: range });
  },

  setError(error) {
    set({ status: "error", error });
  },

  reset() {
    set(INITIAL_STATE);
  },
}));
