import { isChronicleReanalysisRequired } from "./extraction/savedPlanActualityGate";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  abandonChroniclePartialReview,
  restoreChronicleExtractionReview,
} from "./extractEventsApi";
import type { ChronicleTaskResumeCandidate } from "@/application/narrative-extraction/nativeApi";
import { measureSceneCanonicalBodyLength } from "@/application/narrative-extraction/sceneBodyLength";
import { ChronicleExtractionProgress } from "./ChronicleExtractionProgress";
import { ChronicleProposalReview } from "./ChronicleProposalReview";
import { ChronicleExtractStartNotices } from "./ChronicleExtractStartNotices";
import {
  chronicleCurrentSceneOptionValue,
  chronicleExtractTargetOptionValue,
  countChronicleUnsettledProposals,
  isFolderEquivalentSingleScene,
  resolveChronicleExtractScene,
  resolveDiscardedRunTarget,
  singleSceneIdOfScope,
  type ChronicleExtractTarget,
  type ChronicleSceneUnavailableReason,
  type ChronicleStartNoticeKind,
} from "./chronicleExtractScene";
import { useChronicleExtractionStore } from "./chronicleExtractionStore";
import {
  getChronicleApplyReadiness,
  classifyChronicleApplyFailure,
} from "./chronicleExtractionStore";
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
 * 同じ場面の承認済み・未取り込みの提案の読み取り（S8b）。常時マウントされるダイアログの
 * 起動 graph に載せないよう、遅延 import する。読み取りの失敗は「知らせない」側に倒す
 * （知らせは補助で、安全の境界ではない）。
 */
async function readSameSceneApprovedUnapplied(
  projectId: string,
  sceneId: string,
): Promise<boolean> {
  try {
    const mod = await import("./chronicleExtractionApi");
    return await mod.hasApprovedUnappliedProposalForScene({
      projectId,
      sceneId,
    });
  } catch {
    return false;
  }
}

interface ChronicleStartNoticeState {
  readonly kinds: readonly ChronicleStartNoticeKind[];
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
  const reviewMutationInFlight = useChronicleExtractionStore(
    (s) => s.reviewMutationCount > 0,
  );
  const applyMutationInFlight = useChronicleExtractionStore(
    (s) => s.applyMutationInFlight,
  );
  const tryBeginApplyMutation = useChronicleExtractionStore(
    (s) => s.tryBeginApplyMutation,
  );
  const endApplyMutation = useChronicleExtractionStore(
    (s) => s.endApplyMutation,
  );
  const clearProjection = useChronicleExtractionStore((s) => s.clearProjection);
  const clearIfScopeMismatch = useChronicleExtractionStore(
    (s) => s.clearIfScopeMismatch,
  );

  const folders = useMemo(
    () => nodes.filter((n) => n.nodeType === "folder"),
    [nodes],
  );
  const resetTargetState = useCallback(() => {
    setTarget(null);
    setStartNotices(null);
    setPriorPendingCount(0);
  }, []);

  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  // 「今の場面」は、描くたびに今の値から導く。
  const currentScene = resolveChronicleExtractScene(nodes, activeSceneId);
  const [target, setTarget] = useState<ChronicleExtractTarget | null>(null);
  // 解析を押した後に出した知らせ。同じ「解析」をもう一度押すと始まる。
  const [startNotices, setStartNotices] =
    useState<ChronicleStartNoticeState | null>(null);
  // 対象を選んだ時点で画面に開いていた組の、未取り込みの提案の件数。
  // 選択を変えると画面の組は外れるので、そのときの値を控える（S8）。
  const [priorPendingCount, setPriorPendingCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [discardingRunId, setDiscardingRunId] = useState<string | null>(null);
  const [abandoningPartialRunId, setAbandoningPartialRunId] = useState<
    string | null
  >(null);
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
      resetTargetState();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      setAbandoningPartialRunId(null);
      return;
    }

