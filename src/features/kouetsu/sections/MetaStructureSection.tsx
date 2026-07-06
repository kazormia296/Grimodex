import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { MetaStructureView } from "@/features/kouetsu/views/MetaStructureView";

export function MetaStructureSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (statusFilter === "dismissed") {
    // メタ構造は scene_lens 由来で dismiss の概念を持たない (annotation ではない)。
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.metaStructure.noExcluded")}
      </div>
    );
  }
  if (scope.type !== "scene") {
    return <MetaStructureView scope="project" />;
  }
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return <MetaStructureView scope="current" sceneId={activeSceneId} />;
}
