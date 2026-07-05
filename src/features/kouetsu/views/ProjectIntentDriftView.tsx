import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2 } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";

/** プロジェクト全体の intent_anchor 指摘を表示するのみ（multi run 非対応）。 */
export function ProjectIntentDriftView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const nodes = useTreeStore((s) => s.nodes);

  // folder スコープでは subtree 外シーンの指摘を隠す（表示専用ビュー）。
  const kouetsuScope = useKouetsuStore((s) => s.scope);
  const visibleSceneIds = useMemo(() => {
    if (kouetsuScope.type !== "folder") return null;
    return new Set(getSceneIdsForScope(nodes, "folder", kouetsuScope.anchorId));
  }, [kouetsuScope, nodes]);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  const reload = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(
          resp.annotations.filter((a) => a.category === "intent_anchor"),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const groups = useMemo(() => {
    const source = visibleSceneIds
      ? annotations.filter((a) => a.sceneId && visibleSceneIds.has(a.sceneId))
      : annotations;
    const acc = new Map<
      string,
      { sceneId: string; label: string; items: PostEffectAnnotation[] }
    >();
    for (const ann of source) {
      if (!ann.sceneId) continue;
      const g = acc.get(ann.sceneId) ?? {
        sceneId: ann.sceneId,
        label: sceneTitle(ann.sceneId),
        items: [],
      };
      g.items.push(ann);
      acc.set(ann.sceneId, g);
    }
    return [...acc.values()];
  }, [annotations, scenes, visibleSceneIds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.projectIntentDrift.header")}
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>{t("kouetsu.intentDrift.empty")}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0">
          {groups.map((g) => (
            <div key={g.sceneId} className="flex flex-col">
              <div
                role="button"
                tabIndex={0}
                onClick={() =>
                  useTreeStore.getState().setActiveScene(g.sceneId)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    useTreeStore.getState().setActiveScene(g.sceneId);
                }}
                className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
              >
                <span className="truncate">{g.label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
                  {g.items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2">
                {g.items.map((ann) => (
                  <AnnotationItem key={ann.id} ann={ann} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
