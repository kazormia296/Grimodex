import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { CurrentSceneTypoView } from "@/features/kouetsu/views/CurrentSceneTypoView";
import { ProjectTypoView } from "@/features/kouetsu/views/ProjectTypoView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

export function TypoSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectTypoView />;
  }

  if (scope === "ignored") {
    // 整合性と同じ DismissedAnnotationsView を category で絞って流用。
    // category を渡さないと両セクションが byte 同一の全件リストを出し、
    // 誤字側でも「無視した整合性チェック結果はありません」が漏れていた。
    return (
      <DismissedAnnotationsView
        category="typo_anchor"
        emptyLabel={t("kouetsu.typo.emptyIgnored")}
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
  return <CurrentSceneTypoView sceneId={activeSceneId} />;
}
