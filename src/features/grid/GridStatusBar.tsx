import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";

interface Props {
  totalChapters: number;
  totalScenes: number;
  displayedScenes: TreeNodeData[];
}

export function GridStatusBar({
  totalChapters,
  totalScenes,
  displayedScenes,
}: Props) {
  const { t } = useTranslation();
  const totalCharCount = useTreeStore((s) =>
    displayedScenes.reduce(
      (sum, scene) => sum + (s.charCounts[scene.id] ?? scene.charCount ?? 0),
      0,
    ),
  );
  return (
    <div className="flex items-center gap-3 border-t px-4 py-1 text-[11px] text-muted-foreground">
      <span>
        {t("grid.status.chapters", "{{count}} 章", { count: totalChapters })}
      </span>
      <span>
        {t("grid.status.scenes", "{{count}} シーン", { count: totalScenes })}
      </span>
      <span>{totalCharCount.toLocaleString()} chars</span>
    </div>
  );
}
