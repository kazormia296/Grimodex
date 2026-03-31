import { create } from "zustand";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

interface CodexHighlightState {
  matchTargets: CodexMatchTarget[];
  hoveredEntryId: number | null;

  setMatchTargets: (targets: CodexMatchTarget[]) => void;
  setHoveredEntryId: (id: number | null) => void;
}

export const useCodexHighlightStore = create<CodexHighlightState>()((set) => ({
  matchTargets: [],
  hoveredEntryId: null,
  setMatchTargets: (targets) => set({ matchTargets: targets }),
  setHoveredEntryId: (id) => set({ hoveredEntryId: id }),
}));
