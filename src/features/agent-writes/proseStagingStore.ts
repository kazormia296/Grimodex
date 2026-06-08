import { create } from "zustand";
import type { ProseStagingMode } from "./prose";

export interface PendingProseProposal {
  stagingId: string;
  sceneId: string;
  text: string;
  mode: ProseStagingMode;
  replaceFrom?: number;
  replaceTo?: number;
  /**
   * Headless content-addressable anchor for `insert` mode: a unique substring
   * of an existing block. The headless applier inserts the new prose
   * before/after the block containing it (external agents have no live cursor,
   * so position is specified by content, not a ProseMirror offset).
   */
  anchorText?: string;
  anchorPosition?: "before" | "after";
}

interface ProseStagingState {
  pending: PendingProseProposal | null;
  enqueue: (proposal: PendingProseProposal) => void;
  clear: () => void;
}

export const useProseStagingStore = create<ProseStagingState>((set) => ({
  pending: null,
  enqueue(proposal) {
    set({ pending: proposal });
  },
  clear() {
    set({ pending: null });
  },
}));
