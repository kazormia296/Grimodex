import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentScenePseudoCommentView } from "@/features/kouetsu/views/CurrentScenePseudoCommentView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function PseudoCommentSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.activeEditorialScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.pseudoComment.projectUnavailable")}
      </div>
    );
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="pseudo_comment"
        emptyLabel={t("kouetsu.pseudoComment.emptyIgnored")}
      />
    );
  }

  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return <CurrentScenePseudoCommentView sceneId={activeSceneId} />;
}
