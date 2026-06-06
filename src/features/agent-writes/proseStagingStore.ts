import { create } from "zustand";
import type { ProseStagingMode } from "./prose";

export interface PendingProseProposal {
  stagingId: string;
  sceneId: string;
  text: string;
  mode: ProseStagingMode;
  replaceFrom?: number;
  replaceTo?: number;
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
