import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneReviewView } from "@/features/kouetsu/views/CurrentSceneReviewView";
import { ProjectReviewView } from "@/features/kouetsu/views/ProjectReviewView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function ReviewSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectReviewView />;
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="review"
        emptyLabel={t("kouetsu.review.emptyIgnored")}
      />
    );
  }

  // current scope
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return <CurrentSceneReviewView sceneId={activeSceneId} />;
}
