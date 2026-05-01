import { Plus, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { GridContainerSelector } from "./GridContainerSelector";

interface Props {
  containerId: string | null;
  projectId: string;
  chapterCount: number;
  onContainerChange: (id: string | null) => void;
  onToggleDisplay: () => void;
}

export function GridHeader({
  containerId,
  projectId,
  chapterCount,
  onContainerChange,
  onToggleDisplay,
}: Props) {
  const { t } = useTranslation();
  const createNode = useTreeStore((s) => s.createNode);

  async function addChapter() {
    await createNode({ nodeType: "folder", parentId: containerId });
  }

  return (
    <div className="flex items-center gap-2 border-b px-3 py-2 shrink-0">
      <GridContainerSelector
        containerId={containerId}
        projectId={projectId}
        onSelect={onContainerChange}
      />

      <span className="text-[11px] text-muted-foreground ml-1">
        {t("grid.header.chapterCount", "{{count}} 章", {
          count: chapterCount,
        })}
      </span>

      <div className="flex-1" />

      <button
        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-accent transition-colors"
        onClick={() => void addChapter()}
        title={t("grid.header.newChapter", "章を追加")}
      >
        <Plus className="h-3 w-3" />
        {t("grid.header.newChapter", "章を追加")}
      </button>

      <button
        className="rounded p-1 hover:bg-accent transition-colors"
        onClick={onToggleDisplay}
        title={t("grid.header.displaySettings", "表示設定")}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
