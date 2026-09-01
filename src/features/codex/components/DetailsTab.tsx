import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, ExternalLink, Wand2 } from "lucide-react";
import type { CodexEntry } from "../api";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";
import { PhaseIndicator } from "./PhaseIndicator";
import { extractPlainText } from "../prosemirrorTextExtractor";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { usePhaseStore } from "../phaseStore";
import { useCodexStore } from "../codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveCodexState } from "../phaseResolver";
import type { TemporalAnchor } from "../phaseResolver";
import {
  resolveApplicablePhases,
  resolvePhaseEditState,
} from "../context/resolveApplicablePhases";
import { useAutoSave } from "@/hooks/useAutoSave";
import { AlreadyNotifiedSaveError } from "@/features/editor/document/saveErrors";
import {
  createEditorInstanceId,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import type { LoadedEditorBinding } from "@/features/editor/document/types";
import {
  announcePersistedBinding,
  registerPersistedBindingHandler,
  unregisterPersistedBindingHandler,
} from "@/features/editor/editorSaveRegistry";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { rootCause } from "@/lib/debugLog";
import type { QuiescenceProviderFlushOptions } from "@/lib/quiescenceProviders";
import type { TimelapseDocumentRef } from "@/features/timelapse/documentCoverage";

interface DetailsTabProps {
  entry: CodexEntry;
  summary: string;
  onSummaryChange: (value: string) => void;
  onContentChange: (
    content: string,
    timelapseDocument?: TimelapseDocumentRef,
  ) => void;
  onExternalSync?: (content: string) => void;
  contentReloadToken?: number;
  /** 別窓が同一 entry を編集中なら本文エディタを read-only にする。 */
  readOnly?: boolean;
}

export function DetailsTab({
  entry,
  summary,
  onSummaryChange,
  onContentChange,
  onExternalSync,
  contentReloadToken = 0,
  readOnly = false,
}: DetailsTabProps) {
  const { t } = useTranslation();
  const emptyContent = !entry.content || entry.content === "{}";
  const [isGenerating, setIsGenerating] = useState(false);

  // プレビューフェーズ管理（codexStore にリフトアップ済み — wide mode の中央 EditorPane と共有）
  const previewPhaseId = useCodexStore(
    (s) => s.previewPhaseByEntry[entry.id] ?? null,
  );
  const setPreviewPhase = useCodexStore((s) => s.setPreviewPhase);
  const setPreviewPhaseId = useCallback(
    (phaseId: string | null) => setPreviewPhase(entry.id, phaseId),
    [entry.id, setPreviewPhase],
  );
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const phases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const sceneTimeIndex = usePhaseStore((s) => s.sceneTimeIndex);
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const updatePhase = usePhaseStore((s) => s.updatePhase);
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);

  // アクティブシーン変更時にプレビューをリセット
  useEffect(() => {
    setPreviewPhase(entry.id, null);
  }, [activeSceneId, entry.id, setPreviewPhase]);

  const currentPhaseResolution = useMemo(
    () =>
      activeSceneId
        ? resolveApplicablePhases({
            phases: phases ?? [],
            index: sceneTimeIndex,
            mode: resolutionMode,
            anchor: { kind: "scene", sceneId: activeSceneId },
          })
        : null,
    [activeSceneId, phases, sceneTimeIndex, resolutionMode],
  );

  const activePhaseEditState = useMemo(
    () =>
      currentPhaseResolution
        ? resolvePhaseEditState(currentPhaseResolution, {
            summary: entry.summary ?? null,
            content: entry.content ?? "{}",
          })
        : null,
    [currentPhaseResolution, entry.summary, entry.content],
  );
  const activePhase = activePhaseEditState?.targetPhase ?? null;
  const activeResolvedDetailValues = useMemo(() => {
    if (!activePhase || !currentPhaseResolution) return null;

    // Keep only Phase-owned values here. DetailsSection already owns the Base
    // values and falls back to them when no Phase has touched a definition.
    // Applying every applicable Phase in resolver order preserves inheritance
    // when the active Phase leaves a field unset.
    const values = new Map<string, string | null>();
    for (const phase of currentPhaseResolution.applicablePhases) {
      for (const override of detailOverrides[phase.id] ?? []) {
        values.set(override.definitionId, override.value ?? null);
      }
    }
    return values;
  }, [activePhase, currentPhaseResolution, detailOverrides]);

  // プレビュー用の解決済み状態を計算（プレビューモード時のみ）
  const previewResolvedState = useMemo(() => {
    if (previewPhaseId == null || !phases) return null;

    let previewAnchor: TemporalAnchor;
    if (previewPhaseId === "__base__") {
      previewAnchor = { kind: "base" };
    } else {
      previewAnchor = { kind: "phase", phaseId: previewPhaseId };
    }

    const phaseDetailsMap = new Map(
      phases.map((p) => [p.id, detailOverrides[p.id] ?? []]),
    );

    return resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content ?? "{}",
        contextMode: entry.contextMode ?? "mentioned",
      },
      phases,
      phaseDetailsMap,
      new Map(),
      previewAnchor,
      sceneTimeIndex,
      resolutionMode,
    );
  }, [
    previewPhaseId,
    phases,
    detailOverrides,
    sceneTimeIndex,
    resolutionMode,
    entry.summary,
    entry.content,
    entry.contextMode,
  ]);

  // モードフラグ
  const isPreviewMode = previewPhaseId != null;
  const isActivePhaseSummaryMode = !isPreviewMode && activePhase !== null;
  const isActivePhaseContentMode = !isPreviewMode && activePhase !== null;
  const [phaseContentReloadToken, setPhaseContentReloadToken] = useState(0);
  const phaseVersionsRef = useRef(new Map<string, number>());
  const phaseWriteTailsRef = useRef(new Map<string, Promise<void>>());
  const phaseQueuedWritesRef = useRef(new Map<string, number>());
  const phaseEditorInstanceIdRef = useRef(createEditorInstanceId("phase-mini"));
  const pendingPhaseSummariesRef = useRef(
    new Map<string, { value: string; initialVersion: number }>(),
  );
  const pendingPhaseContentsRef = useRef(
    new Map<string, { value: string; initialVersion: number }>(),
  );
  const activePhaseId = isActivePhaseContentMode
    ? (activePhase?.id ?? null)
    : null;
  const activePhaseDocumentKey = useMemo<DocumentKey | null>(
    () =>
      activePhaseId
        ? { kind: "codex", id: entry.id, phaseId: activePhaseId }
        : null,
    [activePhaseId, entry.id],
  );
  const entryPhaseConflict = useExternalWriteStore((state) =>
    state.conflicts.find(
      (conflict) =>
        conflict.documentKey?.kind === "codex" &&
        conflict.documentKey.id === entry.id &&
        conflict.documentKey.phaseId !== null,
    ),
  );
  // Keep a conflict-staged Phase as the session owner even if scene/preview
  // navigation changes which Phase is currently rendered. Otherwise the old
  // paused drafts remain queued with no banner capable of resolving them.
  const phaseSessionDocumentKey =
    entryPhaseConflict?.documentKey?.kind === "codex"
      ? entryPhaseConflict.documentKey
      : activePhaseDocumentKey;
  const phaseSessionId =
    phaseSessionDocumentKey?.kind === "codex"
      ? phaseSessionDocumentKey.phaseId
      : null;
  const phaseSessionDocumentStateKey = phaseSessionDocumentKey
    ? externalDocumentStateKey(phaseSessionDocumentKey)
    : null;
  const phaseSessionReloadNonce = useExternalWriteStore((state) =>
    phaseSessionDocumentStateKey
      ? (state.reloadNonce[phaseSessionDocumentStateKey] ?? 0)
      : 0,
  );
  const hasEntryPhaseConflict = entryPhaseConflict !== undefined;
  const seenPhaseReloadRef = useRef({
    stateKey: phaseSessionDocumentStateKey,
    nonce: phaseSessionReloadNonce,
  });

  const documentKeyForPhase = useCallback(
    (phaseId: string): DocumentKey => ({
      kind: "codex",
      id: entry.id,
      phaseId,
    }),
    [entry.id],
  );

  const markPhaseDirty = useCallback(
    (phaseId: string) => {
      useEditorSessionStore
        .getState()
        .setDocumentDirty(
          documentKeyForPhase(phaseId),
          true,
          phaseEditorInstanceIdRef.current,
        );
    },
    [documentKeyForPhase],
  );

  const clearPhaseDirtyIfSettled = useCallback(
    (phaseId: string) => {
      if (pendingPhaseSummariesRef.current.has(phaseId)) return;
      if (pendingPhaseContentsRef.current.has(phaseId)) return;
      if ((phaseQueuedWritesRef.current.get(phaseId) ?? 0) > 0) return;
      useEditorSessionStore
        .getState()
        .setDocumentDirty(
          documentKeyForPhase(phaseId),
          false,
          phaseEditorInstanceIdRef.current,
        );
    },
    [documentKeyForPhase],
  );

  useEffect(() => {
    if (!activePhase || !activePhaseId) return;
    // Capture the version when this Phase editor session becomes active.
    // Same-id store refreshes must not advance the base under a stale buffer.
    phaseVersionsRef.current.set(activePhaseId, activePhase.version ?? 0);
    // intentional: reset only when the active Phase identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhaseId]);

  useEffect(() => {
    if (!activePhaseDocumentKey || !activePhaseId) return;
    const instanceId = phaseEditorInstanceIdRef.current;
    const handlePeerSave = (binding: LoadedEditorBinding) => {
      if (
        binding.kind === "codex" &&
        binding.id === entry.id &&
        binding.phaseId === activePhaseId
      ) {
        phaseVersionsRef.current.set(
          activePhaseId,
          Math.max(
            phaseVersionsRef.current.get(activePhaseId) ?? 0,
            binding.loadedVersion,
          ),
        );
        clearPhaseDirtyIfSettled(activePhaseId);
      }
    };
    registerPersistedBindingHandler(
      activePhaseDocumentKey,
      instanceId,
      handlePeerSave,
    );
    return () =>
      unregisterPersistedBindingHandler(
        activePhaseDocumentKey,
        instanceId,
        handlePeerSave,
      );
  }, [
    activePhaseDocumentKey,
    activePhaseId,
    clearPhaseDirtyIfSettled,
    entry.id,
  ]);

  const persistPhasePatch = useCallback(
    (
      phaseId: string,
      initialVersion: number,
      data: Parameters<typeof updatePhase>[1],
      context?: QuiescenceProviderFlushOptions,
    ) => {
      if (!phaseVersionsRef.current.has(phaseId)) {
        phaseVersionsRef.current.set(phaseId, initialVersion);
      }
      phaseQueuedWritesRef.current.set(
        phaseId,
        (phaseQueuedWritesRef.current.get(phaseId) ?? 0) + 1,
      );
      const prior =
        phaseWriteTailsRef.current.get(phaseId) ?? Promise.resolve();
      const run = prior
        .catch(() => {})
        .then(async () => {
          const updated = await updatePhase(phaseId, data, {
            baseVersion:
              phaseVersionsRef.current.get(phaseId) ?? initialVersion,
            ...(context?.preexistingDraft ? { preexistingDraft: true } : {}),
          });
          if (!updated) {
            throw new AlreadyNotifiedSaveError(
              `phase save not persisted: ${phaseId}`,
            );
          }
          phaseVersionsRef.current.set(phaseId, updated.version ?? 0);
          const documentKey: DocumentKey = {
            kind: "codex",
            id: updated.entryId,
            phaseId,
          };
          announcePersistedBinding(
            documentKey,
            phaseEditorInstanceIdRef.current,
            {
              kind: "codex",
              id: updated.entryId,
              phaseId,
              loadedVersion: updated.version ?? 0,
            },
          );
          return updated;
        })
        .finally(() => {
          const remaining =
            (phaseQueuedWritesRef.current.get(phaseId) ?? 1) - 1;
          if (remaining > 0) {
            phaseQueuedWritesRef.current.set(phaseId, remaining);
          } else {
            phaseQueuedWritesRef.current.delete(phaseId);
          }
        });
      phaseWriteTailsRef.current.set(
        phaseId,
        run.then(
          () => {},
          () => {},
        ),
      );
      return run;
    },
    [updatePhase],
  );

  // フェーズsummaryのローカル状態（入力ラグ防止）
  const [phaseSummaryLocal, setPhaseSummaryLocal] = useState(
    activePhaseEditState?.summary ?? "",
  );
  // アクティブフェーズが変わったときにローカル状態を同期
  useEffect(() => {
    setPhaseSummaryLocal(activePhaseEditState?.summary ?? "");
    // intentional: sync only when phase identity changes, not on value update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhase?.id]);

  // Phase summaryの自動保存（1秒デバウンス）
  const {
    schedule: schedulePhaseSummarySave,
    cancel: cancelPhaseSummarySave,
    pause: pausePhaseSummarySave,
    resume: resumePhaseSummarySave,
  } = useAutoSave(
    useCallback(
      async (context?: QuiescenceProviderFlushOptions) => {
        const pending = [...pendingPhaseSummariesRef.current.entries()];
        for (const [phaseId, snapshot] of pending) {
          await persistPhasePatch(
            phaseId,
            snapshot.initialVersion,
            {
              summaryOverride: snapshot.value,
            },
            context,
          );
          if (pendingPhaseSummariesRef.current.get(phaseId) === snapshot) {
            pendingPhaseSummariesRef.current.delete(phaseId);
          }
          clearPhaseDirtyIfSettled(phaseId);
        }
      },
      [clearPhaseDirtyIfSettled, persistPhasePatch],
    ),
    1000,
  );

  // Phase content uses the same per-Phase write chain and loaded version as
  // summary, so the two debounce lanes cannot issue parallel CAS writes.
  const {
    schedule: schedulePhaseContentSave,
    cancel: cancelPhaseContentSave,
    pause: pausePhaseContentSave,
    resume: resumePhaseContentSave,
  } = useAutoSave(
    useCallback(
      async (context?: QuiescenceProviderFlushOptions) => {
        const pending = [...pendingPhaseContentsRef.current.entries()];
        for (const [phaseId, snapshot] of pending) {
          await persistPhasePatch(
            phaseId,
            snapshot.initialVersion,
            {
              contentOverride: snapshot.value,
            },
            context,
          );
          if (pendingPhaseContentsRef.current.get(phaseId) === snapshot) {
            pendingPhaseContentsRef.current.delete(phaseId);
          }
          clearPhaseDirtyIfSettled(phaseId);
        }
      },
      [clearPhaseDirtyIfSettled, persistPhasePatch],
    ),
    2000,
  );

  useEffect(() => {
    if (hasEntryPhaseConflict) {
      pausePhaseSummarySave();
      pausePhaseContentSave();
    } else {
      resumePhaseSummarySave();
      resumePhaseContentSave();
    }
  }, [
    hasEntryPhaseConflict,
    pausePhaseContentSave,
    pausePhaseSummarySave,
    resumePhaseContentSave,
    resumePhaseSummarySave,
  ]);

  const refreshPhaseBinding = useCallback(
    async (phaseId: string, allowMissing = false) => {
      await (phaseWriteTailsRef.current.get(phaseId) ?? Promise.resolve());
      await loadPhasesForEntry(entry.id);

      const phaseState = usePhaseStore.getState();
      const latest = phaseState.phasesByEntry[entry.id]?.find(
        (phase) => phase.id === phaseId,
      );
      if (!latest) {
        if (allowMissing) {
          return { latest: null, editState: null };
        }
        throw new Error(`Phase '${phaseId}' no longer exists`);
      }
      phaseVersionsRef.current.set(phaseId, latest.version ?? 0);

      const resolution = activeSceneId
        ? resolveApplicablePhases({
            phases: phaseState.phasesByEntry[entry.id] ?? [],
            index: phaseState.sceneTimeIndex,
            mode: phaseState.resolutionMode,
            anchor: { kind: "scene", sceneId: activeSceneId },
          })
        : null;
      return {
        latest,
        editState: resolution
          ? resolvePhaseEditState(resolution, {
              summary: entry.summary ?? null,
              content: entry.content ?? "{}",
            })
          : null,
      };
    },
    [activeSceneId, entry.content, entry.id, entry.summary, loadPhasesForEntry],
  );

  useEffect(() => {
    if (seenPhaseReloadRef.current.stateKey !== phaseSessionDocumentStateKey) {
      seenPhaseReloadRef.current = {
        stateKey: phaseSessionDocumentStateKey,
        nonce: phaseSessionReloadNonce,
      };
      return;
    }
    if (!phaseSessionDocumentKey || !phaseSessionId) return;
    if (seenPhaseReloadRef.current.nonce === phaseSessionReloadNonce) return;
    seenPhaseReloadRef.current.nonce = phaseSessionReloadNonce;

    let cancelled = false;
    void (async () => {
      try {
        const { latest, editState } = await refreshPhaseBinding(
          phaseSessionId,
          true,
        );
        if (cancelled) return;

        pendingPhaseSummariesRef.current.delete(phaseSessionId);
        pendingPhaseContentsRef.current.delete(phaseSessionId);
        if (latest && activePhaseId === phaseSessionId) {
          setPhaseSummaryLocal(
            editState?.targetPhase?.id === phaseSessionId
              ? (editState.summary ?? "")
              : (latest.summaryOverride ?? ""),
          );
          setPhaseContentReloadToken((token) => token + 1);
        }
        useEditorSessionStore
          .getState()
          .setDocumentDirty(
            phaseSessionDocumentKey,
            false,
            phaseEditorInstanceIdRef.current,
          );
        useExternalWriteStore.getState().shiftConflict(phaseSessionDocumentKey);
      } catch (error) {
        if (cancelled) return;
        toast.error(t("autoSave.failed", { reason: rootCause(error) }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activePhaseId,
    phaseSessionDocumentKey,
    phaseSessionDocumentStateKey,
    phaseSessionId,
    phaseSessionReloadNonce,
    refreshPhaseBinding,
    t,
  ]);

  const handlePhaseKeepMine = useCallback(async () => {
    if (!phaseSessionId) return;
    await refreshPhaseBinding(phaseSessionId);
    if (pendingPhaseSummariesRef.current.has(phaseSessionId)) {
      schedulePhaseSummarySave();
    }
    if (pendingPhaseContentsRef.current.has(phaseSessionId)) {
      schedulePhaseContentSave();
    }
  }, [
    phaseSessionId,
    refreshPhaseBinding,
    schedulePhaseContentSave,
    schedulePhaseSummarySave,
  ]);

  const handlePhaseReload = useCallback(() => {
    cancelPhaseSummarySave();
    cancelPhaseContentSave();
  }, [cancelPhaseContentSave, cancelPhaseSummarySave]);

  // Base contentを表示の折りたたみ状態
  const [showBaseContent, setShowBaseContent] = useState(false);

  // プレビューsummary（プレビューモードのみ）
  const previewSummary =
    isPreviewMode && previewResolvedState != null
      ? previewResolvedState.summary
      : null;
  const hasPreviewSummary =
    previewSummary != null && previewSummary !== (entry.summary ?? "");

  // Contentエディタのkeyとinitial content
  // - activePhaseContentMode: フェーズのcontentOverrideで初期化、フェーズ変更時に再マウント
  // - previewMode: ベースcontentで初期化、externalContentでオーバーライド
  // - base: entry.content
  const contentEditorKey = isActivePhaseContentMode
    ? `phase-${activePhase?.id ?? "none"}-${phaseContentReloadToken}`
    : isPreviewMode
      ? `preview-${previewPhaseId}`
      : `base-${contentReloadToken}`;

  const contentForEditor = isActivePhaseContentMode
    ? (activePhaseEditState?.content ?? "")
    : emptyContent
      ? ""
      : entry.content;

  // externalContentはプレビューモードのみ使用
  const contentExternalContent =
    isPreviewMode &&
    previewResolvedState != null &&
    previewResolvedState.content !== (entry.content ?? "{}")
      ? previewResolvedState.content
      : null;

  // Summary変更ハンドラ
  const handleSummaryChange = (value: string) => {
    if (isPreviewMode) return;
    if (isActivePhaseSummaryMode && activePhase) {
      setPhaseSummaryLocal(value);
      markPhaseDirty(activePhase.id);
      pendingPhaseSummariesRef.current.set(activePhase.id, {
        value,
        initialVersion:
          phaseVersionsRef.current.get(activePhase.id) ??
          activePhase.version ??
          0,
      });
      schedulePhaseSummarySave();
    } else {
      onSummaryChange(value);
    }
  };

  // Content変更ハンドラ
  const handleContentChange = (
    newContent: string,
    timelapseDocument?: TimelapseDocumentRef,
  ) => {
    if (isPreviewMode) return;
    if (isActivePhaseContentMode && activePhase) {
      markPhaseDirty(activePhase.id);
      pendingPhaseContentsRef.current.set(activePhase.id, {
        value: newContent,
        initialVersion:
          phaseVersionsRef.current.get(activePhase.id) ??
          activePhase.version ??
          0,
      });
      schedulePhaseContentSave();
    } else {
      onContentChange(newContent, timelapseDocument);
    }
  };

  // ContentエディタのentryId（フェーズ/プレビューモード時はsceneContentStore連携を無効化）
  const contentEntryId =
    isActivePhaseContentMode || isPreviewMode ? undefined : entry.id;

  const handlePhaseExternalSync = useCallback(() => {
    if (!activePhaseId) return;
    // The peer EditorPane now owns persistence of the body it just broadcast.
    // Drop an older mini-editor debounce snapshot so it cannot overwrite that
    // newer full document after adopting the peer's advanced version.
    pendingPhaseContentsRef.current.delete(activePhaseId);
    clearPhaseDirtyIfSettled(activePhaseId);
  }, [activePhaseId, clearPhaseDirtyIfSettled]);

  const contentExternalSync = isPreviewMode
    ? undefined
    : isActivePhaseContentMode
      ? handlePhaseExternalSync
      : onExternalSync;
  const contentLiveDocumentKey = isPreviewMode
    ? null
    : isActivePhaseContentMode
      ? activePhaseDocumentKey
      : undefined;

  return (
    <div className="space-y-3">
      {phaseSessionDocumentKey && (
        <ExternalEditConflictBanner
          nodeId={entry.id}
          documentKey={phaseSessionDocumentKey}
          editorInstanceId={phaseEditorInstanceIdRef.current}
          onKeepMine={handlePhaseKeepMine}
          onReload={handlePhaseReload}
        />
      )}
      <PhaseIndicator
        entry={entry}
        previewPhaseId={previewPhaseId}
        onPreviewChange={setPreviewPhaseId}
      />

      {/* Summary */}
      <div>
        <label className="mb-1 block text-xs font-medium">
          {t("codex.detail.summaryLabel")}
        </label>
        {hasPreviewSummary ? (
          // フェーズプレビュー中: 解決済み値を読み取り専用表示
          <div className="border-l-2 border-primary pl-2">
            <p className="rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground">
              {previewSummary || (
                <span className="text-muted-foreground">
                  {t("codex.detail.empty")}
                </span>
              )}
            </p>
            {entry.summary && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Base: {entry.summary}
              </p>
            )}
          </div>
        ) : isActivePhaseSummaryMode ? (
          // アクティブフェーズがsummaryを上書き中: フェーズ値を編集可能表示
          <div className="border-l-2 border-primary pl-2">
            <textarea
              value={phaseSummaryLocal}
              onChange={(e) => handleSummaryChange(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              placeholder={t("codex.detail.phaseSummaryPlaceholder")}
            />
            {entry.summary && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Base: {entry.summary}
              </p>
            )}
          </div>
        ) : (
          <textarea
            data-testid="codex-detail-summary"
            value={summary}
            onChange={(e) => handleSummaryChange(e.target.value)}
            readOnly={readOnly || isPreviewMode}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm read-only:opacity-60"
            placeholder="Short description..."
          />
        )}
        {/* S5: hint when summary is empty but content exists */}
        {summary === "" &&
          !emptyContent &&
          !isActivePhaseSummaryMode &&
          !isPreviewMode && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("codex.detail.summaryHint")}
            </p>
          )}
        {/* M4: AI auto-generate button */}
        {summary === "" &&
          !emptyContent &&
          !isActivePhaseSummaryMode &&
          !isPreviewMode && (
            <button
              type="button"
              data-testid="codex-generate-summary"
              disabled={isGenerating}
              onClick={async () => {
                // On-demand AI generation of persisted text → bodyWrite gate
                // (same generateSynopsisFromContent primitive as scene synopsis).
                if (blockIfPolicyOff("bodyWrite")) return;
                if (blockIfUnlicensed()) return;
                setIsGenerating(true);
                try {
                  const plainText = extractPlainText(entry.content ?? "{}");
                  const generated = await generateSynopsisFromContent(
                    entry.name,
                    plainText,
                  );
                  onSummaryChange(generated);
                } catch {
                  toast.error(t("codex.detail.aiSummaryFailed"));
                } finally {
                  setIsGenerating(false);
                }
              }}
              className="mt-1 flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              <Wand2 className="h-3 w-3" />
              {isGenerating
                ? t("codex.detail.generating")
                : t("codex.detail.generateAiSummary")}
            </button>
          )}
      </div>

      {/* Content (TipTap) */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <label className="block text-xs font-medium">
            {t("codex.detail.contentLabel")}
          </label>
          <button
            type="button"
            onClick={() =>
              openEditorDocument(
                {
                  target: {
                    kind: "codex",
                    documentId: entry.id,
                    phaseId: isPreviewMode ? previewPhaseId : undefined,
                  },
                  mode: "pinned",
                  revealEditor: true,
                  focusEditor: false,
                  syncSceneContext: false,
                },
                defaultEditorNavigationPorts,
              )
            }
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
            title={t("codex.detail.openInEditor")}
          >
            <ExternalLink className="h-3 w-3" />
            {t("codex.detail.openInEditor")}
          </button>
        </div>
        {/* フェーズによるcontentOverrideがある場合は左ボーダーで強調 */}
        <div
          className={
            isActivePhaseContentMode || contentExternalContent != null
              ? "border-l-2 border-primary pl-2"
              : ""
          }
        >
          <CodexContentEditor
            key={contentEditorKey}
            content={contentForEditor}
            onContentChange={isPreviewMode ? () => {} : handleContentChange}
            entryId={contentEntryId}
            projectId={entry.projectId}
            liveDocumentKey={contentLiveDocumentKey}
            onExternalSync={contentExternalSync}
            externalContent={contentExternalContent}
            readOnly={readOnly || isPreviewMode}
          />
        </div>

        {/* アクティブフェーズがcontentを上書き中: Base contentを折りたたみ表示 */}
        {isActivePhaseContentMode && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowBaseContent((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showBaseContent ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {t("codex.detail.showBaseContent")}
            </button>
            {showBaseContent && (
              <div className="mt-1 rounded-md border border-input bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground">
                {emptyContent ? (
                  <span className="italic">{t("codex.detail.empty")}</span>
                ) : (
                  extractPlainText(entry.content ?? "{}")
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom Details */}
      <DetailsSection
        entry={entry}
        activePhase={
          !isPreviewMode && activePhase
            ? {
                id: activePhase.id,
                label: activePhase.label,
                version: activePhase.version,
              }
            : null
        }
        activeResolvedDetailValues={activeResolvedDetailValues}
        previewDetailValues={
          isPreviewMode
            ? (previewResolvedState?.detailValues ?? new Map())
            : null
        }
      />
    </div>
  );
}
