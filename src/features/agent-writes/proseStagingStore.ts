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
  /**
   * propose 時点の tree_nodes.version (prose_staging.base_version)。headless
   * 自動適用 (autoApplyProse) が「propose 後に本文が書き換わっていないか」の
   * stale 検知に使う。DB 由来の proposal (loadLatestProposedProse /
   * loadAllProposedProse) では必ず入る。in-app agent の直接 enqueue
   * (toolExecutors → diff UI 専用) では省略され、その場合は比較しない。
   */
  baseVersion?: number;
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
