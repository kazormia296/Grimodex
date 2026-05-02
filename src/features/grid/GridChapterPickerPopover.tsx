import { useEffect, useRef, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { cn } from "@/lib/utils";

interface Props {
  /** Pixel position for absolute placement */
  anchorRef: React.RefObject<HTMLElement | null>;
  onSelect: (folderId: string) => void;
  onClose: () => void;
}

interface FolderItemProps {
  node: TreeNodeData;
  allNodes: TreeNodeData[];
  depth: number;
  onSelect: (id: string) => void;
}

function FolderItem({ node, allNodes, depth, onSelect }: FolderItemProps) {
  const [expanded, setExpanded] = useState(false);
  const children = allNodes
    .filter((n) => n.parentId === node.id && n.nodeType === "folder")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  return (
    <>
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded px-2 py-1.5 text-[12px] hover:bg-accent text-left"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(node.id)}
      >
        {children.length > 0 ? (
          <span
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
        ) : (
          <span className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{node.title}</span>
      </button>
      {expanded &&
        children.map((child) => (
          <FolderItem
            key={child.id}
            node={child}
            allNodes={allNodes}
            depth={depth + 1}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export function GridChapterPickerPopover({
  anchorRef,
  onSelect,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const nodes = useTreeStore((s) => s.nodes);
  const folderNodes = nodes
    .filter((n) => n.nodeType === "folder")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  const rootFolders = folderNodes.filter((n) => n.parentId === null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      ref={popoverRef}
      className={cn(
        "absolute bottom-full mb-1 left-0 z-50",
        "min-w-[200px] max-h-60 overflow-y-auto",
        "rounded-md border bg-popover p-1 shadow-md",
      )}
    >
      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("grid.selection.moveToChapter", "移動先の章を選択")}
      </div>
      {rootFolders.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
          {t("grid.selection.noChapters", "章がありません")}
        </div>
      )}
      {rootFolders.map((folder) => (
        <FolderItem
          key={folder.id}
          node={folder}
          allNodes={folderNodes}
          depth={0}
          onSelect={(id) => {
            onSelect(id);
            onClose();
          }}
        />
      ))}
    </div>
  );
}
