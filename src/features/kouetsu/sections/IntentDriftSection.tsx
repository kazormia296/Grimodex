import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneIntentDriftView } from "@/features/kouetsu/views/CurrentSceneIntentDriftView";
import { ProjectIntentDriftView } from "@/features/kouetsu/views/ProjectIntentDriftView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function IntentDriftSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (statusFilter === "dismissed") {
    return (
      <DismissedAnnotationsView
        category="intent_anchor"
        emptyLabel={t("kouetsu.intentDrift.emptyIgnored")}
      />
    );
  }
  if (scope.type !== "scene") {
    return <ProjectIntentDriftView />;
  }
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return <CurrentSceneIntentDriftView sceneId={activeSceneId} />;
}
