import { useTranslation } from "react-i18next";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  PostEffectAnnotationPanel,
  IMPACT_REVIEW_FILTER,
} from "@/features/post-effect/PostEffectAnnotationPanel";
import { ProjectImpactReviewView } from "@/features/kouetsu/views/ProjectImpactReviewView";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";

/**
 * 受信箱の「影響レビュー」観点。変更された Codex 設定と矛盾する本文箇所
 * (impact_review_anchor) を表示する。実行 (run) は Codex 詳細の「影響をチェック」
 * ボタンから行うため表示専用。scope/statusFilter に応じて出し分ける（整合性と同型）。
 */
export function ImpactReviewSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (statusFilter === "dismissed") {
    return (
      <DismissedAnnotationsView
        category="impact_review_anchor"
        emptyLabel={t("kouetsu.impactReview.emptyIgnored")}
      />
    );
  }
  if (scope.type !== "scene") {
    return <ProjectImpactReviewView />;
  }
  if (!activeSceneId) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {t("kouetsu.selectScene")}
      </div>
    );
  }
  return (
    <PostEffectAnnotationPanel
      sceneId={activeSceneId}
      categoryFilter={IMPACT_REVIEW_FILTER}
      emptyLabel={t("kouetsu.impactReview.emptyCurrent")}
    />
  );
}
