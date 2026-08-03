import { useLayoutEffect } from "react";
import { create } from "zustand";

interface TreeVirtualEditingState {
  editingRowIds: ReadonlySet<string>;
}

const editingCountByRowId = new Map<string, number>();

export const useTreeVirtualEditingStore = create<TreeVirtualEditingState>(
  () => ({
    editingRowIds: new Set<string>(),
  }),
);

function publishEditingRows(): void {
  useTreeVirtualEditingStore.setState({
    editingRowIds: new Set(editingCountByRowId.keys()),
  });
}

/**
 * Pin a tree row for one editing owner. The returned release function is
 * idempotent so blur, keyboard completion, and unmount cleanup can safely race.
 */
export function beginTreeVirtualRowEditing(rowId: string): () => void {
  const previousCount = editingCountByRowId.get(rowId) ?? 0;
  editingCountByRowId.set(rowId, previousCount + 1);
  if (previousCount === 0) publishEditingRows();

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const currentCount = editingCountByRowId.get(rowId);
    if (currentCount === undefined) return;
    if (currentCount > 1) {
      editingCountByRowId.set(rowId, currentCount - 1);
      return;
    }
    editingCountByRowId.delete(rowId);
    publishEditingRows();
  };
}

/**
 * Registers a mounted local editor with the virtual tree. Layout-effect
 * cleanup balances the registration when the editor completes or its owning
 * surface is intentionally torn down.
 */
export function useTreeVirtualRowEditing(
  rowId: string,
  editing: boolean,
): void {
  useLayoutEffect(() => {
    if (!editing) return undefined;
    return beginTreeVirtualRowEditing(rowId);
  }, [editing, rowId]);
}

export function resetTreeVirtualEditingForTests(): void {
  editingCountByRowId.clear();
  publishEditingRows();
}
