import { create } from "zustand";
import type { MentionRole } from "@/features/codex/CodexMentionExtension";

export interface RoleSuggestionEntry {
  codexId: string;
  name: string;
  currentRole: MentionRole;
  suggestedRole: MentionRole;
  confidence: number;
  status: "pending" | "accepted" | "rejected";
}

interface RoleSuggestionsState {
  /** beatId → suggestions (confidence 降順で格納) */
  byBeatId: Record<string, RoleSuggestionEntry[]>;

  setSuggestions(beatId: string, list: RoleSuggestionEntry[]): void;
  markStatus(
    beatId: string,
    codexId: string,
    status: "accepted" | "rejected",
  ): void;
  clearBeat(beatId: string): void;
  /** Returns only pending suggestions for the given beat. */
  getActive(beatId: string): RoleSuggestionEntry[];
}

export const useRoleSuggestionsStore = create<RoleSuggestionsState>()(
  (set, get) => ({
    byBeatId: {},

    setSuggestions(beatId, list) {
      const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
      set((s) => ({ byBeatId: { ...s.byBeatId, [beatId]: sorted } }));
    },

    markStatus(beatId, codexId, status) {
      set((s) => {
        const entries = s.byBeatId[beatId];
        if (!entries) return s;
        return {
          byBeatId: {
            ...s.byBeatId,
            [beatId]: entries.map((e) =>
              e.codexId === codexId ? { ...e, status } : e,
            ),
          },
        };
      });
    },

    clearBeat(beatId) {
      set((s) => {
        const next = { ...s.byBeatId };
        delete next[beatId];
        return { byBeatId: next };
      });
    },

    getActive(beatId) {
      return (get().byBeatId[beatId] ?? []).filter(
        (e) => e.status === "pending",
      );
    },
  }),
);
