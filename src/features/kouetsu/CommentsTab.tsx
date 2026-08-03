import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "motion/react";
import { Loader2, MessageSquare } from "lucide-react";
import { formatShortcut } from "@/lib/platform";
import { useTreeStore } from "@/features/tree/treeStore";
import { listAnnotationsForProject } from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import {
  groupPseudoThreads,
  type PseudoThread,
} from "@/features/post-effect/PseudoCommentThread";
import {
  buildCommentGroups,
  commentListItemKey,
  humanCommentsFromDoc,
  isActiveSceneOutOfScope,
  sortCommentGroups,
  type CommentSortOrder,
  type Filter,
  type HumanComment,
  type SceneGroup,
} from "./commentsAggregation";
import { useKouetsuStore } from "./kouetsuStore";
import { jumpToComment } from "./jumpToComment";
import { CommentsToolbar } from "./CommentsToolbar";
import { useResolvedKouetsuScope } from "./useResolvedKouetsuScope";
import { DismissedAnnotationsView } from "@/features/kouetsu/views/DismissedAnnotationsView";
import { listProjectSceneDocuments } from "@/features/tree/api";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsLiveReaderRunning } from "@/features/post-effect/runStore";
import { useReducedMotion } from "@/lib/animation";
import { CommentListItem } from "./CommentListItem";

type LiveReaderRuntimeModule =
  typeof import("@/features/post-effect/liveReaderRuntime");

let liveReaderRuntimePromise: Promise<LiveReaderRuntimeModule> | null = null;

function loadLiveReaderRuntime(): Promise<LiveReaderRuntimeModule> {
  if (!liveReaderRuntimePromise) {
    liveReaderRuntimePromise =
      import("@/features/post-effect/liveReaderRuntime").catch(
        (error: unknown) => {
          liveReaderRuntimePromise = null;
          throw error;
        },
      );
  }
  return liveReaderRuntimePromise;
}

async function loadHumanComments(projectId: string): Promise<HumanComment[]> {
  const rows = await listProjectSceneDocuments(projectId);

  const out: HumanComment[] = [];
  for (const r of rows) {
    out.push(...humanCommentsFromDoc(r.id, r.title, r.content ?? "{}"));
  }
  return out;
}

