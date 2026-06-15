import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { ProjectTimelineConsistencyView } from "@/features/kouetsu/views/ProjectTimelineConsistencyView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

/**
 * timeline_consistency セクション。時系列チェックは本質的にプロジェクト全体スコープ
 * (single-scene run なし) なので、current/project どちらでも Project ビューを出す。
 */
export function TimelineConsistencySection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.activeEditorialScope);

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="timeline_anchor"
        emptyLabel={t("kouetsu.timelineConsistency.emptyIgnored")}
      />
    );
  }

  return <ProjectTimelineConsistencyView />;
}
