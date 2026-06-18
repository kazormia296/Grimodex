import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2 } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

/**
 * 影響レビュー (impact_review_anchor) のプロジェクト全件ビュー。
 * 実行 (run) は Codex 詳細の「影響をチェック」ボタンから行うため、ここは表示専用。
 * シーン別にグループ化し、AnnotationItem を流用してチップ/解決/破棄を共通化する。
 */
export function ProjectImpactReviewView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(
          resp.annotations.filter((a) => a.category === "impact_review_anchor"),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  const groups = useMemo(() => {
    const acc = new Map<string, PostEffectAnnotation[]>();
    for (const ann of annotations) {
      if (!ann.sceneId) continue;
      const arr = acc.get(ann.sceneId) ?? [];
      arr.push(ann);
      acc.set(ann.sceneId, arr);
    }
    return [...acc.entries()].map(([sceneId, items]) => ({
      sceneId,
      label: sceneTitle(sceneId),
      items,
    }));
    // sceneTitle depends on scenes
  }, [annotations, scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
        <Info size={16} />
        <span>{t("kouetsu.impactReview.empty")}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      {groups.map((g) => (
        <div key={g.sceneId} className="flex flex-col">
          <div
            className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
            role="button"
            tabIndex={0}
            onClick={() => useTreeStore.getState().setActiveScene(g.sceneId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                useTreeStore.getState().setActiveScene(g.sceneId);
            }}
          >
            <span className="truncate">{g.label}</span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
              {g.items.length}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 p-2">
            {g.items.map((ann) => (
              <AnnotationItem
                key={ann.id}
                ann={ann}
                onStatusChange={(id) =>
                  setAnnotations((prev) => prev.filter((a) => a.id !== id))
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
