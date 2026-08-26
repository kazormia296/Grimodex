import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useTreeStore,
  getDescendantScenesInOrder,
} from "@/features/tree/treeStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { saveScene } from "@/features/editor/editorSaveRegistry";
import { loadSceneContents } from "@/features/tree/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { listEvents } from "./api";
import { buildLiveChronicleExistingEventCatalog } from "./extraction/existingEventCatalog";
import {
  discardChronicleTaskResumeCandidate,
  discoverChronicleTaskResumeCandidates,
  startChronicleExtraction,
  resumeChronicleExtraction,
  applyChronicleExtractionReview,
  restoreChronicleExtractionReview,
} from "./extractEventsApi";
import type { ChronicleTaskResumeCandidate } from "@/application/narrative-extraction/nativeApi";
import { ChronicleExtractionProgress } from "./ChronicleExtractionProgress";
import { ChronicleProposalReview } from "./ChronicleProposalReview";
import { useChronicleExtractionStore } from "./chronicleExtractionStore";
import {
  chronicleScopeKey,
  type ChronicleScope,
  type ChronicleScopeKey,
} from "./chronicleScope";

export interface ChronicleExtractionSession {
  scope: ChronicleScope;
  scopeKey: ChronicleScopeKey;
  projectId: string;
  generation: number;
  authority: MutationAuthority;
}

export async function loadChronicleExtractionScenes(
  sceneNodes: readonly Pick<TreeNodeData, "id" | "title">[],
  loadContents: typeof loadSceneContents = loadSceneContents,
) {
  const contents = await loadContents(sceneNodes.map((scene) => scene.id));
  return sceneNodes.map((scene, orderIndex) => ({
    sceneId: scene.id,
    title: scene.title,
    // Match loadSceneContent's missing-row contract.
    bodyText: extractPlainText(contents.get(scene.id) ?? ""),
    orderIndex,
  }));
}

/**
 * 本文（章/フォルダ）から LLM で作中の出来事候補を抽出し、確認のうえ一括取り込みする
 * ウィザード。Run-based Narrative Extraction が唯一の製品経路
 *（`extractEventsApi.USE_NARRATIVE_EXTRACTION_RUN === true`）。
 */
