import { Star, X } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { DialogFooter } from "@/components/ui/dialog";
import { ResponsiveAlertDialog } from "@/components/ui/responsive-alert-dialog";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { cn } from "@/lib/utils";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  createProjectSnapshot,
  listProjectSnapshots,
  restoreProjectSnapshot,
  deleteProjectSnapshot,
  type ProjectSnapshotMeta,
} from "./projectSnapshotApi";
import type { RestoreLossNotice } from "./projectSnapshotNative";
import { RevisionRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { RestoreLossSummary } from "./RestoreLossSummary";
import { describeRestoreLoss } from "./restoreLossNotices";
import { useRestoreLossPreview } from "./useRestoreLossPreview";
import {
  RESTORE_SCOPES,
  fullRestoreScopeSet,
  skipReportIsEmpty,
  type RestoreScope,
  type SkipReport,
} from "./projectSnapshotScopes";
import { reloadRendererAfterReleasingGpuSurfaces } from "@/lib/rendererReload";

function countSkipped(r: SkipReport): number {
  return (
    r.treeNodeLabels +
    r.lintIgnoredDiagnostics +
    r.foreshadowSetups +
    r.foreshadowCodexLinks +
    r.postEffectAnnotations +
    r.postEffectAnnotationRelations +
    r.authorshipSpans +
    r.sceneCodexPins +
    r.sceneCodexMentions +
    r.sceneBeatPovCache +
    r.eventParticipants +
    r.foreshadowPayoffSceneCleared +
    r.eventCodexRefCleared +
    r.eventRevealSceneCleared +
    r.editorStickies
  );
}

interface ProjectSnapshotModalProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 確認・結果のダイアログは、外れる件数が増えると縦にスクロールする。デスクトップ幅では
 * 操作の行を下に固定し、件数が多くても「復元する」・「OK」が最初から見えるようにする
 * （phone は全画面で、操作の行はスクロールで届く）。`DialogContent` の `p-4` の下端まで
 * 背景を伸ばすために、下の余白を負の margin で打ち消す。
 */
const STICKY_DIALOG_FOOTER = "sticky bottom-0 -mb-4 bg-popover pb-4 pt-2";

/**
 * 復元の前に、保留中の自動保存を保存する待ちの上限。保存が resolve も reject もしないと、
 * 「復元中」のまま確認の画面が固まるので、上限を超えたら失敗として扱う（復元を中止する）。
 */
const FLUSH_BEFORE_RESTORE_TIMEOUT_MS = 30_000;

async function flushAutoSavesBeforeRestore(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      flushAllAutoSaves(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("flush before restore timed out")),
          FLUSH_BEFORE_RESTORE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function ProjectSnapshotModal({
  open,
  onClose,
}: ProjectSnapshotModalProps) {
  const { t } = useTranslation();
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const [snapshots, setSnapshots] = useState<ProjectSnapshotMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Confirm states
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{
    dropped: RestoreLossNotice[];
    noOp: boolean;
  } | null>(null);
  const [restoreScopes, setRestoreScopes] = useState<Set<RestoreScope>>(() =>
    fullRestoreScopeSet(),
  );
  const restoreResultHandledRef = useRef(false);
  const restoreActionRef = useRef<HTMLButtonElement>(null);
  const deleteActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setShowCreate(false);
      setCreateName("");
      setCreateDesc("");
      setConfirmRestoreId(null);
      setConfirmDeleteId(null);
      setRestoreResult(null);
      setRestoreScopes(fullRestoreScopeSet());
      return;
    }
    restoreResultHandledRef.current = false;
    loadSnapshots();
    // loadSnapshots は同コンポーネント内のローカル関数で
    // open が立ち上がる初回ロードでのみ呼びたい。再実行不要。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 結果の画面が出ている間に、親が閉じた（`open` が false）・外した（unmount）ときも、
  // 再読み込みを 1 回だけ行う。復元で DB は書き換わっているので、再読み込みせずに
  // 編集へ戻してはいけない。本番の親は条件付き render で、閉じるのは unmount。
  const restoreResultRef = useRef(restoreResult);
  useEffect(() => {
    restoreResultRef.current = restoreResult;
  }, [restoreResult]);

  useEffect(() => {
    if (open || !restoreResult || restoreResultHandledRef.current) return;
    restoreResultHandledRef.current = true;
    void reloadRendererAfterReleasingGpuSurfaces();
  }, [open, restoreResult]);

  useEffect(() => {
    return () => {
      if (restoreResultRef.current && !restoreResultHandledRef.current) {
        restoreResultHandledRef.current = true;
        void reloadRendererAfterReleasingGpuSurfaces();
      }
    };
  }, []);

  async function loadSnapshots() {
    setIsLoading(true);
    try {
      const list = await listProjectSnapshots();
      setSnapshots(list);
    } catch (err) {
      debugLog.error("ProjectSnapshot", "load failed", errorDetail(err));
      toast.error(t("snapshot.loadError"));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreate() {
    if (!createName.trim()) return;
    setIsCreating(true);
    try {
      const result = await createProjectSnapshot({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
      });
      toast.success(
        t("snapshot.createSuccess", {
          name: createName.trim(),
          count: result.entryCount,
        }),
      );
      setShowCreate(false);
      setCreateName("");
      setCreateDesc("");
      await loadSnapshots();
    } catch (err) {
      debugLog.error("ProjectSnapshot", "create failed", errorDetail(err));
      toast.error(t("snapshot.createError"));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRestoreConfirm() {
    if (!confirmRestoreId) return;
    // 復元は DB 書き換え + window.location.reload() で全エディタを破棄するため、
    // 未確定の inline-AI diff があれば止める。
    if (guardInlineAiPending()) return;
    const snap = snapshots.find((s) => s.id === confirmRestoreId);
    if (!snap) return;
    setIsRestoring(true);
    try {
      try {
        await flushAutoSavesBeforeRestore();
      } catch (err) {
        debugLog.error(
          "ProjectSnapshot",
          "flush before restore failed",
          errorDetail(err),
        );
        toast.error(t("snapshot.restoreFlushFailed"));
        return;
      }
      const result = await restoreProjectSnapshot(snap.id, snap.name, {
        scopes: snap.isStructural ? restoreScopes : undefined,
      });
      // 復元で DB が置き換わった。復元前の履歴（Ctrl+Z・Ctrl+Y）を、復元後の DB へ
      // 再生させない。結果の画面は OK まで再読み込みを遅らせるので、その間も効く。
      useGlobalHistoryStore.getState().clear();
      toast.success(
        t("snapshot.restoreSuccess", {
          name: snap.name,
          count: result.restoredCount,
        }),
      );
      if (!skipReportIsEmpty(result.skipped)) {
        toast.info(
          t("snapshot.restoreSkipNote", {
            count: countSkipped(result.skipped),
          }),
        );
      }
      if (describeRestoreLoss(result.dropped).total > 0) {
        restoreResultHandledRef.current = false;
        setRestoreResult({ dropped: result.dropped, noOp: result.noOp });
        setConfirmRestoreId(null);
        setSelectedId(null);
        return;
      }
      setConfirmRestoreId(null);
      setSelectedId(null);
      onClose();
      // Content is restored in DB; page reload ensures editors reflect changes
      void reloadRendererAfterReleasingGpuSurfaces();
    } catch (err) {
      debugLog.error("ProjectSnapshot", "restore failed", errorDetail(err));
      toast.error(t("snapshot.restoreError"));
    } finally {
      setIsRestoring(false);
    }
  }

  function toggleScope(scope: RestoreScope): void {
    setRestoreScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  function openRestoreConfirm(snapshotId: string): void {
    setRestoreScopes(fullRestoreScopeSet());
    setConfirmRestoreId(snapshotId);
  }

  async function handleDeleteConfirm() {
    if (!confirmDeleteId) return;
    const snap = snapshots.find((s) => s.id === confirmDeleteId);
    setIsDeleting(true);
    try {
      await deleteProjectSnapshot(confirmDeleteId);
      toast.success(t("snapshot.deleteSuccess", { name: snap?.name ?? "" }));
      setConfirmDeleteId(null);
      if (selectedId === confirmDeleteId) setSelectedId(null);
      await loadSnapshots();
    } catch (err) {
      debugLog.error("ProjectSnapshot", "delete failed", errorDetail(err));
      toast.error(t("snapshot.deleteError"));
    } finally {
      setIsDeleting(false);
    }
  }

  const confirmRestoreSnap = confirmRestoreId
    ? snapshots.find((s) => s.id === confirmRestoreId)
    : null;
  const confirmDeleteSnap = confirmDeleteId
    ? snapshots.find((s) => s.id === confirmDeleteId)
    : null;
  const lossPreview = useRestoreLossPreview(
    confirmRestoreId,
    confirmRestoreSnap?.isStructural === true,
    restoreScopes,
    open && confirmRestoreId !== null && !isRestoring && restoreResult === null,
  );
  const lossPreviewSummary = describeRestoreLoss(lossPreview.notices);
  const restoreResultSummary = restoreResult
    ? describeRestoreLoss(restoreResult.dropped)
    : null;

  function finishRestoreResult(): void {
    if (!restoreResult || restoreResultHandledRef.current) return;
    restoreResultHandledRef.current = true;
    setRestoreResult(null);
    setConfirmRestoreId(null);
    setSelectedId(null);
    onClose();
    void reloadRendererAfterReleasingGpuSurfaces();
  }

  return (
    <>
      <ResponsiveAlertDialog
        open={open && confirmRestoreId !== null && restoreResult === null}
        onClose={() => {
          if (!isRestoring) setConfirmRestoreId(null);
        }}
        title={t("snapshot.restoreTitle")}
        description={
          <>
            {t("snapshot.restoreDesc", { name: confirmRestoreSnap?.name })}
            <br />
            {t("snapshot.restoreDescSub")}
          </>
        }
        className="w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto"
        restoreFocusRef={restoreActionRef}
      >
        {confirmRestoreSnap?.isStructural === false ? (
          <p className="mb-4 rounded border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {t("snapshot.restoreScopeLegacyNote")}
          </p>
        ) : (
          <div className="mb-4">
            <h3 className="mb-2 text-sm font-medium">
              {t("snapshot.restoreScopeHeading")}
            </h3>
            <div className="space-y-1.5">
              {RESTORE_SCOPES.map((scope) => (
                <label
                  key={scope}
                  aria-label={t(
                    `snapshot.scope${scope.charAt(0).toUpperCase() + scope.slice(1)}`,
                  )}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={restoreScopes.has(scope)}
                    onChange={() => toggleScope(scope)}
                    disabled={isRestoring}
                  />
                  <span className="flex-1">
                    <span className="block text-sm">
                      {t(
                        `snapshot.scope${scope.charAt(0).toUpperCase() + scope.slice(1)}`,
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        `snapshot.scope${scope.charAt(0).toUpperCase() + scope.slice(1)}Desc`,
                      )}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {!restoreScopes.has("body") && (
              <p className="mt-2 text-xs text-muted-foreground">
                ℹ {t("snapshot.restoreScopeHint")}
              </p>
            )}
            <RestoreLossSummary
              mode="preview"
              notices={lossPreview.notices}
              status={lossPreview.status}
              heading={t(
                lossPreview.status === "ready" &&
                  lossPreviewSummary.lostCount === 0 &&
                  lossPreviewSummary.resetCount > 0
                  ? "snapshot.loss.previewResetHeading"
                  : "snapshot.loss.previewHeading",
              )}
              note={t("snapshot.loss.previewNote")}
            />
          </div>
        )}

        <DialogFooter
          className={cn(
            phoneWorkspace ? "grid grid-cols-1" : STICKY_DIALOG_FOOTER,
          )}
        >
          <button
            type="button"
            className={cn(
              "rounded border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted",
              phoneWorkspace && "min-h-11 w-full",
            )}
            onClick={() => setConfirmRestoreId(null)}
            disabled={isRestoring}
          >
            {t("snapshot.cancel")}
          </button>
          <button
            type="button"
            className={cn(
              "rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50",
              phoneWorkspace && "min-h-11 w-full",
            )}
            onClick={handleRestoreConfirm}
            disabled={
              isRestoring ||
              (confirmRestoreSnap?.isStructural === true &&
                restoreScopes.size === 0)
            }
          >
            {isRestoring
              ? t("snapshot.restoring")
              : t("snapshot.restoreConfirm")}
          </button>
        </DialogFooter>
      </ResponsiveAlertDialog>
      <ResponsiveAlertDialog
        open={open && restoreResult !== null}
        onClose={finishRestoreResult}
        title={t("snapshot.loss.resultHeading")}
        description={
          restoreResultSummary?.lostCount === 0
            ? t("snapshot.loss.resultResetOnlyDescription")
            : restoreResult?.noOp
              ? t("snapshot.loss.resultNoOp")
              : t("snapshot.loss.resultDescription")
        }
        className="w-[480px] max-w-[95vw] max-h-[90vh] overflow-y-auto"
      >
        {restoreResult && (
          <>
            <RestoreLossSummary mode="result" notices={restoreResult.dropped} />
            <DialogFooter
              className={cn(
                phoneWorkspace ? "grid grid-cols-1" : STICKY_DIALOG_FOOTER,
              )}
            >
              <button
                type="button"
                className={cn(
                  "rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90",
                  phoneWorkspace && "min-h-11 w-full",
                )}
                onClick={finishRestoreResult}
              >
                {t("snapshot.loss.resultOk")}
              </button>
            </DialogFooter>
          </>
        )}
      </ResponsiveAlertDialog>
      <ResponsiveAlertDialog
        open={open && confirmDeleteId !== null}
        onClose={() => {
          if (!isDeleting) setConfirmDeleteId(null);
        }}
        title={t("snapshot.deleteTitle")}
        description={t("snapshot.deleteDesc", {
          name: confirmDeleteSnap?.name,
        })}
        className="w-[440px] max-w-[95vw]"
        restoreFocusRef={deleteActionRef}
      >
        <DialogFooter className={cn(phoneWorkspace && "grid grid-cols-1")}>
          <button
            type="button"
            className={cn(
              "rounded border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted",
              phoneWorkspace && "min-h-11 w-full",
            )}
            onClick={() => setConfirmDeleteId(null)}
            disabled={isDeleting}
          >
            {t("snapshot.cancel")}
          </button>
          <button
            type="button"
            className={cn(
              "rounded bg-destructive px-3 py-1.5 text-sm text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50",
              phoneWorkspace && "min-h-11 w-full",
            )}
            onClick={handleDeleteConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? t("snapshot.deleting") : t("snapshot.deleteConfirm")}
          </button>
        </DialogFooter>
      </ResponsiveAlertDialog>
      <AnimatedOverlay
        open={
          open &&
          !confirmRestoreId &&
          !confirmDeleteId &&
          restoreResult === null &&
          !restoreResultHandledRef.current
        }
        onClose={onClose}
        className="bg-background rounded-lg border border-border shadow-xl w-[580px] max-w-[95vw] flex flex-col max-h-[80vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold">{t("snapshot.title")}</h2>
          <button
            type="button"
            aria-label={t("snapshot.close")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {/* Create form */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          {showCreate ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder={t("snapshot.namePlaceholder")}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setShowCreate(false);
                }}
              />
              <input
                type="text"
                placeholder={t("snapshot.descPlaceholder")}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
                  onClick={() => setShowCreate(false)}
                  disabled={isCreating}
                >
                  {t("snapshot.cancel")}
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  onClick={handleCreate}
                  disabled={isCreating || !createName.trim()}
                >
                  {isCreating ? t("snapshot.creating") : t("snapshot.create")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full rounded border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/50 transition-colors"
              onClick={() => setShowCreate(true)}
            >
              {t("snapshot.newSnapshot")}
            </button>
          )}
        </div>

        {/* Snapshot list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            <RevisionRowSkeletonList testId="snapshot-list-loading" />
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("snapshot.empty")}
            </p>
          ) : (
            snapshots.map((snap) => (
              <button
                key={snap.id}
                type="button"
                onClick={() =>
                  setSelectedId(snap.id === selectedId ? null : snap.id)
                }
                className={[
                  "w-full text-left px-3 py-2 rounded text-sm transition-colors",
                  snap.id === selectedId
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-muted text-foreground",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="flex items-center gap-1 font-medium">
                      <Star
                        className="h-3.5 w-3.5 shrink-0 fill-current"
                        aria-hidden
                      />
                      <span className="truncate">{snap.name}</span>
                    </span>
                    {snap.description && (
                      <span className="text-xs text-muted-foreground block truncate">
                        {snap.description}
                      </span>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <span className="block text-xs text-muted-foreground">
                      {formatTimestamp(snap.createdAt)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("snapshot.entityCount", { count: snap.entryCount })}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            ref={deleteActionRef}
            type="button"
            className="px-3 py-1.5 text-sm rounded border border-destructive text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => selectedId && setConfirmDeleteId(selectedId)}
            disabled={!selectedId}
          >
            {t("snapshot.delete")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
              onClick={onClose}
            >
              {t("snapshot.close")}
            </button>
            <button
              ref={restoreActionRef}
              type="button"
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => selectedId && openRestoreConfirm(selectedId)}
              disabled={!selectedId}
            >
              {t("snapshot.restore")}
            </button>
          </div>
        </div>
      </AnimatedOverlay>
    </>
  );
}
