import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { ProjectTimelineConsistencyView } from "@/features/kouetsu/views/ProjectTimelineConsistencyView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

/**
 * timeline_consistency 観点。時系列チェックは本質的にプロジェクト全体スコープ
 * (single-scene run なし) なので、dismissed 以外は scene/folder/project いずれでも
 * Project ビューを出す（スコープのチップ表示は ProjectTimelineConsistencyView 側）。
 */
export function TimelineConsistencySection() {
  const { t } = useTranslation();
  const statusFilter = useKouetsuStore((s) => s.statusFilter);

  if (statusFilter === "dismissed") {
    return (
      <DismissedAnnotationsView
        category="timeline_anchor"
        emptyLabel={t("kouetsu.timelineConsistency.emptyIgnored")}
      />
    );
  }

  return <ProjectTimelineConsistencyView />;
}
