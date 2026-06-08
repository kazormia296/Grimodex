import { create } from "zustand";
import type { DetectRenameResult } from "./detectOccurrences";

export interface PendingRename {
  entryId: string;
  oldName: string;
  newName: string;
  result: DetectRenameResult;
}

interface RenamePropagationState {
  /** Non-null while the preview modal is open. */
  pending: PendingRename | null;
  isApplying: boolean;
  open: (pending: PendingRename) => void;
  close: () => void;
  setApplying: (v: boolean) => void;
}

/**
 * Decouples the rename trigger (CodexDetailContent.handleNameBlur) from the
 * globally-mounted preview modal. The trigger runs detection and, if there are
 * occurrences, calls `open(...)`; the modal reads `pending` and drives apply.
 */
export const useRenamePropagationStore = create<RenamePropagationState>()(
  (set) => ({
    pending: null,
    isApplying: false,
    open: (pending) => set({ pending, isApplying: false }),
    close: () => set({ pending: null, isApplying: false }),
    setApplying: (v) => set({ isApplying: v }),
  }),
);