export function CommentsTab() {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  // 指摘タブと同一のスコープ（kouetsuStore.scope）を共有する。
  const scope = useResolvedKouetsuScope();
  const [human, setHuman] = useState<HumanComment[]>([]);
  const [threads, setThreads] = useState<PseudoThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // 除外（dismiss 済み）疑似コメント表示のトグル。Filter 型（human/ai/all）とは
  // 直交する軸なので別 state で持つ。ON のとき本文を除外ビューに差し替える。
  const [showDismissed, setShowDismissed] = useState(false);
  const liveReaderEnabled = useAnnotationStore((s) => s.liveReaderEnabled);
  const setLiveReaderEnabled = useAnnotationStore(
    (s) => s.setLiveReaderEnabled,
  );
  const annotationsRevision = useAnnotationStore((s) => s.annotationsRevision);
  const liveReaderRunning = useIsLiveReaderRunning();
  const reducedMotion = useReducedMotion();
  const [sortOrder, setSortOrder] = useState<CommentSortOrder>(
    liveReaderEnabled ? "newest" : "scene",
  );

  // リアルタイム読者コメントを有効にしたときの既定は新着順にする。
  // ソートセレクタで手動変更でき、OFF→ON の再有効化時は既定へ戻す。
  useEffect(() => {
    if (liveReaderEnabled) setSortOrder("newest");
  }, [liveReaderEnabled]);

  const sceneTitle = useCallback(
    (sceneId: string) => scenes.find((s) => s.id === sceneId)?.title ?? sceneId,
    [scenes],
  );

  // 人間コメントは CommentMark で doc 焼き込み → 集約には全シーン本文の
  // JSON.parse + extractMarksFromPmDoc 走査が要る(重い)。annotation(疑似コメント)
  // は専用テーブルからの軽量 SELECT。両者を分離して別々に再取得できるようにする。
  const reloadHuman = useCallback(async () => {
    if (!projectId) return;
    setHuman(await loadHumanComments(projectId));
  }, [projectId]);

  // 疑似コメントの dismiss/返信は人間 CommentMark を変更し得ない(annotation テーブル
  // のみ操作)。スレッド操作後に全シーン本文を再走査する loadHumanComments は完全な
  // 無駄だったので annotation だけ silently 再取得する（所見#6）。loading スピナーも
  // 出さず triage ループ(dismiss/返信連打)中のチラつきを防ぐ。
  const reloadAnnotations = useCallback(async () => {
    if (!projectId) return;
    try {
      const projAnns = await listAnnotationsForProject({
        projectId,
        status: "open",
      });
      setThreads(groupPseudoThreads(projAnns.annotations));
    } catch (e) {
      console.error("comments annotation reload error", e);
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      await Promise.all([reloadHuman(), reloadAnnotations()]);
    } catch (e) {
      console.error("comments aggregate load error", e);
    } finally {
      setLoading(false);
    }
  }, [projectId, reloadHuman, reloadAnnotations]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (annotationsRevision > 0) void reloadAnnotations();
  }, [annotationsRevision, reloadAnnotations]);

  // スコープ内シーン集合（project = null で全件）。読み込みは常に project 全体
  // で行い、表示だけを絞る（スコープ切替時の再フェッチ不要）。
  const scopeSceneIds = useMemo<ReadonlySet<string> | null>(() => {
    if (scope.type === "project") return null;
    if (scope.type === "scene")
      return new Set(activeSceneId ? [activeSceneId] : []);
    return new Set(getSceneIdsForScope(nodes, "folder", scope.anchorId));
  }, [scope, nodes, activeSceneId]);

  const groups = useMemo<SceneGroup[]>(
    () =>
      sortCommentGroups(
        buildCommentGroups(human, threads, filter, sceneTitle, scopeSceneIds),
        sortOrder,
      ),
    [human, threads, filter, sceneTitle, scopeSceneIds, sortOrder],
  );

  // 疑似コメント生成の対象は常にアクティブシーン（スコープ非依存）。folder
  // スコープでアクティブシーンがスコープ外だと、生成物がフィルタで不可視に
  // なり無音 no-op に見えるため、完了時に scene スコープへ切り替えて結果を
  // 見せる（敵対レビュー確定指摘）。
  const setScope = useKouetsuStore((s) => s.setScope);
  const handlePseudoCompleted = useCallback(async () => {
    await reloadAnnotations();
    if (isActiveSceneOutOfScope(scopeSceneIds, activeSceneId)) {
      setScope({ type: "scene" });
    }
  }, [reloadAnnotations, scopeSceneIds, activeSceneId, setScope]);

  const handleShowDismissedChange = useCallback(
    (next: boolean) => {
      setShowDismissed(next);
      // 除外ビューで復元(reopen)した annotation は status=open に戻るが
      // 親の threads state は古いまま。通常ビューへ戻す瞬間に annotation
      // だけ再取得し、復元分を即スレッドへ反映する（所見: 反映漏れ）。
      if (!next) void reloadAnnotations();
    },
    [reloadAnnotations],
  );

  const handleLiveReaderEnabledChange = useCallback(
    (enabled: boolean) => {
      setLiveReaderEnabled(enabled);
      if (enabled) {
        void loadLiveReaderRuntime()
          .then(({ startLiveReaderComments }) => {
            startLiveReaderComments();
          })
          .catch((error: unknown) => {
            console.warn("live reader runtime load failed", error);
          });
        return;
      }

      if (liveReaderRuntimePromise) {
        void liveReaderRuntimePromise
          .then(({ stopLiveReaderComments }) => {
            stopLiveReaderComments();
          })
          .catch((error: unknown) => {
            console.warn("live reader runtime stop failed", error);
          });
      }
    },
    [setLiveReaderEnabled],
  );

  const totalCount = groups.reduce(
    (n, g) => n + g.human.length + g.threads.length,
    0,
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <CommentsToolbar
        filter={filter}
        onFilterChange={setFilter}
        showDismissed={showDismissed}
        onShowDismissedChange={handleShowDismissedChange}
        sortOrder={sortOrder}
        onSortOrderChange={setSortOrder}
        liveReaderEnabled={liveReaderEnabled}
        onLiveReaderEnabledChange={handleLiveReaderEnabledChange}
        liveReaderRunning={liveReaderRunning}
        onPseudoCompleted={handlePseudoCompleted}
        onReload={reload}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showDismissed ? (
          <DismissedAnnotationsView
            category="pseudo_comment"
            emptyLabel={t("kouetsu.pseudoComment.emptyIgnored")}
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-xs text-muted-foreground">
            <MessageSquare size={18} />
            <span>{t("kouetsu.comments.empty")}</span>
            <span className="text-[10px] text-muted-foreground/70">
              {t("kouetsu.comments.emptyHint", {
                shortcut: formatShortcut("Ctrl+Shift+M"),
              })}
            </span>
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
                  <span className="truncate">{g.sceneTitle}</span>
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
                    {g.human.length + g.threads.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  <AnimatePresence initial={false} mode="popLayout">
                    {g.items.map((item) => (
                      <CommentListItem
                        key={commentListItemKey(item)}
                        item={item}
                        reducedMotion={reducedMotion}
                        jumpToHumanComment={jumpToComment}
                        onPseudoChanged={() => void reloadAnnotations()}
                        onPseudoJump={() =>
                          item.kind === "pseudo" &&
                          item.thread.root.sceneId &&
                          useTreeStore
                            .getState()
                            .setActiveScene(item.thread.root.sceneId)
                        }
                        jumpTitle={t("kouetsu.comments.jumpToLocation")}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
