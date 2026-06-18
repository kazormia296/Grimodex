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
 * 校閲 Issues タブの「影響レビュー」セクション。
 * 変更された Codex 設定と矛盾する本文箇所 (impact_review_anchor) を表示する。
 * 実行 (run) は Codex 詳細の「影響をチェック」ボタンから行うため表示専用。
 * scope に応じて current / project / ignored を出し分ける (整合性セクションと同型)。
 */
export function ImpactReviewSection() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.activeIssuesScope);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  if (scope === "project") {
    return <ProjectImpactReviewView />;
  }

  if (scope === "ignored") {
    return (
      <DismissedAnnotationsView
        category="impact_review_anchor"
        emptyLabel={t("kouetsu.impactReview.emptyIgnored")}
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
  return (
    <PostEffectAnnotationPanel
      sceneId={activeSceneId}
      categoryFilter={IMPACT_REVIEW_FILTER}
      emptyLabel={t("kouetsu.impactReview.emptyCurrent")}
    />
  );
}
