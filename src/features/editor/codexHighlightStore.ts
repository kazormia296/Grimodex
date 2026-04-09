import { create } from "zustand";
import type { CodexMatchTarget } from "@/features/codex/codexMatcher";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

interface CodexHighlightState {
  matchTargets: CodexMatchTarget[];
  matchedEntryIds: string[];
  hoveredEntryId: string | null;
  enabled: boolean;
  typeColorMap: Record<string, ResolvedCodexColor>;

  setMatchTargets: (targets: CodexMatchTarget[]) => void;
  setMatchedEntryIds: (ids: string[]) => void;
  setHoveredEntryId: (id: string | null) => void;
  setEnabled: (enabled: boolean) => void;
  setTypeColorMap: (map: Record<string, ResolvedCodexColor>) => void;
}

export const useCodexHighlightStore = create<CodexHighlightState>()((set) => ({
  matchTargets: [],
  matchedEntryIds: [],
  hoveredEntryId: null,
  enabled: true,
  typeColorMap: {},
  setMatchTargets: (targets) => set({ matchTargets: targets }),
  setMatchedEntryIds: (ids) => set({ matchedEntryIds: ids }),
  setHoveredEntryId: (id) => set({ hoveredEntryId: id }),
  setEnabled: (enabled) => set({ enabled }),
  setTypeColorMap: (map) => set({ typeColorMap: map }),
}));
