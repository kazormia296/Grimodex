import { useTranslation } from "react-i18next";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>{t("scenes.deleteConfirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("scenes.deleteConfirmBody", { count })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" size="xs" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="default"
            size="xs"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
