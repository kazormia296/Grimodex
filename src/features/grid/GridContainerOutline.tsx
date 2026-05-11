import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { InlineSynopsisEditor } from "@/features/editor/InlineSynopsisEditor";
import { ScrollText } from "lucide-react";

interface Props {
  containerId: string | null;
}

/**
 * Phase 4 後続: dive-in した leaf folder の outline を表示する surface。
 * GridFolderCard と異なり、container folder 自身は column としても card
 * としても描画されないため、ここで明示的に提示しないと folder の outline
 * （= AI chapter outline）が見えなくなる。
 *
 * container が project root (null) のときは何も描画しない。
 */
export function GridContainerOutline({ containerId }: Props) {
  const { t } = useTranslation();
  const folder = useTreeStore((s) =>
    containerId ? s.nodes.find((n) => n.id === containerId) : null,
  );

  if (!folder || folder.nodeType !== "folder") return null;

  return (
    <div className="shrink-0 border-b bg-muted/20 px-4 py-1.5">
      <div className="flex items-start gap-2">
        <ScrollText className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/70" />
        <div className="flex-1 min-w-0">
          <InlineSynopsisEditor
            nodeId={folder.id}
            synopsis={folder.synopsis ?? null}
            className="cursor-text rounded text-[11px] leading-snug text-muted-foreground hover:bg-accent/30"
            textareaClassName="w-full resize-none rounded border border-border bg-background px-1.5 py-1 text-[11px] leading-snug text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={t("grid.column.addOutline", "＋ Outline を追加")}
            rows={3}
            triggerOn="doubleClick"
          />
        </div>
      </div>
    </div>
  );
}
