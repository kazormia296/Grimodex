import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2 } from "lucide-react";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { requestSceneChunkJump } from "@/features/semantic-search/sceneChunkJump";
import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import type { RelatedScene } from "./selectRelatedScenes";

/** シーン切替直後の連打を抑える debounce (ms)。 */
const FETCH_DEBOUNCE_MS = 400;

/**
 * 関連過去シーンの行クリックで、該当シーンを開き一致チャンクへスクロール+選択する。
 * ジャンプの順序契約 (requestJump → setActiveScene → showPanel) は
 * requestSceneChunkJump に集約 (意味検索ダイアログと共有)。
 *
 * 表示中の list は取得時点のスナップショットなので、クリックまでにそのシーンが
 * 削除されている場合がある。削除済みシーンへ setActiveScene すると空エディタが
 * 開く恐れがあるため、現在の tree に存在する時だけジャンプする。
 */
function navigateToScene(scene: RelatedScene): void {
  const exists = useTreeStore
    .getState()
    .nodes.some((n) => n.id === scene.sceneId);
  if (!exists) return;
  requestSceneChunkJump(scene.sceneId, scene.chunkText);
}

/**
 * 「関連する過去シーン」パネル。
 * 現在編集中シーンに意味的に関連する、読書順で前の (既読) シーンを提示し、
 * クリックで該当箇所へジャンプできる。TALK→EXTRACT→RECALL ループの RECALL を
 * 人間向け UI として出す read-only パネル。
 */
export function RelatedScenesPanel({ isActive = true }: SlotPanelProps = {}) {
  const { t } = useTranslation();
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  // 順序軸 (reading/story/auto) が変わったら関連シーンを取り直す。fetchRelatedPastScenes が
  // この mode に従って既読境界を計算するので、Settings での切替を即パネルへ反映させる。
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const [scenes, setScenes] = useState<RelatedScene[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // 非表示パネルでは検索しない (keepalive)。
    if (!isActive || !activeSceneId) {
      setScenes([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(() => {
      fetchRelatedPastScenes(activeSceneId)
        .then((result) => {
          if (!cancelled) setScenes(result);
        })
        .catch(() => {
          if (!cancelled) setScenes([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [isActive, activeSceneId, resolutionMode]);

  return (
    <div className="flex h-full flex-col">
      <div
        data-panel-header
        className="flex flex-shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5"
      >
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-semibold text-foreground">
          {t("layout.panel.related-scenes")}
        </span>
        {loading && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {!activeSceneId ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("relatedScenes.noActiveScene")}
          </p>
        ) : scenes.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {loading ? t("relatedScenes.loading") : t("relatedScenes.empty")}
          </p>
        ) : (
          scenes.map((scene) => (
            <button
              type="button"
              key={scene.sceneId}
              onClick={() => navigateToScene(scene)}
              className="flex w-full cursor-pointer flex-col gap-0.5 px-2 py-1.5 text-left hover:bg-accent/50"
            >
              <span className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs font-medium text-foreground">
                  {scene.sceneTitle || t("relatedScenes.untitled")}
                </span>
                <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
                  {Math.round(scene.score * 100)}%
                </span>
              </span>
              <span className="line-clamp-2 text-[11px] text-muted-foreground">
                {scene.chunkText}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
