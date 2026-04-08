import { create } from "zustand";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

interface CodexHighlightState {
  matchTargets: CodexMatchTarget[];
  hoveredEntryId: string | null;
  enabled: boolean;
  typeColorMap: Record<string, string>;

  setMatchTargets: (targets: CodexMatchTarget[]) => void;
  setHoveredEntryId: (id: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  setTypeColorMap: (map: Record<string, string>) => void;
}

export const useCodexHighlightStore = create<CodexHighlightState>()((set) => ({
  matchTargets: [],
  hoveredEntryId: null,
  enabled: true,
  typeColorMap: {},
  setMatchTargets: (targets) => set({ matchTargets: targets }),
  setHoveredEntryId: (id) => set({ hoveredEntryId: id }),
  setEnabled: (enabled) => set({ enabled }),
  setTypeColorMap: (map) => set({ typeColorMap: map }),
}));