export function ChronicleExtractDialog({
  open,
  onOpenChange,
  onImported,
  scope,
  isActive = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
  scope: ChronicleScope | null;
  isActive?: boolean;
}) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const runProjection = useChronicleExtractionStore((s) => s.projection);
  const recovery = useChronicleExtractionStore((s) => s.recovery);
  const clearProjection = useChronicleExtractionStore((s) => s.clearProjection);
  const clearIfScopeMismatch = useChronicleExtractionStore(
    (s) => s.clearIfScopeMismatch,
  );

  const folders = useMemo(
    () => nodes.filter((n) => n.nodeType === "folder"),
    [nodes],
  );

  const [folderId, setFolderId] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [discardingRunId, setDiscardingRunId] = useState<string | null>(null);
  const currentScopeKey = scope ? chronicleScopeKey(scope) : null;
  const generationRef = useRef(0);
  const dialogScopeKeyRef = useRef<ChronicleScopeKey | null>(null);
  const openRef = useRef(open);
  const isActiveRef = useRef(isActive);
  const currentScopeKeyRef = useRef<ChronicleScopeKey | null>(currentScopeKey);
  openRef.current = open;
  isActiveRef.current = isActive;
  currentScopeKeyRef.current = currentScopeKey;

  const scopedRunProjection =
    isActive &&
    scope &&
    runProjection &&
    runProjection.projectId === scope.projectId &&
    runProjection.workspacePath === scope.workspacePath &&
    runProjection.openRevision === scope.openRevision
      ? runProjection
      : null;

  const isSessionCurrent = (session: ChronicleExtractionSession): boolean => {
    const workspace = useWorkspaceStore.getState();
    return (
      generationRef.current === session.generation &&
      openRef.current &&
      isActiveRef.current &&
      currentScopeKeyRef.current === session.scopeKey &&
      workspace.workspaceHydrated &&
      !workspace.workspaceSwitchInProgress &&
      workspace.activeWorkspacePath === session.scope.workspacePath &&
      workspace.workspaceOpenRevision === session.scope.openRevision &&
      getCurrentProjectId() === session.projectId &&
      isCurrentMutationAuthority(session.authority)
    );
  };

  // ダイアログは親側で常時マウントされる。閉じても同 scope の Run 投影は保持し、
  // 再オープン時に Review を復元する。scope 不一致時のみ破棄する。
  useEffect(() => {
    if (!open) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      setFolderId("");
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      return;
    }

    if (!isActive || !currentScopeKey || !scope) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      clearProjection();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      onOpenChange(false);
      return;
    }

    clearIfScopeMismatch({
      projectId: scope.projectId,
      workspacePath: scope.workspacePath,
      openRevision: scope.openRevision,
    });

    if (dialogScopeKeyRef.current === null) {
      dialogScopeKeyRef.current = currentScopeKey;
      generationRef.current += 1;
      setFolderId("");
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      const current = useChronicleExtractionStore.getState().projection;
      const matched =
        current &&
        current.projectId === scope.projectId &&
        current.workspacePath === scope.workspacePath &&
        current.openRevision === scope.openRevision;
      if (!matched) {
        void restoreChronicleExtractionReview({
          projectId: scope.projectId,
          workspacePath: scope.workspacePath,
          openRevision: scope.openRevision,
        }).catch(() => {
          // Soft-fail: empty review until the user runs analyze.
        });
      }
      void discoverChronicleTaskResumeCandidates({
        projectId: scope.projectId,
        workspacePath: scope.workspacePath,
        openRevision: scope.openRevision,
      }).catch(() => {
        // The API retains an explicit blocked recovery state. Never reinterpret
        // a failed durable-ledger read as permission to create a fresh Run.
      });
      return;
    }

    if (dialogScopeKeyRef.current !== currentScopeKey) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      clearProjection();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      onOpenChange(false);
    }
  }, [
    clearIfScopeMismatch,
    clearProjection,
    currentScopeKey,
    isActive,
    onOpenChange,
    open,
    scope,
  ]);

  const handleSelectFolder = (id: string) => {
    if (
      analyzing ||
      importing ||
      discardingRunId !== null ||
      recovery.status === "resuming"
    ) {
      return;
    }
    setFolderId(id);
    clearProjection();
  };

  const handleAnalyze = async () => {
    const unresolvedRecovery =
      recovery.status === "discovering" ||
      recovery.status === "resuming" ||
      recovery.status === "blocked" ||
      recovery.candidates.length > 0 ||
      discardingRunId !== null;
    if (
      !folderId ||
      analyzing ||
      importing ||
      unresolvedRecovery ||
      !scope ||
      !currentScopeKey
    ) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const session: ChronicleExtractionSession = {
      scope,
      scopeKey: currentScopeKey,
      projectId: scope.projectId,
      generation,
      authority: captureMutationAuthority(scope.projectId, getCurrentProjectId),
    };
    if (!isSessionCurrent(session)) return;

    setAnalyzing(true);
    clearProjection();
    try {
      const activeId = useTreeStore.getState().activeSceneId;
      if (activeId) await saveScene(activeId);
      if (!isSessionCurrent(session)) return;

      // 直下のシーンだけでなく、配下の全シーン（部>章>シーン等の入れ子も）を
      // DFS pre-order（ツリー表示順）で収集する。直下フィルタだと入れ子構造で
      // 候補が黙って空になる。
      const sceneNodes = getDescendantScenesInOrder(
        useTreeStore.getState().nodes,
        folderId,
      );
      const scenes = await loadChronicleExtractionScenes(sceneNodes);
      if (!isSessionCurrent(session)) return;
      const existing = await listEvents(session.projectId);
      if (!isSessionCurrent(session)) return;

      await startChronicleExtraction({
        projectId: session.projectId,
        folderId,
        sceneIds: scenes.map((scene) => scene.sceneId),
        authority: session.authority,
        workspacePath: session.scope.workspacePath,
        openRevision: session.scope.openRevision,
        existingEvents: buildLiveChronicleExistingEventCatalog(existing),
      });
      if (!isSessionCurrent(session)) {
        clearProjection();
        return;
      }
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(t("chronicle.extract.failed", "抽出に失敗しました"));
      }
    } finally {
      if (generationRef.current === session.generation) {
        setAnalyzing(false);
      }
    }
  };

  const handleResume = async (candidate: ChronicleTaskResumeCandidate) => {
    if (
      analyzing ||
      importing ||
      recovery.status !== "ready" ||
      candidate.availability !== "ready" ||
      discardingRunId !== null ||
      !scope ||
      !currentScopeKey
    ) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const session: ChronicleExtractionSession = {
      scope,
      scopeKey: currentScopeKey,
      projectId: scope.projectId,
      generation,
      authority: captureMutationAuthority(scope.projectId, getCurrentProjectId),
    };
    if (!isSessionCurrent(session)) return;

    clearProjection();
    try {
      await resumeChronicleExtraction({
        candidate,
        authority: session.authority,
        workspacePath: session.scope.workspacePath,
        openRevision: session.scope.openRevision,
      });
      if (!isSessionCurrent(session)) {
        clearProjection();
      }
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(
          t(
            "chronicle.extract.resumeFailed",
            "中断した抽出を再開できませんでした",
          ),
        );
      }
    }
  };

  const handleDiscard = async (candidate: ChronicleTaskResumeCandidate) => {
    if (
      analyzing ||
      importing ||
      discardingRunId !== null ||
      (recovery.status !== "ready" && recovery.status !== "blocked") ||
      candidate.availability !== "blocked" ||
      !scope ||
      !currentScopeKey
    ) {
      return;
    }
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const session: ChronicleExtractionSession = {
      scope,
      scopeKey: currentScopeKey,
      projectId: scope.projectId,
      generation,
      authority: captureMutationAuthority(scope.projectId, getCurrentProjectId),
    };
    if (!isSessionCurrent(session)) return;

    setDiscardingRunId(candidate.runId);
    try {
      await discardChronicleTaskResumeCandidate({
        candidate,
        authority: session.authority,
        workspacePath: session.scope.workspacePath,
        openRevision: session.scope.openRevision,
      });
      if (!isSessionCurrent(session)) {
        clearProjection();
        onOpenChange(false);
        return;
      }
      setFolderId(candidate.scopeJson.folderId);
      toast.success(
        t(
          "chronicle.extract.discardedInterruptedRun",
          "中断した抽出を破棄しました。新しい解析を開始できます。",
        ),
      );
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(
          t(
            "chronicle.extract.discardFailed",
            "中断した抽出を破棄できませんでした",
          ),
        );
      }
    } finally {
      if (generationRef.current === session.generation) {
        setDiscardingRunId(null);
      }
    }
  };

  const handleImport = async () => {
    if (importing || !scopedRunProjection || !scope) return;

    const approvedCount = scopedRunProjection.proposals.filter(
      (proposal) =>
        proposal.applicability === "applicable" &&
        proposal.status === "approved",
    ).length;
    if (approvedCount === 0) return;

    const generation = generationRef.current;
    const authority = captureMutationAuthority(
      scope.projectId,
      getCurrentProjectId,
    );
    const session: ChronicleExtractionSession = {
      scope,
      scopeKey: currentScopeKey ?? chronicleScopeKey(scope),
      projectId: scope.projectId,
      generation,
      authority,
    };
    if (!isSessionCurrent(session)) {
      clearProjection();
      onOpenChange(false);
      return;
    }

    setImporting(true);
    try {
      const outcome = await runAuthoritativeMutation(session.authority, () =>
        applyChronicleExtractionReview({
          projectId: session.projectId,
          proposals: scopedRunProjection.proposals,
        }),
      );
      if (outcome.status === "stale" || !isSessionCurrent(session)) {
        clearProjection();
        onOpenChange(false);
        return;
      }
      const n = outcome.value;
      toast.success(
        t(
          "chronicle.extract.imported",
          "{{count}}件のイベントを取り込みました",
          { count: n },
        ),
      );
      clearProjection();
      onImported?.();
      onOpenChange(false);
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(t("chronicle.extract.failed", "抽出に失敗しました"));
      }
    } finally {
      if (generationRef.current === session.generation) {
        setImporting(false);
      }
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && (importing || discardingRunId !== null)) return;
    onOpenChange(nextOpen);
  };

  const approvedReady =
    !!scopedRunProjection &&
    scopedRunProjection.proposals.some(
      (proposal) =>
        proposal.applicability === "applicable" &&
        proposal.status === "approved" &&
        (proposal.match.status !== "probable-duplicate" ||
          proposal.probableDuplicateChoice === "create-as-new"),
    );
  const recoveryUnresolved =
    recovery.status === "discovering" ||
    recovery.status === "resuming" ||
    recovery.status === "blocked" ||
    recovery.candidates.length > 0 ||
    discardingRunId !== null;
  const resuming = recovery.status === "resuming";

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className={
          scopedRunProjection
            ? "flex max-h-[85vh] max-w-3xl flex-col"
            : "max-w-lg"
        }
      >
        <DialogHeader>
          <DialogTitle>
            {t("chronicle.extract.title", "本文からイベントを抽出")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {t(
              "chronicle.extract.hint",
              "選んだ章/フォルダの本文を AI が読み、作中のイベントを提案します。取り込むと年表に追加されます。",
            )}
          </p>

          {(recovery.status === "discovering" ||
            recovery.status === "blocked" ||
            recovery.candidates.length > 0) && (
            <div
              className="flex flex-col gap-2 rounded border border-border bg-muted/30 p-2"
              data-testid="chronicle-extraction-recovery"
            >
              <p className="text-xs font-medium">
                {recovery.status === "discovering"
                  ? t(
                      "chronicle.extract.recoveryDiscovering",
                      "中断した抽出を確認しています…",
                    )
                  : recovery.status === "blocked" &&
                      recovery.candidates.length === 0
                    ? t(
                        "chronicle.extract.recoveryBlocked",
                        "中断した抽出の状態を確認できません。新しい解析は開始されません。",
                      )
                    : t(
                        "chronicle.extract.recoveryFound",
                        "前回中断した抽出があります",
                      )}
              </p>
              {recovery.candidates.map((candidate) => (
                <div
                  key={candidate.runId}
                  className="flex items-center justify-between gap-2 rounded bg-background px-2 py-1.5"
                >
                  <span
                    className="min-w-0 text-xs text-muted-foreground"
                    title={`${candidate.runId} · ${candidate.createdAt}`}
                  >
                    <span className="block truncate">
                      {candidate.scopeJson.folderId} ·{" "}
                      {candidate.nextTask.taskKind}
                    </span>
                    <span className="block truncate font-mono text-[10px]">
                      {candidate.runId} · {candidate.createdAt}
                    </span>
                  </span>
                  {candidate.availability === "blocked" ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[10px] text-destructive">
                        {t("chronicle.extract.resumeBlocked", "再開不可")}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDiscard(candidate)}
                        aria-label={`${t(
                          "chronicle.extract.discardInterruptedRun",
                          "中断Runを破棄",
                        )} ${candidate.runId}`}
                        disabled={
                          (recovery.status !== "ready" &&
                            recovery.status !== "blocked") ||
                          discardingRunId !== null ||
                          analyzing ||
                          importing
                        }
                        className="inline-flex items-center gap-1 rounded border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {discardingRunId === candidate.runId && (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden
                          />
                        )}
                        {discardingRunId === candidate.runId
                          ? t("chronicle.extract.discarding", "破棄中")
                          : t(
                              "chronicle.extract.discardInterruptedRun",
                              "中断Runを破棄",
                            )}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleResume(candidate)}
                      aria-label={`${
                        candidate.availability === "ready"
                          ? t("chronicle.extract.resume", "再開")
                          : t("chronicle.extract.resumeLeaseHeld", "処理中")
                      } ${candidate.runId}`}
                      disabled={
                        recovery.status !== "ready" ||
                        candidate.availability !== "ready" ||
                        discardingRunId !== null ||
                        analyzing ||
                        importing
                      }
                      className="shrink-0 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {candidate.availability === "ready"
                        ? t("chronicle.extract.resume", "再開")
                        : t("chronicle.extract.resumeLeaseHeld", "処理中")}
                    </button>
                  )}
                </div>
              ))}
              {recovery.status === "blocked" && recovery.errorCode && (
                <code className="break-all text-[10px] text-destructive">
                  {recovery.errorCode}
                </code>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <select
              value={folderId}
              onChange={(e) => handleSelectFolder(e.target.value)}
              disabled={analyzing || importing || recoveryUnresolved}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
            >
              <option value="">
                {t("chronicle.extract.selectFolder", "章/フォルダを選択…")}
              </option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title || t("chronicle.unnamed", "（無名）")}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={
                !folderId ||
                analyzing ||
                importing ||
                recoveryUnresolved ||
                !scope
              }
              className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {analyzing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
              )}
              {t("chronicle.extract.analyze", "解析")}
            </button>
          </div>

          {(analyzing || resuming || scopedRunProjection) && (
            <ChronicleExtractionProgress
              analyzing={analyzing || resuming}
              coverage={scopedRunProjection?.coverage ?? null}
              taskCounts={scopedRunProjection?.taskCounts ?? null}
              proposalCount={
                scopedRunProjection?.proposals.filter(
                  (proposal) => proposal.applicability === "applicable",
                ).length ?? 0
              }
            />
          )}

          {scopedRunProjection && <ChronicleProposalReview boundToStore />}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => handleDialogOpenChange(false)}
            disabled={importing || discardingRunId !== null}
            className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel", "キャンセル")}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || discardingRunId !== null || !approvedReady}
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            {t("chronicle.extract.import", "取り込む")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
