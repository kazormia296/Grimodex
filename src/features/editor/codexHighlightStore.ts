import { create } from "zustand";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

interface CodexHighlightState {
  matchTargets: CodexMatchTarget[];
  hoveredEntryId: string | null;

  setMatchTargets: (targets: CodexMatchTarget[]) => void;
  setHoveredEntryId: (id: string | null) => void;
}

export const useCodexHighlightStore = create<CodexHighlightState>()((set) => ({
  matchTargets: [],
  hoveredEntryId: null,
  setMatchTargets: (targets) => set({ matchTargets: targets }),
  setHoveredEntryId: (id) => set({ hoveredEntryId: id }),
}));