    if (!isActive || !currentScopeKey || !scope) {
      dialogScopeKeyRef.current = null;
      generationRef.current += 1;
      clearProjection();
      resetTargetState();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      setAbandoningPartialRunId(null);
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
      resetTargetState();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      setAbandoningPartialRunId(null);
      const current = useChronicleExtractionStore.getState().projection;
      const matched =
        current &&
        current.projectId === scope.projectId &&
        current.workspacePath === scope.workspacePath &&
        current.openRevision === scope.openRevision;
      if (!matched) {
        const restoreGeneration = generationRef.current;
        void restoreChronicleExtractionReview({
          projectId: scope.projectId,
          workspacePath: scope.workspacePath,
          openRevision: scope.openRevision,
        }).catch((error: unknown) => {
          if (
            isChronicleReanalysisRequired(error) &&
            generationRef.current === restoreGeneration &&
            openRef.current &&
            isActiveRef.current &&
            currentScopeKeyRef.current === currentScopeKey
          ) {
            toast.error(
              t(
                "chronicle.extract.reanalysisRequired",
                "保存済みの抽出候補を復元できません。本文から再解析してください。",
              ),
            );
          }
          // Other restore failures keep the existing empty-review behavior.
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
      resetTargetState();
      setAnalyzing(false);
      setImporting(false);
      setDiscardingRunId(null);
      setAbandoningPartialRunId(null);
      onOpenChange(false);
    }
  }, [
    clearIfScopeMismatch,
    clearProjection,
    currentScopeKey,
    isActive,
    onOpenChange,
    open,
    resetTargetState,
    scope,
    t,
  ]);

  const handleSelectTarget = (value: string) => {
    if (
      analyzing ||
      importing ||
      applyMutationInFlight ||
      reviewMutationInFlight ||
      abandoningPartialRunId !== null ||
      discardingRunId !== null ||
      recovery.status === "resuming"
    ) {
      return;
    }
    // 画面に組が開いているうちに、未取り込みの件数を控える。選択を変えると組は外れる。
    if (scopedRunProjection) {
      setPriorPendingCount(
        countChronicleUnsettledProposals(scopedRunProjection.proposals),
      );
    }
    setStartNotices(null);
    // 場面の項目は、今の場面か、選択済みの場面の value のときだけ場面として扱う
    // （フォルダの id と接頭辞が衝突しても、フォルダを場面と取り違えない）。
    if (
      currentScene.available &&
      value === chronicleCurrentSceneOptionValue(currentScene.sceneId)
    ) {
      setTarget({
        kind: "scene",
        sceneId: currentScene.sceneId,
        folderId: currentScene.folderId,
      });
    } else if (
      target?.kind === "scene" &&
      value === chronicleCurrentSceneOptionValue(target.sceneId)
    ) {
      setTarget(target);
    } else {
      setTarget(value ? { kind: "folder", folderId: value } : null);
    }
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
      !target ||
      analyzing ||
      importing ||
      applyMutationInFlight ||
      reviewMutationInFlight ||
      abandoningPartialRunId !== null ||
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
    try {
      const activeId = useTreeStore.getState().activeSceneId;
      if (activeId) await saveScene(activeId);
      // 選んだ場面が開いている場面と別のときも、保存を待つ（開いていなければ何もしない）。
      if (target.kind === "scene" && target.sceneId !== activeId) {
        await saveScene(target.sceneId);
      }
      if (!isSessionCurrent(session)) return;

      // 始める前の確認と知らせ。場面の抽出では、保存の後の本文が空でないことを確かめる。
      // 長い場面でも知らせない（区切りの数は材料の再生を妨げない。MW/1 M8）。
      const notices = new Set<ChronicleStartNoticeKind>();
      let sceneStart: { sceneId: string; parentFolderId: string } | null = null;
      if (target.kind === "scene") {
        const scene = resolveChronicleExtractScene(
          useTreeStore.getState().nodes,
          target.sceneId,
        );
        if (!scene.available || scene.folderId !== target.folderId) {
          // 選んだ後に、場面が消えた・フォルダの外へ移された。始めない。
          toast.error(
            t(
              "chronicle.extract.sceneUnavailable",
              "選んだ場面が見つからないか、フォルダに入っていません。選び直してください。",
            ),
          );
          setTarget(null);
          setStartNotices(null);
          return;
        }
        sceneStart = {
          sceneId: scene.sceneId,
          parentFolderId: scene.folderId,
        };
        // SceneBodyLengthError は、今の抽出の失敗と同じ扱い（下の catch）。
        const { canonicalLength } = await measureSceneCanonicalBodyLength(
          session.projectId,
          scene.sceneId,
        );
        if (!isSessionCurrent(session)) return;
        if (canonicalLength === 0) {
          toast.error(
            t("chronicle.extract.sceneEmpty", "本文が空のため抽出できません。"),
          );
          return;
        }
        if (
          await readSameSceneApprovedUnapplied(session.projectId, scene.sceneId)
        ) {
          notices.add("same-scene-approved");
        }
        if (!isSessionCurrent(session)) return;
      }
      const pendingCount = scopedRunProjection
        ? countChronicleUnsettledProposals(scopedRunProjection.proposals)
        : priorPendingCount;

      // 知らせるべきことがあれば、同じ「解析」をもう一度押すまで始めない。
      // すでに見せた知らせに無い種類が増えたときは、出し直す。
      const shown = startNotices?.kinds ?? [];
      if ([...notices].some((kind) => !shown.includes(kind))) {
        setStartNotices({ kinds: [...notices] });
        return;
      }

      setStartNotices(null);
      clearProjection();

      let startFolderId: string;
      let startSceneIds: string[];
      if (sceneStart !== null) {
        // 場面 1 つ：親のフォルダと、その場面だけ。木の全走査はしない。
        startFolderId = sceneStart.parentFolderId;
        startSceneIds = [sceneStart.sceneId];
      } else {
        startFolderId = target.folderId;
        // 直下のシーンだけでなく、配下の全シーン（部>章>シーン等の入れ子も）を
        // DFS pre-order（ツリー表示順）で収集する。直下フィルタだと入れ子構造で
        // 候補が黙って空になる。
        const sceneNodes = getDescendantScenesInOrder(
          useTreeStore.getState().nodes,
          target.folderId,
        );
        const scenes = await loadChronicleExtractionScenes(sceneNodes);
        startSceneIds = scenes.map((scene) => scene.sceneId);
      }
      if (!isSessionCurrent(session)) return;
      const existing = await listEvents(session.projectId);
      if (!isSessionCurrent(session)) return;

      // 前の組の提案が残っていても止めない。始めるときに知らせる（SSE/1 S8）。
      if (pendingCount > 0) {
        toast.info(
          t(
            "chronicle.extract.noticePendingReview",
            "前の組の提案が{{count}}件残っています。提案は消えません。新しい組の提案をすべて取り込むか拒否すると、前の組に戻れます。承認済みで秘密の印を外した提案は、取り込まなくても関連場面に使われることがあります。",
            { count: pendingCount },
          ),
        );
      }
      await startChronicleExtraction({
        projectId: session.projectId,
        folderId: startFolderId,
        sceneIds: startSceneIds,
        // フォルダの抽出は、今までどおり sceneScopeMode を渡さない。
        ...(sceneStart !== null
          ? { sceneScopeMode: "requested-direct-children" as const }
          : {}),
        authority: session.authority,
        workspacePath: session.scope.workspacePath,
        openRevision: session.scope.openRevision,
        existingEvents: buildLiveChronicleExistingEventCatalog(existing),
      });
      if (!isSessionCurrent(session)) {
        clearProjection();
        return;
      }
      // 新しい組が画面に出た。前の組の件数はもう要らない。
      setPriorPendingCount(0);
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
      // 場面 1 つの抽出なら、その場面が今も選べるときだけ場面に戻す（S9）。
      setStartNotices(null);
      setTarget(
        resolveDiscardedRunTarget(
          candidate.scopeJson,
          useTreeStore.getState().nodes,
        ),
      );
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
    if (
      importing ||
      reviewMutationInFlight ||
      useChronicleExtractionStore.getState().reviewMutationCount > 0 ||
      !scopedRunProjection ||
      !scope
    ) {
      return;
    }

    const readiness = getChronicleApplyReadiness(scopedRunProjection.proposals);
    if (!readiness.ready) return;

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
    if (!tryBeginApplyMutation()) return;

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
    } catch (error) {
      if (isSessionCurrent(session)) {
        const reason = classifyChronicleApplyFailure(error);
        toast.error(
          reason === "lineage-invalid"
            ? t(
                "chronicle.extract.applyLineageInvalid",
                "編集した提案の履歴を確かめられないため、取り込めません。抽出し直してください",
              )
            : reason === "disclosure-scope-stale"
              ? t(
                  "chronicle.extract.applyDisclosureScopeStale",
                  "場面の並びや開示の設定が変わった可能性があります。編集した提案の開示の設定を選び直してから、取り込んでください",
                )
              : reason === "source-stale"
                ? t(
                    "chronicle.extract.applySourceStale",
                    "抽出の後に原稿などが変わったため、取り込めません。抽出し直してください",
                  )
                : t("chronicle.extract.importFailed", "取り込みに失敗しました"),
        );
      }
    } finally {
      endApplyMutation();
      if (generationRef.current === session.generation) {
        setImporting(false);
      }
    }
  };

  const handleAbandonPartialReview = async () => {
    const projection = scopedRunProjection;
    if (
      !projection ||
      !scope ||
      importing ||
      analyzing ||
      applyMutationInFlight ||
      reviewMutationInFlight ||
      abandoningPartialRunId !== null ||
      discardingRunId !== null
    ) {
      return;
    }
    const readiness = getChronicleApplyReadiness(projection.proposals);
    if (
      readiness.errorCode !== "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH" ||
      !projection.proposals.some((proposal) => proposal.application !== null)
    ) {
      return;
    }

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
    if (!isSessionCurrent(session)) return;

    setAbandoningPartialRunId(projection.runId);
    try {
      const outcome = await runAuthoritativeMutation(session.authority, () =>
        abandonChroniclePartialReview({
          runId: projection.runId,
          projectId: projection.projectId,
        }),
      );
      if (outcome.status === "stale" || !isSessionCurrent(session)) {
        onOpenChange(false);
        return;
      }
      resetTargetState();
      toast.success(
        t(
          "chronicle.extract.partialReviewAbandoned",
          "未適用の提案を破棄しました。新しく解析できます。",
        ),
      );
    } catch {
      if (isSessionCurrent(session)) {
        toast.error(
          t(
            "chronicle.extract.partialReviewAbandonFailed",
            "未適用の提案を破棄できませんでした。状態を確認して再試行してください。",
          ),
        );
      }
    } finally {
      if (generationRef.current === session.generation) {
        setAbandoningPartialRunId(null);
      }
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (
      !nextOpen &&
      (importing ||
        applyMutationInFlight ||
        abandoningPartialRunId !== null ||
        discardingRunId !== null)
    ) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const applyReadiness = scopedRunProjection
    ? getChronicleApplyReadiness(scopedRunProjection.proposals)
    : null;
  const approvedReady = applyReadiness?.ready ?? false;
  const hasPriorApplication =
    scopedRunProjection?.proposals.some(
      (proposal) => proposal.application !== null,
    ) ?? false;
  const recoveryUnresolved =
    recovery.status === "discovering" ||
    recovery.status === "resuming" ||
    recovery.status === "blocked" ||
    recovery.candidates.length > 0 ||
    discardingRunId !== null;
  const resuming = recovery.status === "resuming";
  const unnamedLabel = t("chronicle.unnamed", "（無名）");
  // 場面の題。木に無ければ削除済み（再開の候補の行と、選択済みの場面の項目に使う）。
  const sceneLabel = (sceneId: string): string => {
    const node = nodes.find((n) => n.id === sceneId && n.nodeType === "scene");
    return node
      ? t("chronicle.extract.scene", "場面：{{title}}", {
          title: node.title || unnamedLabel,
        })
      : t("chronicle.extract.sceneDeleted", "場面（削除済み）");
  };
  const recoveryScopeLabel = (candidate: ChronicleTaskResumeCandidate) => {
    const sceneId = singleSceneIdOfScope(candidate.scopeJson);
    // 破棄の後の対象の判定と同じ規則：配下の場面がその 1 つだけならフォルダ。
    return sceneId === null ||
      isFolderEquivalentSingleScene(
        candidate.scopeJson.folderId,
        sceneId,
        nodes,
      )
      ? candidate.scopeJson.folderId
      : sceneLabel(sceneId);
  };
  const currentSceneUnavailableText = (
    reason: ChronicleSceneUnavailableReason,
  ): string =>
    reason === "not-a-scene"
      ? t(
          "chronicle.extract.currentSceneNotScene",
          "開いているのは場面ではないため、抽出できません。",
        )
      : reason === "not-in-folder"
        ? t(
            "chronicle.extract.currentSceneNotInFolder",
            "フォルダに入っている場面だけ抽出できます。",
          )
        : t(
            "chronicle.extract.currentSceneNoActive",
            "エディタで場面を開くと、その場面だけを抽出できます。",
          );

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
              "選んだ章/フォルダ、または今の場面の本文を AI が読み、作中のイベントを提案します。取り込むと年表に追加されます。",
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
                      {recoveryScopeLabel(candidate)} ·{" "}
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
              value={chronicleExtractTargetOptionValue(target)}
              onChange={(e) => handleSelectTarget(e.target.value)}
              disabled={
                analyzing ||
                importing ||
                applyMutationInFlight ||
                reviewMutationInFlight ||
                abandoningPartialRunId !== null ||
                recoveryUnresolved
              }
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none"
            >
              <option value="">
                {t(
                  "chronicle.extract.selectFolder",
                  "章/フォルダ/今の場面を選択…",
                )}
              </option>
              {currentScene.available ? (
                <option
                  value={chronicleCurrentSceneOptionValue(currentScene.sceneId)}
                >
                  {t("chronicle.extract.currentScene", "今の場面：{{title}}", {
                    title: currentScene.title || unnamedLabel,
                  })}
                </option>
              ) : (
                <option value={chronicleCurrentSceneOptionValue("")} disabled>
                  {t("chronicle.extract.currentSceneDisabled", "今の場面")}
                </option>
              )}
              {target?.kind === "scene" &&
                !(
                  currentScene.available &&
                  currentScene.sceneId === target.sceneId
                ) && (
                  // 選んだ後に開いている場面が変わっても、選んだ場面の項目を残す。
                  <option
                    value={chronicleCurrentSceneOptionValue(target.sceneId)}
                  >
                    {sceneLabel(target.sceneId)}
                  </option>
                )}
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title || unnamedLabel}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAnalyze}
              disabled={
                !target ||
                analyzing ||
                importing ||
                applyMutationInFlight ||
                reviewMutationInFlight ||
                abandoningPartialRunId !== null ||
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
          {!currentScene.available && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="chronicle-extract-current-scene-unavailable"
            >
              {currentSceneUnavailableText(currentScene.reason)}
            </p>
          )}

          {startNotices && (
            <ChronicleExtractStartNotices kinds={startNotices.kinds} />
          )}

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
          {hasPriorApplication &&
            applyReadiness?.errorCode ===
              "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH" && (
              <div
                className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
                data-testid="chronicle-partial-apply-blocked"
              >
                <p>
                  {t(
                    "chronicle.extract.partialApplyBlocked",
                    "このレビューは一部取り込み済みです。取り込み済みEventは保持し、未適用の提案を破棄してから再解析してください。",
                  )}
                </p>
                <button
                  type="button"
                  onClick={() => void handleAbandonPartialReview()}
                  disabled={
                    abandoningPartialRunId !== null ||
                    importing ||
                    applyMutationInFlight ||
                    reviewMutationInFlight ||
                    discardingRunId !== null
                  }
                  className="mt-1 inline-flex items-center gap-1 rounded border border-amber-600/50 px-2 py-1 text-[11px] font-medium hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {abandoningPartialRunId !== null && (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  )}
                  {abandoningPartialRunId !== null
                    ? t("chronicle.extract.abandoningPartialReview", "破棄中")
                    : t(
                        "chronicle.extract.abandonPartialReview",
                        "未適用の提案を破棄",
                      )}
                </button>
              </div>
            )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => handleDialogOpenChange(false)}
            disabled={
              importing ||
              applyMutationInFlight ||
              abandoningPartialRunId !== null ||
              discardingRunId !== null
            }
            className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel", "キャンセル")}
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={
              importing ||
              applyMutationInFlight ||
              reviewMutationInFlight ||
              abandoningPartialRunId !== null ||
              discardingRunId !== null ||
              !approvedReady
            }
            className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            )}
            {applyReadiness?.ready && applyReadiness.approvedCount === 0
              ? t("chronicle.extract.completeReview", "完了")
              : t("chronicle.extract.import", "取り込む")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
