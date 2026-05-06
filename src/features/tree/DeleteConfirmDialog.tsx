import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";

interface DeleteConfirmDialogProps {
  ids: string[];
  childMap: Record<string, string[]>;
  nodeMap: Record<string, TreeNodeData>;
  charCounts: Record<string, number>;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Modal shown when deleting non-empty nodes (or folders containing them).
 *  Counts the leaves that have content/synopsis and asks the user to confirm. */
export function DeleteConfirmDialog({
  ids,
  childMap,
  nodeMap,
  charCounts,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation();

  const count = (() => {
    function collectAll(id: string): string[] {
      return [id, ...(childMap[id] ?? []).flatMap(collectAll)];
    }
    return ids.flatMap(collectAll).filter((id) => {
      const node = nodeMap[id];
      if (!node || node.nodeType === "folder") return false;
      return (charCounts[id] ?? 0) > 0 || !!node.synopsis;
    }).length;
  })();

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
      <div className="rounded-lg border border-border bg-popover p-4 shadow-xl w-72">
        <p className="text-sm font-medium mb-1">
          {t("scenes.deleteConfirmTitle")}
        </p>
        <p className="text-xs text-muted-foreground mb-4">
          {t("scenes.deleteConfirmBody", { count })}
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="rounded px-3 py-1 text-xs border border-border hover:bg-accent"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="rounded px-3 py-1 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              ids
                .reduce(
                  (p, id) =>
                    p.then(() => useTreeStore.getState().deleteNode(id)),
                  Promise.resolve(),
                )
                .catch(() => {});
              onConfirm();
            }}
          >
            {t("common.deleteConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
