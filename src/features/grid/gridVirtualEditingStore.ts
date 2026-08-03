import { useLayoutEffect } from "react";
import { create } from "zustand";

interface GridVirtualEditingState {
  editingRowIds: ReadonlySet<string>;
}

const editingCountByRowId = new Map<string, number>();

export const useGridVirtualEditingStore = create<GridVirtualEditingState>(
  () => ({
    editingRowIds: new Set<string>(),
  }),
);

function publishEditingRows(): void {
  useGridVirtualEditingStore.setState({
    editingRowIds: new Set(editingCountByRowId.keys()),
  });
}

/**
 * Pin a grid row for one editing owner. Multiple editors in the same card are
 * reference-counted so completing one cannot unpin a sibling editor.
 */
export function beginGridVirtualRowEditing(rowId: string): () => void {
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
 * Registers a mounted local editor with the virtual grid. Layout-effect
 * cleanup balances the registration when editing ends or the card is
 * intentionally torn down.
 */
export function useGridVirtualRowEditing(
  rowId: string,
  editing: boolean,
): void {
  useLayoutEffect(() => {
    if (!editing) return undefined;
    return beginGridVirtualRowEditing(rowId);
  }, [editing, rowId]);
}

export function resetGridVirtualEditingForTests(): void {
  editingCountByRowId.clear();
  publishEditingRows();
}
