import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useEditor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";
import { resetEditorHistory } from "@/features/editor/editorDocumentLoad";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { Toolbar } from "@/features/editor/Toolbar";
import type { ToolbarActions } from "@/features/editor/Toolbar";
import { useTreeStore } from "@/features/tree/treeStore";
import { savePlacedBeatPreviewOnly } from "@/features/tree/api";
import {
  extractPlacedBeatPreview,
  extractPlacedBeatPreviewFromDoc,
} from "@/features/editor/beat/placedBeatPreview";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { transactionTouchesSceneBeat } from "@/features/editor/beat/transactionTouchesSceneBeat";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { uiUpdateEvent } from "@/features/agent-writes/event";
import { getEventVersion } from "@/features/chronicle/version";
import type {
  CodexMentionPopupState,
  MentionItem,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { buildInlineAiContext } from "@/features/editor/inlineAi/inlineAiContext";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import {
  defaultEditorDocumentServices,
  saveEditorDocument,
} from "@/features/editor/document/saveEditorDocument";
import {
  loadEditorDocument,
  targetFromTab,
} from "@/features/editor/document/loadEditorDocument";
import {
  applySceneSidecars,
  loadSceneSidecars,
} from "@/features/editor/document/sceneSidecars";
import { type SaveSnapshot } from "@/features/editor/document/mutationGate";
import { useEditorDocumentSession } from "@/features/editor/document/useEditorDocumentSession";
import {
  createEditorInstanceId,
  documentKeyFromBinding,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { createRevision } from "@/features/revision/api";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { parseClipboardHtml } from "@/lib/clipboardAttribution";
import {
  pasteExternalText,
  notePlainPasteKeyDown,
  consumePlainPaste,
} from "@/features/editor/markdownPaste";
import { useInsertHighlight } from "@/features/editor/InsertHighlight";
import { useGhostPreview } from "@/features/editor/useGhostPreview";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useImeDiagnostics } from "@/features/editor/useImeDiagnostics";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import { useTateChuYoko } from "@/features/editor/useTateChuYoko";
import { useShowInvisibles } from "@/features/editor/useShowInvisibles";
import { useCodexCompletion } from "@/features/editor/codexCompletion/useCodexCompletion";
import { handleZenEscapeKeyDown } from "@/features/editor/zenEscape";
import { useEditorViewReady } from "@/features/editor/useEditorViewReady";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import {
  getEditorTimelapseCapture,
  serializeTransactionSteps,
  shouldHandleEditorUpdate,
} from "@/features/editor/editorEventPolicy";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useFocusMode } from "@/features/editor/useFocusMode";
import { gutterReserveInlineSize } from "@/features/editor/GutterMarksPlugin";
import {
  useTypewriterScroll,
  computeTypewriterScrollTop,
  computeTypewriterScrollLeft,
  verticalColumnCenterX,
} from "@/features/editor/useTypewriterScroll";
import {
  getLogicalScrollOffset,
  setLogicalScrollOffset,
} from "@/features/editor/editorLayout";
import { useInlineAiDiff } from "@/features/editor/inlineAi/useInlineAiDiff";
import { useAgentProseStaging } from "@/features/editor/inlineAi/useAgentProseStaging";
import {
  buildSystemPrompt as buildInlineSystemPrompt,
  buildUserPrompt as buildInlineUserPrompt,
} from "@/features/editor/inlineAi/inlineAiApi";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { resolvePhoneEditorGroup } from "@/features/editor/phoneEditorGroup";
import { useTabStore } from "@/features/editor/tabStore";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { useRequestedEditorFocus } from "@/features/editor/useRequestedEditorFocus";
import {
  announcePersistedBinding,
  registerSaveHandler,
  registerPersistedBindingHandler,
  registerDiscardHandler,
  unregisterSaveHandler,
  unregisterPersistedBindingHandler,
  unregisterDiscardHandler,
  dirtyGatedSaveHandler,
} from "@/features/editor/editorSaveRegistry";
import {
  useSceneContentStore,
  hasOtherLiveContentSubscriber,
  subscribeLiveContentRafCoalesced,
} from "@/features/editor/sceneContentStore";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import { shouldPromptSynopsis } from "@/features/editor/synopsisSuggestion";
import { useSynopsisSuggestionStore } from "@/features/editor/synopsisSuggestionStore";
import { getDocText } from "@/features/editor/RubyNode";
import { useLinter } from "@/features/lint/useLinter";
import { useForeshadowNavStore } from "@/features/foreshadow/foreshadowNavStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { findChunkInDoc } from "@/features/semantic-search/findChunkInDoc";
import { usePendingSemanticJump } from "@/features/semantic-search/usePendingSemanticJump";
import { toast } from "sonner";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { trackPendingEditorWrite } from "@/lib/editorQuiescence";
import { markStart, markEnd, recordMark } from "@/lib/perfLog";
import i18next from "i18next";
import type { SceneStatus } from "@/features/tree/treeStore";
import type { GroupIndex, TabContentType } from "@/features/editor/tabStore";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { useParagraphReorderOverlay } from "@/features/editor/reorder/useParagraphReorderOverlay";
import { useBeatDragDrop } from "@/features/editor/useBeatDragDrop";
import { useEditorKeyboard } from "@/features/editor/useEditorKeyboard";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import type { TrashOrigin } from "@/features/trash-bin/types";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import { EditorPaneRibbon } from "@/features/editor/EditorPaneRibbon";
import { EditorPaneViewport } from "@/features/editor/EditorPaneViewport";
import { EditorPaneStatusBar } from "@/features/editor/EditorPaneStatusBar";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import { PhoneSceneMetaSheet } from "@/features/editor/PhoneSceneMetaSheet";
import {
  EditorPaneOverlays,
  type AbInlineState,
} from "@/features/editor/EditorPaneOverlays";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";

/** Read the vertical-mode flag at call time — scroll save/restore runs inside
 *  async effects and editor callbacks where a captured value could be stale. */
function isVerticalModeNow(): boolean {
  return useSettingsStore.getState().getBoolean("editor.verticalMode", false);
}

interface EditorPaneProps {
  nodeId: string;
  contentType: TabContentType;
  groupIndex: GroupIndex;
  onFocus: () => void;
  /**
   * tabStore の overridePhaseId 経路を bypass して直接 phase を指定する。
   * Codex パネル wide mode のように tabStore に対応タブを持たない standalone mount 用。
   * undefined のときは従来通り tabStore から取得する。
   */
  phaseIdOverride?: string | null;
  /**
   * 外部要因による read-only（マルチウインドウの advisory lock で別窓が同一 entry を
   * 編集中など）。ライセンス read-only と OR して editable を一元制御する。
   * 既定 false（通常のシーン編集経路は不変）。
   */
  readOnly?: boolean;
}

/**
 * A single TipTap editor pane.
 * Used as-is for the primary group, and duplicated for the secondary group.
 * When the same nodeId is open in both groups, edits propagate via sceneContentStore.
 * Supports both scene/note content (Markdown via Tauri) and codex entry content (ProseMirror JSON via DB).
 */

export function useClosePhoneReorderOverlay({
  phoneWorkspace,
  open,
  closeOverlay,
}: {
  phoneWorkspace: boolean;
  open: boolean;
  closeOverlay: () => void;
}) {
  useEffect(() => {
    if (phoneWorkspace && open) closeOverlay();
  }, [closeOverlay, open, phoneWorkspace]);
}

export function EditorPane({
  nodeId,
  contentType,
  groupIndex,
  onFocus,
  phaseIdOverride,
  readOnly = false,
}: EditorPaneProps) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const isCodexMode = contentType === "codex";
  const isSnippetMode = contentType === "snippet";
  const isChronicleEventMode = contentType === "chronicle_event";
  // DB-backed entry rather than a tree scene/note. Codex/Snippet/Chronicle-event
  // tabs share the "not a scene" behavior (no revisions, synopsis, beats, tree
  // sync, scene-meta panel, authorship/foreshadow anchor loads, …).
  const isEntryMode = isCodexMode || isSnippetMode || isChronicleEventMode;
  // Chronicle event tabs: title is loaded on demand (events have no global store).
  const [chronicleEventTitle, setChronicleEventTitle] = useState("");
  const prevSceneIdRef = useRef(nodeId);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  // Per-scene editor state: cursor position + scroll (session-only, no persistence).
  // scrollOffset is the logical block-axis offset (scrollTop when horizontal,
  // -scrollLeft when vertical) — see editorLayout.getLogicalScrollOffset.
  const savedEditorStateRef = useRef<
    Map<string, { from: number; to: number; scrollOffset: number | null }>
  >(new Map());
  // Pending cursor/scroll restore for lazy application on next editor focus.
  // Set when the scene switch was triggered from the Scenes panel (no focus steal).
  // Cleared either when consumed by onFocus or when a new scene starts loading.
  // scrollOffset=null は「無効（縦横トグルで軸が変わった等）— スクロールは
  // 復元しない」。0 を無効値に使うと onFocus 復元が先頭へのジャンプになる。
  const pendingCursorRestoreRef = useRef<{
    from: number;
    to: number;
    scrollOffset: number | null;
  } | null>(null);
  // count 系 state (charCount/beat) は EditorStatsFooter に分離済み。本体に
  // 置くとタイピング休止ごとの stat 更新で 2200 行ペイン全体が再レンダー
  // されるため、footer が editor の update イベントを自前購読して再計算する。
  const [isSceneContentLoading, setIsSceneContentLoading] = useState(true);
  const workspaceViewportProfile = useWorkspaceViewportProfile();
  const phoneWorkspace = workspaceViewportProfile === "phone";
  const inlineAiProjectionStatus = useInlineAiStore((state) => state.status);
  const inlineAiProjectionOwnerGroup = useInlineAiStore(
    (state) => state.activeEditorGroup,
  );
  const inlineAiProjectionPending =
    inlineAiProjectionStatus === "generating" ||
    inlineAiProjectionStatus === "diffShown" ||
    inlineAiProjectionStatus === "error";
  const activeGroupIndex = useTabStore((state) => state.activeGroupIndex);
  const primaryActiveTabId = useTabStore((state) => state.activeTabId);
  const secondaryActiveTabId = useTabStore(
    (state) => state.secondaryActiveTabId,
  );
  const secondaryGroupOpen = useTabStore((state) => state.secondaryGroupOpen);
  const treeActiveSceneId = useTreeStore((state) => state.activeSceneId);
  const phoneEditorOwnerGroup = resolvePhoneEditorGroup(
    {
      activeTabId: primaryActiveTabId,
      secondaryActiveTabId,
      secondaryGroupOpen,
      activeGroupIndex,
    },
    treeActiveSceneId,
    inlineAiProjectionPending ? inlineAiProjectionOwnerGroup : null,
  );

  const activeNode = useTreeStore((s) =>
    isEntryMode ? null : s.nodes.find((n) => n.id === nodeId),
  );
  const isFileBacked = isFileBackedNode(activeNode?.sourceUri);
  const activeCodexEntry = useCodexStore((s) =>
    isCodexMode ? s.entries.find((e) => e.id === nodeId) : null,
  );
  const activeSnippetEntry = useSnippetStore((s) =>
    isSnippetMode ? s.entries.find((e) => e.id === nodeId) : null,
  );
  // Codex tabs: which phase's content to display/edit (set via openCodexTab)
  const tabStoreOverridePhaseId = useTabStore((s) => {
    const allTabs = groupIndex === 0 ? s.tabs : s.secondaryTabs;
    return allTabs.find((t) => t.nodeId === nodeId)?.overridePhaseId ?? null;
  });
  // standalone mount (Codex panel wide mode) では prop で直接渡される
  const overridePhaseId =
    phaseIdOverride !== undefined ? phaseIdOverride : tabStoreOverridePhaseId;
  // Phases for this codex entry (populated into store during load)
  const codexPhases = usePhaseStore((s) =>
    isCodexMode ? (s.phasesByEntry[nodeId] ?? null) : null,
  );
  // Content/summary edits do not require a full editor reload, but structural
  // changes can change the active write target at the same scene. Keep the
  // dependency narrow so create/delete/re-anchor reruns resolution without an
  // autosave feedback loop on every phase body update.
  const codexPhaseStructureKey =
    codexPhases === null
      ? "unloaded"
      : codexPhases
          .map(
            (phase) =>
              `${phase.id}\u0000${phase.anchorNodeId ?? ""}\u0000${phase.createdAt}`,
          )
          .join("\u0001");
  const phaseResolutionSceneId = useTreeStore((s) =>
    isCodexMode ? s.activeSceneId : null,
  );
  const phaseSceneTimeIndex = usePhaseStore((s) =>
    isCodexMode ? s.sceneTimeIndex : null,
  );
  const phaseResolutionMode = usePhaseStore((s) =>
    isCodexMode ? s.resolutionMode : null,
  );
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateCodexEntryStore = useCodexStore((s) => s.update);
  const updateSnippetEntryStore = useSnippetStore((s) => s.update);
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;
  const focusedAnnotationId = useAnnotationStore((s) => s.focusedAnnotationId);

  const paneRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInstanceIdRef = useRef(createEditorInstanceId("pane"));
  const [loadedDocumentKey, setLoadedDocumentKey] =
    useState<DocumentKey | null>(null);
  const loadedDocumentKeyRef = useRef<DocumentKey | null>(null);

  // Trash Bin drop target: scene-editor / codex-editor / snippet-editor。
  // ペインごとにユニーク id を振り、kind は contentType で決まる。
  const editorDropKind = isCodexMode
    ? "codex-editor"
    : isSnippetMode
      ? "snippet-editor"
      : "scene-editor";
  const editorDropId = `${editorDropKind}-${nodeId ?? "empty"}-${groupIndex}`;
  // useDropTarget の getEditor は遅延参照クロージャなので、宣言順で後ろの
  // editorRef.current (line ~700 で代入される) を参照しても安全。
  const trashEditorDropRef = useDropTarget(editorDropId, editorDropKind, {
    getEditor: () => editorRef.current,
  });
  const setPaneRef = useCallback(
    (el: HTMLDivElement | null) => {
      paneRef.current = el;
      trashEditorDropRef.current = el;
    },
    [trashEditorDropRef],
  );
  const toolbarActionsRef = useRef<ToolbarActions | null>(null);
  const {
    sensors: beatSensors,
    collisionDetection: beatCollisionDetection,
    draggingBeat,
    onDragStart: handleBeatDragStart,
    onDragEnd: handleBeatDragEnd,
  } = useBeatDragDrop({ editorRef, nodeId });
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleSaveInFlightRef = useRef<Promise<void> | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePreselect, setPalettePreselect] =
    useState<InlineAiCommand | null>(null);
  // A/B 比較 (③): インライン AI を 2 構成で並列生成して見比べるモーダル。
  const [abInline, setAbInline] = useState<AbInlineState | null>(null);
  const [mentionPopup, setMentionPopupState] =
    useState<CodexMentionPopupState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // isDirty の同期ミラー。React state (isDirty) の tabStore への同期は
  // レンダー後 effect まで遅れるため、外部 flush (saveScene) の dirty ゲート
  // (dirtyGatedSaveHandler) は打鍵と同じ tick で更新されるこの ref を正とする。
  // 更新は setIsDirtyRef 経由に一本化してあり、両者は乖離しない。
  const {
    mutationGate,
    isDirty,
    isSaving,
    loadedPhaseId,
    isDirtyRef,
    setDirtyRef: setIsDirtyRef,
    setSaving: setIsSaving,
    setLoadedPhaseId,
  } = useEditorDocumentSession();
  const activeLoadedDocumentKey =
    loadedDocumentKey?.id === nodeId ? loadedDocumentKey : null;
  const activeDocumentStateKey = activeLoadedDocumentKey
    ? externalDocumentStateKey(activeLoadedDocumentKey)
    : null;
  const externalReloadNonce = useExternalWriteStore((state) =>
    activeDocumentStateKey
      ? (state.reloadNonce[activeDocumentStateKey] ?? 0)
      : 0,
  );
  const hasExternalConflict = useExternalWriteStore((state) =>
    activeDocumentStateKey
      ? state.conflicts.some(
          (conflict) =>
            externalDocumentStateKey(
              conflict.documentKey ?? conflict.sceneId,
            ) === activeDocumentStateKey,
        )
      : false,
  );
  const externalReloadRef = useRef({
    key: activeDocumentStateKey,
    nonce: externalReloadNonce,
  });
  if (externalReloadRef.current.key !== activeDocumentStateKey) {
    externalReloadRef.current = {
      key: activeDocumentStateKey,
      nonce: externalReloadNonce,
    };
  }

  const saveSceneIdRef = useRef(nodeId);
  // EditorStatsFooter が tree 同期時に fire 時点のロード済み id を読むための
  // stable getter（inline arrow だと footer の購読が毎レンダー再構築される）。
  const getStatsSceneId = useCallback(() => saveSceneIdRef.current, []);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  // Prevent feedback loop when applying external content sync.
  const isApplyingExternalUpdate = useRef(false);

  // Auto-draft: true when scene was empty at load time
  const wasEmptyRef = useRef(false);

  // Synopsis suggestion: track previous status to detect transitions (scene only)
  const prevStatusRef = useRef<SceneStatus | null>(activeStatus);
  useEffect(() => {
    if (isEntryMode) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = activeStatus;
    const synopsis = useTreeStore
      .getState()
      .nodes.find((n) => n.id === nodeId)?.synopsis;
    if (shouldPromptSynopsis(prev, activeStatus, synopsis)) {
      useSynopsisSuggestionStore.getState().propose(nodeId);
    }
  }, [activeStatus, nodeId, isEntryMode]);

  const coreSave = useCallback(
    async (snapshot: SaveSnapshot, doc: ProseMirrorNode) => {
      markStart("editor.coreSave");
      try {
        return await saveEditorDocument(
          snapshot.binding,
          doc,
          defaultEditorDocumentServices,
        );
      } finally {
        markEnd("editor.coreSave");
      }
    },
    [],
  );

  const saveFn = useCallback(async () => {
    const snapshot = mutationGate.captureSave();
    const doc = editorRef.current?.state.doc;
    if (!snapshot || !doc) {
      // coreSave 側でも skip するが、ここで弾かないと後続の auto-revision が
      // 未ロードの空 doc を getJSON してリビジョン履歴に書き込んでしまう
      // (実機ログで確認: save skipped 直後に空 doc の revision insert)。
      // dirty 解除も「保存していないのに消す」ことになるので丸ごと skip する。
      debugLog.warn("EditorPane", "saveFn skipped: document is not loaded");
      return;
    }
    setIsSaving(true);
    let result: Awaited<ReturnType<typeof coreSave>>;
    try {
      result = await coreSave(snapshot, doc);
    } finally {
      setIsSaving(false);
    }
    // Persisted version always advances for the same loaded document. Edits
    // that arrived while the write was in flight keep dirty set and will use
    // the new baseVersion on the coalesced follow-up save.
    if (mutationGate.commitSave(snapshot, result.binding)) {
      setIsDirtyRef.current(false);
      useEditorSessionStore
        .getState()
        .setDocumentDirty(
          documentKeyFromBinding(result.binding),
          false,
          editorInstanceIdRef.current,
        );
    }
    announcePersistedBinding(
      documentKeyFromBinding(result.binding),
      editorInstanceIdRef.current,
      result.binding,
    );

    // Auto-revision is non-critical — don't let it trigger "save failed" toast
    // Codex/snippet tabs don't use the revision system
    if (snapshot.binding.kind === "tree") {
      try {
        const id = snapshot.binding.id;
        if (!id) return;
        const intervalMs =
          useSettingsStore.getState().getNumber("revision.autoInterval", 5) *
          60 *
          1000;
        if (shouldAutoRevision(id, intervalMs)) {
          // Revision content must match the immutable document that actually
          // reached persistence, not newer keystrokes that arrived meanwhile.
          const content = JSON.stringify(doc.toJSON());
          const rev = await createRevision({
            entityType: "scene",
            entityId: id,
            content,
            snapshotType: "auto",
          });
          if (rev) {
            recordAutoRevision(id);
            const keepCount = useSettingsStore
              .getState()
              .getNumber("revision.keepCount", 50);
            import("@/features/revision/api").then(({ pruneRevisions }) => {
              pruneRevisions("scene", id, keepCount).catch(console.error);
            });
          }
        }
      } catch (e) {
        debugLog.warn(
          "AutoSave",
          "revision failed (content saved)",
          errorDetail(e),
        );
      }
    }
  }, [
    coreSave,
    mutationGate,
    setIsDirtyRef,
    setIsSaving,
    shouldAutoRevision,
    recordAutoRevision,
  ]);

  // Register this pane's save function so external callers (tab context menu,
  // agent writes, rename cascade, …) can flush it. dirty ゲート付き:
  // clean な editor への外部 flush は no-op (詳細は dirtyGatedSaveHandler)。
  useEffect(() => {
    if (!activeLoadedDocumentKey) return;
    const editorInstanceId = editorInstanceIdRef.current;
    const handler = dirtyGatedSaveHandler(() => isDirtyRef.current, saveFn);
    registerSaveHandler(activeLoadedDocumentKey, editorInstanceId, handler);
    const persistedBindingHandler = (
      binding: Parameters<typeof mutationGate.advancePeerSave>[0],
    ) => {
      mutationGate.advancePeerSave(binding);
    };
    registerPersistedBindingHandler(
      activeLoadedDocumentKey,
      editorInstanceId,
      persistedBindingHandler,
    );
    return () => {
      unregisterSaveHandler(activeLoadedDocumentKey, editorInstanceId, handler);
      unregisterPersistedBindingHandler(
        activeLoadedDocumentKey,
        editorInstanceId,
        persistedBindingHandler,
      );
    };
  }, [activeLoadedDocumentKey, saveFn, isDirtyRef, mutationGate]);

  // Sync isDirty to the tab store for unsaved-changes detection
  useEffect(() => {
    if (!activeLoadedDocumentKey) return;
    const editorInstanceId = editorInstanceIdRef.current;
    useEditorSessionStore
      .getState()
      .setDocumentDirty(activeLoadedDocumentKey, isDirty, editorInstanceId);
    return () =>
      useEditorSessionStore
        .getState()
        .setDocumentDirty(activeLoadedDocumentKey, false, editorInstanceId);
  }, [activeLoadedDocumentKey, isDirty]);

  const editorSettings = useEditorSettings();
  const { schedule, cancel, pause, resume, flush } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

  // "Close without saving" is the one lifecycle path allowed to destroy a
  // dirty/conflicted EditorPane. Cancel its queued AutoSave synchronously
  // before the tab disappears; otherwise the hook cleanup sees a paused
  // pending edit and retains a detached instance that no UI can resume.
  useEffect(() => {
    if (!activeLoadedDocumentKey) return;
    const instanceId = editorInstanceIdRef.current;
    const discard = () => {
      cancel();
      setIsDirtyRef.current(false);
      useEditorSessionStore
        .getState()
        .setDocumentDirty(activeLoadedDocumentKey, false, instanceId);
      useExternalWriteStore.getState().shiftConflict(activeLoadedDocumentKey);
    };
    registerDiscardHandler(
      activeLoadedDocumentKey,
      instanceId,
      discard,
      groupIndex,
    );
    return () =>
      unregisterDiscardHandler(activeLoadedDocumentKey, instanceId, discard);
  }, [activeLoadedDocumentKey, cancel, groupIndex, setIsDirtyRef]);

  const filterSource = useAttributionStore((s) => s.filterSource);
  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const aiRatio = useTreeStore((s) =>
    isCodexMode || isChronicleEventMode ? 0 : (s.aiRatios[nodeId] ?? 0),
  );
  const togglePanel = useLayoutStore((s) => s.togglePanel);

  const insertFromSnippet = useEditorStore((s) => s.insertFromSnippet);
  const insertFromPaste = useEditorStore((s) => s.insertFromPaste);

  // Built once: a fresh extensions array on every render makes TipTap's
  // useEditor onRender effect call editor.setOptions each render (schema/
  // plugin churn). setMentionPopupState/setMentionIndex are stable setters.
  const canEditCodexSemanticLink =
    contentType === "scene" &&
    activeNode?.nodeType === "scene" &&
    !isFileBacked &&
    !readOnly;
  const treeNodeType = activeNode?.nodeType === "note" ? "note" : "scene";

  const editorExtensions = useMemo(
    () =>
      isFileBacked
        ? getFileBackedEditorExtensions()
        : getEditorExtensions({
            setMentionPopup: (s) => {
              setMentionPopupState(s);
              setMentionIndex(0);
            },
          }),
    [isFileBacked],
  );
  const editor = useEditor(
    {
      extensions: editorExtensions,
      content: "",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
        },
        handlePaste(view, event, slice) {
          const html = event.clipboardData?.getData("text/html");
          const plainText = event.clipboardData?.getData("text/plain") ?? "";
          // 「書式設定なし」フラグは paste 種別に関わらず必ず消費する。
          // (Case 1/2 で early-return しても arm が次の paste に漏れないように)
          const wantPlain = consumePlainPaste();

          if (html) {
            // Case 1: Grimodex 固有コピー（Codex/Snippet/Chat パネル）
            if (html.includes("data-grimodex-source")) {
              const segments = parseClipboardHtml(html);
              if (segments) {
                insertFromPaste(segments);
                return true;
              }
            }

            // Case 2: エディタ内コピー — ProseMirror パース済み Slice を使用
            // data-pm-slice は ProseMirror がコピー時に付与するマーカー。
            // 第3引数 slice は全マーク・ノード（ruby, emphasisDots, underline,
            // authorship 等）を保持している。programmaticInsert meta を設定して
            // AiEditedPlugin による authorship マーク除去を防ぐ。
            if (html.includes("data-pm-slice") && slice.size > 0) {
              view.dispatch(
                view.state.tr
                  .setMeta("programmaticInsert", true)
                  .setMeta("paste", true)
                  .setMeta("uiEvent", "paste")
                  .replaceSelection(slice)
                  .scrollIntoView(),
              );
              return true;
            }
          }

          // Case 3: 外部テキスト貼り付け — Markdown を変換して挿入する
          // (通常 = レンダリング, Ctrl/Cmd+Shift+V = Markdown 記法を除去)。
          // いずれも source:"unknown" 帰属を付与する。
          if (plainText) {
            // この view を所有するペインのエディタ (editorRef) を対象にする。
            // global store ref は primary group しかセットされず、split / Codex
            // wide-mode の副ペインに貼ると挿入先・focus が誤って primary に飛ぶ。
            const ed = editorRef.current;
            if (ed) {
              pasteExternalText(
                ed,
                plainText,
                (text) => insertFromPaste([{ text, source: "unknown" }]),
                wantPlain,
              );
            } else {
              insertFromPaste([{ text: plainText, source: "unknown" }]);
            }
            return true;
          }
          return false;
        },
        handleKeyDown(view, event) {
          if (handleZenEscapeKeyDown(view, event)) return true;
          // Ctrl/Cmd+Shift+V を「書式設定なし」ペーストとして arm する。
          // native paste は止めず、handlePaste 側で Markdown 記法を除去する。
          // 他キーでは arm を解除する (paste が来なかった場合の stale 防止)。
          notePlainPasteKeyDown(event);
          return false;
        },
        handleDrop(view, event) {
          const snippetData = event.dataTransfer?.getData(
            "application/x-grimodex-snippet",
          );
          if (!snippetData) return false;
          event.preventDefault();
          try {
            const {
              id,
              content,
              source,
              originalContent,
              sourceChatMessageId,
            } = JSON.parse(snippetData) as {
              id: string;
              content: string;
              source: "ai" | "human";
              originalContent: string | null;
              sourceChatMessageId?: string | null;
            };
            const coords = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
            insertFromSnippet(
              id,
              content,
              source,
              originalContent,
              coords?.pos,
              sourceChatMessageId ?? null,
            );
            return true;
          } catch {
            return false;
          }
        },
      },
      onUpdate({ editor: e, transaction }) {
        const ai = useInlineAiStore.getState();
        // TipTap は setEditable 等の「doc 未変更」イベントでも 'update' を
        // emit する (transaction.steps が空)。これを保存に流すと、未ロードの
        // 空 doc に pending が arm され本文消失の引き金になる (実機で
        // useLicenseEditableSync の mount 同期がこれを踏んでいた)。
        // 実際に doc が変わった transaction だけを保存系に通す。
        if (
          !shouldHandleEditorUpdate({
            docChanged: transaction.docChanged,
            isApplyingExternalUpdate: isApplyingExternalUpdate.current,
            inlineAiStatus: ai.status,
            activeEditor: ai.activeEditor,
            editor: e,
          })
        ) {
          return;
        }
        // インライン AI の生成中・diff 表示中はオートセーブを止める。
        // Accept/Reject が呼ばれて idle に戻った時点で reset + dispatch によって
        // 再度 onUpdate が走り、その時に通常の schedule が実行される。
        // owner 判定 (activeEditor === e) なので、分割ビューで別ペインが生成中でも
        // このペインの通常編集は保存される (LinearSceneBlock.onUpdate と同契約)。
        if (mutationGate.captureSave() === null) {
          // 調査ログ: 未ロード窓 (mount〜コンテンツ適用成功の間) で doc を
          // 変更している犯人の特定用。保存自体は saveFn 側 guard で skip される。
          debugLog.warn(
            "EditorPane",
            `doc changed while unloaded ${saveSceneIdRef.current?.slice(0, 8) ?? ""}`,
            JSON.stringify(transaction.steps.map((s) => s.toJSON())).slice(
              0,
              300,
            ),
          );
        }
        markStart("editor.onUpdate");
        markStart("editor.onUpdate.schedule");
        schedule();
        markEnd("editor.onUpdate.schedule");
        markStart("editor.onUpdate.setDirty");
        setIsDirtyRef.current(true);
        markEnd("editor.onUpdate.setDirty");
        const sid = saveSceneIdRef.current;

        // Auto-promote preview tab to pinned when user starts editing.
        if (sid) {
          markStart("editor.onUpdate.tabPin");
          if (groupIndex === 0) {
            useTabStore.getState().pinTab(sid);
          } else {
            useTabStore.getState().pinSecondaryTab(sid);
          }
          markEnd("editor.onUpdate.tabPin");
          // Auto-transition outline → draft on first keystroke in empty scene.
          // Only walk the doc text while wasEmptyRef is still true — once we've
          // seen any content, this branch is skipped permanently.
          if (!isEntryMode && wasEmptyRef.current) {
            const count = getDocText(e.state.doc).length;
            if (count > 0) {
              wasEmptyRef.current = false;
              const nodeStatus = useTreeStore
                .getState()
                .nodes.find((n) => n.id === sid)?.status as
                | SceneStatus
                | null
                | undefined;
              if (shouldAutoDraftTransition(count, true, nodeStatus ?? null)) {
                useTreeStore
                  .getState()
                  .setStatus(sid, "draft")
                  .catch(() => {});
              }
            }
          }
          // Broadcast to other panes showing the same content. Skip the
          // expensive `e.getJSON()` deep-clone when no Codex/Snippet mini-editor
          // or second EditorPane group is subscribed for this scene id — the
          // common case during normal scene editing.
          const documentKey = loadedDocumentKeyRef.current;
          if (documentKey && hasOtherLiveContentSubscriber(documentKey)) {
            markStart("editor.setLiveContent");
            useSceneContentStore
              .getState()
              .setLiveContent(
                documentKey,
                e.getJSON(),
                editorInstanceIdRef.current,
              );
            markEnd("editor.setLiveContent");
          }
        }

        // 文字数/Beat 統計と tree-store charCount 同期は EditorStatsFooter が
        // editor の update イベント経由で 200ms debounce 再計算する（本体の
        // state に置くとペイン全体が再レンダーされるため分離した）。
        markEnd("editor.onUpdate");
      },
      onTransaction({ editor: e, transaction }) {
        if (!transaction.docChanged) return;
        const sid = saveSceneIdRef.current;
        // 執筆タイムラプス: scene/codex/snippet いずれの body 編集も capture する。
        // recordChangeEvent 自体は disabled / no-project 時に no-op なので守備不要。
        //
        // ただし onTransaction は emitUpdate:false の setContent でも発火する。
        // scene 切替ロード・peer pane の live sync・authorship マーク再適用・
        // external reload はすべて isApplyingExternalUpdate 窓内のプログラム的
        // 更新で、これらを doc.step として記録するとロードが「執筆」に化けて
        // チェーンが汚れる（切替のたびに全文を再記録）。onUpdate (オートセーブ)
        // と同じく isApplyingExternalUpdate を見て、実ユーザー編集だけ捕捉する。
        //
        // onUpdate と違い inline-AI status では *あえて* gate しない。onUpdate は
        // full-doc autosave なので idle まで待てるが、こちらは step replay 用の
        // 逐次 capture。AI の insertText/delete は実 step で、これを飛ばすと後続
        // step の position がズレて replay (step.apply) が壊れる。AI insert/reject
        // は両方 step として残り「AI が X を提案→ユーザーが削除」と忠実に再現される。
        // Chronicle event detail は執筆タイムラプスの対象外（scene/codex/snippet の
        // body ではないメタデータ）。誤った entityType で記録しないよう skip。
        const capture = getEditorTimelapseCapture({
          id: sid,
          isEntryMode,
          isCodexMode,
          isSnippetMode,
          isChronicleEventMode,
          isApplyingExternalUpdate: isApplyingExternalUpdate.current,
        });
        if (capture) {
          try {
            recordChangeEvent({
              domain: capture.domain,
              opType: "doc.step",
              sceneId: capture.sceneId,
              entityType: capture.entityType,
              entityId: capture.entityId,
              payload: {
                steps: serializeTransactionSteps(transaction.steps),
              },
            });
          } catch (err) {
            // 防御的: capture 失敗で本流の onTransaction を止めない。
            console.warn("[timelapse] editor capture failed", err);
          }
        }
        if (isEntryMode) return;
        if (!sid) return;
        // Ordinary paragraph edits cannot change placed Beat membership or its
        // preview. Avoid three whole-document walks on every keystroke; the
        // detector remains conservative for unknown ProseMirror step shapes.
        if (!transactionTouchesSceneBeat(transaction)) return;
        markStart("editor.onTransaction");

        // Reconcile sceneBeat ↔ unplacedBeatsStore for transactions that
        // bypass `placeBeatAtEnd` / `unplaceBeat` — most importantly Ctrl+Z.
        //   Disappear from doc + not in store → restore (Place → Undo).
        //   Appear in doc + still in store    → drop from store (Unplace → Undo,
        //                                       prevents the same id showing up
        //                                       in both lists in the Grid).
        markStart("editor.onTransaction.beatScan");
        const oldBeats = new Map<
          string,
          {
            beatType: string;
            pov: string | null;
            content: unknown[];
          }
        >();
        transaction.before.descendants((node) => {
          if (node.type.name === "sceneBeat") {
            const id = node.attrs.id as string | null;
            if (id) {
              oldBeats.set(id, {
                beatType: (node.attrs.beatType ?? "free") as string,
                pov: (node.attrs.pov ?? null) as string | null,
                content: node.content.toJSON() as unknown[],
              });
            }
            return false;
          }
          return true;
        });

        const newIds = new Set<string>();
        e.state.doc.descendants((node) => {
          if (node.type.name === "sceneBeat") {
            const id = node.attrs.id as string | null;
            if (id) newIds.add(id);
            return false;
          }
          return true;
        });
        markEnd("editor.onTransaction.beatScan");

        const store = useUnplacedBeatsStore.getState();

        for (const [id, snap] of oldBeats) {
          if (newIds.has(id)) continue;
          if (store.getBeats(sid).some((b) => b.id === id)) continue;
          store.addBeat(sid, {
            id,
            beatType: snap.beatType as UnplacedBeat["beatType"],
            pov: snap.pov,
            collapsed: false,
            content: snap.content as UnplacedBeat["content"],
          });
        }

        for (const id of newIds) {
          if (oldBeats.has(id)) continue;
          if (!store.getBeats(sid).some((b) => b.id === id)) continue;
          store.removeBeat(sid, id);
        }

        // Live-sync the Grid preview cache (treeStore) so the Grid panel sees
        // beat changes immediately, without waiting for the debounced save.
        // Phase 4: 打鍵 50/s の経路。setNodePreview が同値 skip + nodes[] 非更新
        // なので、whole-array selector 29 サイトは notify されない。
        markStart("editor.onTransaction.treeMirror");
        const placed = extractPlacedBeatPreviewFromDoc(e.state.doc);
        const unplaced = extractUnplacedBeatPreview(store.getBeats(sid));
        useTreeStore.getState().setNodePreview(sid, {
          placed: placed === "[]" ? null : placed,
          unplaced: unplaced === "[]" ? null : unplaced,
        });
        markEnd("editor.onTransaction.treeMirror");
        markEnd("editor.onTransaction");
      },
      onSelectionUpdate() {},
      onFocus() {
        onFocus();
        // Trash bin の D&D 復元先として「最後にフォーカスしていたエディタ」を共有。
        // editor 参照も渡し、text-fragment 挿入時に直接 chain().insertContent を呼べるように。
        // Chronicle event detail は Trash Bin 復元ターゲット対象外（kind 不整合回避）。
        if (nodeId && !isChronicleEventMode) {
          const kind = isSnippetMode
            ? "snippet"
            : isCodexMode
              ? "codex"
              : "scene";
          useFocusedContentEditorStore
            .getState()
            .setCurrent({ kind, id: nodeId }, editorRef.current);
        }
        // Apply lazy cursor/scroll restore if one was deferred (Scenes-panel navigation).
        const pending = pendingCursorRestoreRef.current;
        if (pending) {
          pendingCursorRestoreRef.current = null;
          const ed = editorRef.current;
          if (ed) {
            const docSize = ed.state.doc.content.size;
            const from = Math.min(pending.from, Math.max(0, docSize - 1));
            const to = Math.min(pending.to, Math.max(0, docSize - 1));
            ed.commands.setTextSelection({ from, to });
          }
          // scrollOffset=null（縦横トグルで無効化済み）はスクロールを触らない
          // — 0 を書くと読み進めた位置から先頭へ飛ぶ。
          if (editorContainerRef.current && pending.scrollOffset != null) {
            setLogicalScrollOffset(
              editorContainerRef.current,
              pending.scrollOffset,
              isVerticalModeNow(),
            );
          }
        }
      },
    },
    [editorExtensions],
  );

  const editorViewReady = useEditorViewReady(editor);
  useLicenseEditableSync(editor, readOnly);
  /** Editor handle safe for PM view access (plugins, dom listeners, dispatch). */
  const mountedEditor =
    editorViewReady && isEditorViewReady(editor) ? editor : null;
  /** DB-native-only features (authorship, inline AI) — not on file-backed scenes. */
  const dbNativeEditor = mountedEditor && !isFileBacked ? mountedEditor : null;

  const paragraphReorder = useParagraphReorderOverlay(
    dbNativeEditor,
    readOnly || isEntryMode,
  );
  useClosePhoneReorderOverlay({
    phoneWorkspace,
    open: paragraphReorder.open,
    closeOverlay: paragraphReorder.closeOverlay,
  });
  const projectLanguage = getCurrentProjectLanguage();
  const bunsetsuAvailable = !(projectLanguage ?? "ja")
    .toLowerCase()
    .startsWith("en");
  const phraseAvailable = (projectLanguage ?? "ja")
    .toLowerCase()
    .startsWith("en");
  const wordAvailable = phraseAvailable;

  editorRef.current = editor;

  // B3: owner エディタ unmount 時の安全網。通常の離脱は pendingGuard が unmount
  // 自体を止めるが、レイアウト remount 等でこのペインの editor が破棄される際、
  // このエディタが所有する未確定 inline-AI セッションが残っていれば reset する
  // (stale な activeEditor / generatedRange が別 doc に幽霊 diff を出し、Accept/
  // Reject が別シーンを壊すのを防ぐ)。reset は editor に触れないので破棄順に依存
  // せず安全 (useLinearInlineAi の cleanup と同契約)。
  useEffect(() => {
    return () => {
      const ai = useInlineAiStore.getState();
      if (ai.status !== "idle" && ai.activeEditor === editor) {
        ai.reset();
      }
    };
    // nodeId も依存に含める: EditorPane は activeTabId 変更で remount せず同じ
    // editor インスタンスに別 doc をロードしうる。通常はナビゲーションガードが
    // pending 中の nodeId 変更を止めるが、万一すり抜けても stale な activeEditor /
    // generatedRange を残さないよう、doc swap 時にも owner セッションを畳む。
  }, [editor, nodeId]);

  // Wrap view.dispatch to time the full TipTap dispatch cycle: state.apply +
  // plugin.appendTransactions + view.updateState (DOM patching) + listeners.
  // This is the only way to attribute longtasks whose work happens entirely
  // inside the TipTap pipeline (decorations diff, NodeView updates, DOM
  // mutations) — none of which our per-plugin marks reach.
  useEffect(() => {
    if (!isEditorViewReady(mountedEditor)) return;
    const view = mountedEditor.view;
    const original = view.dispatch.bind(view);
    let depth = 0;
    view.dispatch = function patched(...args) {
      // Re-entrant dispatch (plugin appendTransaction during plugin apply etc.)
      // — only mark the outermost call, otherwise nested marks confuse the
      // duration buffer.
      if (depth === 0) markStart("editor.viewDispatch");
      depth++;
      try {
        return original(...args);
      } finally {
        depth--;
        if (depth === 0) markEnd("editor.viewDispatch");
      }
    };
    return () => {
      view.dispatch = original;
    };
  }, [mountedEditor]);

  // Register the primary editor in global store (for ChatPanel inserts).
  // Standalone mounts (Codex panel wide mode, identified by phaseIdOverride)
  // are NOT the primary scene editor and must not claim this slot — otherwise
  // two groupIndex=0 panes fight over it and chat inserts misroute.
  const setGlobalEditor = useEditorStore((s) => s.setEditor);
  useEffect(() => {
    if (groupIndex !== 0 || phaseIdOverride !== undefined) return;
    setGlobalEditor(mountedEditor);
    return () => setGlobalEditor(null);
  }, [mountedEditor, setGlobalEditor, groupIndex, phaseIdOverride]);

  // Linter — scene-only, primary group only.
  const lintSceneId = groupIndex === 0 && !isEntryMode ? nodeId : null;
  useLinter(mountedEditor, lintSceneId);
  const navigationSceneId =
    !isEntryMode &&
    (phoneWorkspace
      ? treeActiveSceneId === nodeId && phoneEditorOwnerGroup === groupIndex
      : groupIndex === 0)
      ? nodeId
      : null;

  // ゴミ箱キャプチャ。Snippet / Chronicle event タブは origin = null で skip、
  // Scene/Codex は対応する種別で記録する。
  const trashOrigin: TrashOrigin | null =
    isSnippetMode || isChronicleEventMode
      ? null
      : nodeId
        ? { kind: isCodexMode ? "codex" : "scene", id: nodeId }
        : null;
  useTrashBinCapture(mountedEditor, trashOrigin);

  // 同シーン内の伏線ジャンプ要求を処理する。
  // クロスシーンは switchScene の consumeJump に任せる（タイミング統一のため）。
  useEffect(() => {
    if (!editor || !navigationSceneId || isSceneContentLoading) return;
    const consumePendingJump = () => {
      const jump = useForeshadowNavStore.getState().pendingJump;
      if (!jump || jump.sceneId !== navigationSceneId) return;
      if (prevSceneIdRef.current !== navigationSceneId) return;
      const consumed = useForeshadowNavStore
        .getState()
        .consumeJump(navigationSceneId);
      if (!consumed) return;
      pendingCursorRestoreRef.current = null;
      const docSize = editor.state.doc.content.size;
      if (consumed.toPos > docSize) {
        editor.chain().focus().scrollIntoView().run();
        return;
      }
      editor
        .chain()
        .focus()
        .setTextSelection({ from: consumed.fromPos, to: consumed.toPos })
        .scrollIntoView()
        .run();
    };
    consumePendingJump();
    const unsubscribe = useForeshadowNavStore.subscribe((state, prev) => {
      const jump = state.pendingJump;
      if (!jump || jump === prev.pendingJump) return;
      consumePendingJump();
    });
    return unsubscribe;
  }, [editor, isSceneContentLoading, navigationSceneId]);

  // 同シーン内のセマンティック検索結果ジャンプ要求を処理する。phone では
  // hidden 済みの secondary が owner になった時も、既存 pending を拾う。
  const applySemanticJump = useCallback(
    (consumed: { chunkText: string }) => {
      if (!editor) return;
      pendingCursorRestoreRef.current = null;
      const range = findChunkInDoc(editor.state.doc, consumed.chunkText);
      if (!range) {
        editor.chain().focus().run();
        return;
      }
      const docSize = editor.state.doc.content.size;
      const from = Math.min(range.from, Math.max(0, docSize - 1));
      const to = Math.min(range.to, Math.max(0, docSize - 1));
      editor
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .scrollIntoView()
        .run();
    },
    [editor],
  );
  usePendingSemanticJump({
    sceneId: navigationSceneId,
    ready:
      Boolean(editor) &&
      !isSceneContentLoading &&
      prevSceneIdRef.current === navigationSceneId,
    applyJump: applySemanticJump,
  });

  const focusLoadedEditor = useCallback(() => {
    editorRef.current?.chain().focus().run();
  }, []);
  useRequestedEditorFocus({
    groupIndex,
    ready:
      !isSceneContentLoading &&
      prevSceneIdRef.current === nodeId &&
      (!phoneWorkspace ||
        (treeActiveSceneId === nodeId && phoneEditorOwnerGroup === groupIndex)),
    focus: focusLoadedEditor,
  });

  // Scroll editor to annotation mark when panel item is focused
  useEffect(() => {
    if (!focusedAnnotationId || !editorContainerRef.current) return;
    const el = editorContainerRef.current.querySelector(
      `[data-pe-ann-id="${CSS.escape(focusedAnnotationId)}"]`,
    );
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedAnnotationId]);

  // Ctrl+S / Ctrl+F / Ctrl+H / Ctrl+Shift+H key handlers
  const handleManualSave = useCallback(async () => {
    await flush();
    if (isEntryMode) return; // Codex/snippet entries: no revision on manual save
    // 未ロード doc は手動保存リビジョンにも残さない (空 doc 汚染防止)
    const snapshot = mutationGate.captureSave();
    if (!snapshot || snapshot.binding.kind !== "tree") return;
    const id = snapshot.binding.id;
    const ed = editorRef.current;
    if (!id || !ed) return;
    const content = JSON.stringify(ed.getJSON());
    await createRevision({
      entityType: "scene",
      entityId: id,
      content,
      snapshotType: "manual",
    });
  }, [flush, isEntryMode, mutationGate]);

  useEditorKeyboard({
    paneRef,
    saveSceneIdRef,
    editorRef,
    toolbarActionsRef,
    handleManualSave,
    setFindOpen,
    setFindShowReplace,
    setPalettePreselect,
    setPaletteOpen,
  });

  const isActiveGroup = groupIndex === activeGroupIndex;

  useInsertHighlight(editor);
  useGhostPreview(editor);
  useCodexHighlight(
    editor,
    // Snippet / Chronicle-event は補助コンテンツなので Codex ハイライトは見せるが
    // matchedEntryIds（シーン単位の CodexQuick が参照するグローバル集合）は更新しない。
    isSnippetMode || isChronicleEventMode
      ? {
          skipMatchedIds: true,
          enabledOverride: phoneWorkspace ? true : undefined,
        }
      : isCodexMode
        ? {
            excludeEntryIds: [nodeId],
            skipMatchedIds: !isActiveGroup,
            enabledOverride: phoneWorkspace ? true : undefined,
          }
        : !isActiveGroup
          ? {
              skipMatchedIds: true,
              enabledOverride: phoneWorkspace ? true : undefined,
            }
          : phoneWorkspace
            ? { enabledOverride: true }
            : undefined,
  );
  useFocusMode(editor);
  const typewriterMode = useCursorSettingsStore((s) => s.typewriterMode);
  const focusMode = useCursorSettingsStore((s) => s.focusMode);
  const zenMode = useCursorSettingsStore((s) => s.zenMode);
  const storedShowForeshadowMarks = useCursorSettingsStore(
    (s) => s.showForeshadowMarks,
  );
  const showForeshadowMarks = phoneWorkspace
    ? false
    : storedShowForeshadowMarks;
  // ガター生成レイヤーのON数から本文 inline-start の予約幅を算出する
  // （オーバーレイ表示中はアイコンが必ず見えるよう領域を確保する）。
  const showCommentsLayer = useCursorSettingsStore((s) => s.showComments);
  const showLintLayer = useCursorSettingsStore((s) => s.showLint);
  const showAnnotationsLayer = useAnnotationStore((s) => s.showAnnotations);
  const showReaderCommentsLayer = useAnnotationStore(
    (s) => s.showReaderComments,
  );
  const gutterReserve = phoneWorkspace
    ? null
    : gutterReserveInlineSize(
        [
          showCommentsLayer,
          showReaderCommentsLayer,
          showForeshadowMarks,
          // review チャネルは 校閲アノテーション ∨ Lint のどちらでも出るので、
          // showLint のみ ON でもガター記号分の幅を予約する (GutterMarksPlugin と同義)。
          showAnnotationsLayer || showLintLayer,
        ].filter(Boolean).length,
      );
  const focusModeHideBeats = editorSettings.focusModeHideBeats;
  const sceneMetaPanelOpen = editorSettings.sceneMetaPanelOpen;
  const sceneMetaPanelWidth = editorSettings.sceneMetaPanelWidth;
  const activeMobileSurface = useCompactNavigationStore(
    (state) => state.activeSurface,
  );
  const [phoneMetaPanelOpen, setPhoneMetaPanelOpen] = useState(false);
  const phoneMetaCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setPhoneMetaPanelOpen(false);
  }, [nodeId, phoneWorkspace]);
  useEffect(() => {
    if (activeMobileSurface !== "editor") setPhoneMetaPanelOpen(false);
  }, [activeMobileSurface]);
  useEffect(() => {
    if (!phoneWorkspace || !phoneMetaPanelOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = requestAnimationFrame(() =>
      phoneMetaCloseRef.current?.focus(),
    );
    return () => {
      cancelAnimationFrame(focusFrame);
      if (
        previouslyFocused?.isConnected &&
        useCompactNavigationStore.getState().activeSurface === "editor"
      ) {
        requestAnimationFrame(() => previouslyFocused.focus());
      }
    };
  }, [phoneMetaPanelOpen, phoneWorkspace]);
  // フォーカスモードでも詳細ペインは隠さない（本文の減光は FocusModePlugin 側）
  const isPanelVisible =
    (phoneWorkspace ? phoneMetaPanelOpen : sceneMetaPanelOpen) &&
    !isEntryMode &&
    !zenMode;
  const handleTogglePanel = useCallback(() => {
    if (phoneWorkspace) {
      setPhoneMetaPanelOpen((open) => !open);
      return;
    }
    useSettingsStore
      .getState()
      .set("editor.sceneMetaPanelOpen", String(!sceneMetaPanelOpen));
  }, [phoneWorkspace, sceneMetaPanelOpen]);
  const handlePanelLayoutChanged = useCallback(
    (layout: Record<string, number>) => {
      const w = layout["scene-meta"];
      if (w !== undefined) {
        useSettingsStore
          .getState()
          .set("editor.sceneMetaPanelWidth", String(Math.round(w)));
      }
    },
    [],
  );

  // Typewriter scroll: 横書きは縦スクロールで行を、縦書き(vertical-rl)は
  // 横スクロールで列を、それぞれ中央に保つ。
  const verticalMode = editorSettings.verticalMode;
  const effectiveTypewriter = typewriterMode;
  useTypewriterScroll(
    editor,
    effectiveTypewriter,
    editorContainerRef,
    verticalMode,
  );

  // When typewriter mode is toggled (on or off), scroll immediately to center
  // the cursor to prevent a visual jump from the 50vh/50vw padding being
  // added/removed. 縦書きでは横軸(scrollLeft)で列をセンタリングする。
  useEffect(() => {
    if (!editorContainerRef.current || !isEditorViewReady(mountedEditor))
      return;
    const container = editorContainerRef.current;
    const ed = mountedEditor;
    const raf = requestAnimationFrame(() => {
      const { from } = ed.view.state.selection;
      const containerRect = container.getBoundingClientRect();
      if (verticalMode) {
        const cursorX = verticalColumnCenterX(ed.view, from);
        if (cursorX == null) return;
        const target = computeTypewriterScrollLeft(
          cursorX,
          containerRect.left,
          container.scrollLeft,
          containerRect.width,
        );
        container.scrollTo({ left: target, behavior: "auto" });
      } else {
        let cursorTop: number;
        try {
          cursorTop = ed.view.coordsAtPos(from).top;
        } catch {
          return;
        }
        const target = computeTypewriterScrollTop(
          cursorTop,
          containerRect.top,
          container.scrollTop,
          containerRect.height,
        );
        container.scrollTo({ top: Math.max(0, target), behavior: "auto" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [effectiveTypewriter, verticalMode, mountedEditor, nodeId]);

  // Saved scroll offsets belong to one writing mode's block axis — toggling
  // vertical mode invalidates them (cursor positions stay; they are logical).
  // 無効化は 0 ではなく null: 0 は「先頭」という有効な位置なので、後段の
  // onFocus / restore が 0 を復元して先頭ジャンプになる。
  useEffect(() => {
    for (const [id, st] of savedEditorStateRef.current) {
      savedEditorStateRef.current.set(id, { ...st, scrollOffset: null });
    }
    if (pendingCursorRestoreRef.current) {
      pendingCursorRestoreRef.current = {
        ...pendingCursorRestoreRef.current,
        scrollOffset: null,
      };
    }
  }, [verticalMode]);
  const inlineAiDiff = useInlineAiDiff(dbNativeEditor, groupIndex);
  const { generate, retry, showProvidedText } = inlineAiDiff;
  // 分割ビューで両ペインが同じツールバーを二重表示しないよう、pending セッションを
  // 所有するペイン (activeEditor === このペインの editor) でだけ Toolbar を出す。
  const inlineAiOwnerEditor = useInlineAiStore((s) => s.activeEditor);
  const isInlineAiOwner =
    inlineAiOwnerEditor != null && inlineAiOwnerEditor === editor;
  const { acceptWithStaging, rejectWithStaging } = useAgentProseStaging(
    dbNativeEditor,
    nodeId,
    inlineAiDiff,
  );
  // inline-AI がこのペインで生成/プレビュー中 (非 idle = 未 accept のテキスト
  // が doc に入っている) は、arm 済みの autosave タイマーも解除する。
  // onUpdate の gate は「新規 schedule の抑止」しかせず、直前の編集で arm
  // 済みのタイマーは発火して未 accept のプレビュー本文ごと persist して
  // しまう (無帰属 AI テキストの焼き込み + version bump)。accept/reject で
  // idle に戻ると reset+dispatch の onUpdate が改めて schedule するので、
  // ここで消した「打鍵分の保存」は取りこぼされない。
  // 既知の残余 (スコープ外): diff 表示中の unmount flush / workspace 切替
  // quiesce はプレビュー込み doc を保存しうる pre-existing の穴。
  const inlineAiStatus = useInlineAiStore((s) => s.status);
  useEffect(() => {
    if (inlineAiStatus !== "idle" && inlineAiOwnerEditor === editor) {
      cancel();
    }
  }, [inlineAiStatus, inlineAiOwnerEditor, editor, cancel]);
  useEffect(() => {
    if (hasExternalConflict) pause();
    else resume();
  }, [hasExternalConflict, pause, resume]);

  const handleKeepExternalEdit = useCallback(async () => {
    const snapshot = mutationGate.captureSave();
    if (!snapshot) {
      throw new Error("The editor document is not loaded");
    }

    let persistedBinding = snapshot.binding;
    if (snapshot.binding.kind === "codex") {
      const binding = snapshot.binding;
      const version =
        binding.phaseId === null
          ? useCodexStore
              .getState()
              .entries.find((entry) => entry.id === binding.id)?.version
          : usePhaseStore
              .getState()
              .phasesByEntry[
                binding.id
              ]?.find((phase) => phase.id === binding.phaseId)?.version;
      if (version === undefined) {
        throw new Error(`Codex document '${binding.id}' no longer exists`);
      }
      persistedBinding = { ...binding, loadedVersion: version };
    } else if (snapshot.binding.kind === "snippet") {
      const version = useSnippetStore
        .getState()
        .entries.find((entry) => entry.id === snapshot.binding.id)?.version;
      if (version === undefined) {
        throw new Error(`Snippet '${snapshot.binding.id}' no longer exists`);
      }
      persistedBinding = { ...snapshot.binding, loadedVersion: version };
    } else if (snapshot.binding.kind === "chronicle-event") {
      const version = await getEventVersion(
        getCurrentProjectId(),
        snapshot.binding.id,
      );
      if (version === null) {
        throw new Error(`Event '${snapshot.binding.id}' no longer exists`);
      }
      persistedBinding = { ...snapshot.binding, loadedVersion: version };
    }

    if (!mutationGate.advancePeerSave(persistedBinding)) {
      throw new Error(
        "The editor document changed while resolving the conflict",
      );
    }
    schedule();
  }, [mutationGate, schedule]);

  const handleReloadExternalEdit = useCallback(() => {
    cancel();
  }, [cancel]);

  useCursorOverlay(mountedEditor);
  useImeDiagnostics(mountedEditor);
  useCharacterFade(mountedEditor);
  useTateChuYoko(mountedEditor);
  useShowInvisibles(mountedEditor);
  useCodexCompletion(mountedEditor, !isEntryMode && !readOnly);
  useAttribution(dbNativeEditor);

  // インライン AI コマンドの起動を1箇所に集約する。slash メニュー(下の
  // CustomEvent 経路)とバブルメニューの AI サブメニュー(EditorContentArea 経由で
  // prop 注入)の両方から呼ばれる。分岐は従来 onSlashCommand が持っていたもの:
  // insert-node は構造挿入 / needsArg はパレットへ委譲 / それ以外は即 generate。
  const handleInlineAiCommand = useCallback(
    (cmd: InlineAiCommand) => {
      const ed = dbNativeEditor;
      if (!ed || !isEditorViewReady(ed)) return;
      // Beat system: structural inserts skip the AI pipeline entirely.
      if (cmd.kind === "insert-node") {
        if (cmd.id === "sceneBeat") {
          ed.chain().focus().insertSceneBeat().run();
        }
        return;
      }
      // 引数不要なコマンドは即時 generate を叩き、フロー状態を維持する。
      // 引数必要なコマンドは従来通りパレットを開き、引数入力フォームに委譲。
      if (cmd.needsArg) {
        setPalettePreselect(cmd);
        setPaletteOpen(true);
        return;
      }
      const node = useTreeStore.getState().nodes.find((n) => n.id === nodeId);
      const projectTitle =
        useWorkspaceStore.getState().activeWorkspaceName ?? "";
      const matchedCodexIds = useCodexHighlightStore.getState().matchedEntryIds;
      const codexEntries = useCodexStore.getState().entries;
      const context = buildInlineAiContext({
        editor: ed,
        projectTitle,
        sceneTitle: node?.title ?? "",
        matchedCodexIds,
        codexEntries,
      });
      generate(cmd, context);
    },
    [dbNativeEditor, nodeId, generate],
  );

  // Listen for slash-command events dispatched by SlashCommandExtension
  useEffect(() => {
    if (!dbNativeEditor || !isEditorViewReady(dbNativeEditor)) return;
    const ed = dbNativeEditor;
    let dom: HTMLElement;
    try {
      dom = ed.view.dom;
    } catch {
      return;
    }
    function onSlashCommand(e: Event) {
      const cmd = (e as CustomEvent).detail?.command as
        | InlineAiCommand
        | undefined;
      if (!cmd) return;
      handleInlineAiCommand(cmd);
    }
    dom.addEventListener("inlineai:slash-command", onSlashCommand);
    return () => {
      dom.removeEventListener("inlineai:slash-command", onSlashCommand);
    };
  }, [dbNativeEditor, handleInlineAiCommand]);

  // Subscribe to content sync from the other pane (or CodexContentEditor mini-editor).
  // Apply is rAF-coalesced: a typing burst on the peer pane collapses to at most
  // one full-doc setContent per frame on the mirror, instead of one per keystroke.
  useEffect(() => {
    if (!editor || !activeLoadedDocumentKey) return;
    return subscribeLiveContentRafCoalesced(
      activeLoadedDocumentKey,
      editorInstanceIdRef.current,
      (next) => {
        isApplyingExternalUpdate.current = true;
        try {
          mutationGate.runProgrammatic(() => {
            markStart("editor.externalSync.setContent");
            editor.commands.setContent(
              next as Parameters<typeof editor.commands.setContent>[0],
              { emitUpdate: false },
            );
            markEnd("editor.externalSync.setContent");
          });
        } finally {
          isApplyingExternalUpdate.current = false;
        }
      },
    );
  }, [activeLoadedDocumentKey, editor, mutationGate]);

  // Subscribe to unplaced beats changes → mark dirty and schedule save,
  // and live-sync the Grid preview cache for immediate UI feedback.
  useEffect(() => {
    if (!nodeId || isEntryMode) return;
    const unsubscribe = useUnplacedBeatsStore
      .getState()
      .subscribe(nodeId, () => {
        if (mutationGate.captureSave() === null) {
          // 調査ログ: 未ロード窓で autosave を arm する経路の特定用。
          debugLog.warn(
            "EditorPane",
            `beats changed while unloaded ${nodeId.slice(0, 8)}`,
          );
        }
        schedule();
        setIsDirtyRef.current(true);
        const beats = useUnplacedBeatsStore.getState().getBeats(nodeId);
        const unplaced = extractUnplacedBeatPreview(beats);
        useTreeStore.getState().setNodePreview(nodeId, {
          unplaced: unplaced === "[]" ? null : unplaced,
        });
      });
    return unsubscribe;
  }, [nodeId, isEntryMode, schedule, mutationGate, setIsDirtyRef]);

  // Load content when nodeId changes
  useEffect(() => {
    if (!editor || !nodeId) return;

    let cancelled = false;
    setIsSceneContentLoading(true);

    async function switchScene() {
      markStart("editor.switchScene");
      try {
        const prevId = prevSceneIdRef.current;
        // The render-time key reset above keeps this ref aligned with the
        // currently loaded canonical document without making this load effect
        // re-run merely because commitLoad published its key.
        const currentDocumentStateKey = externalReloadRef.current.key;
        const externalReloadRequested =
          currentDocumentStateKey !== null &&
          externalReloadRef.current.nonce !== externalReloadNonce;
        externalReloadRef.current = {
          key: currentDocumentStateKey,
          nonce: externalReloadNonce,
        };
        if (externalReloadRequested) {
          // The reload action chooses the persisted external version. Do not
          // flush the stale local buffer immediately before replacing it.
          cancel();
        } else if (prevId && prevId !== nodeId) {
          // Save current cursor/scroll state before leaving this scene
          const ed = editorRef.current;
          if (ed) {
            const { from, to } = ed.view.state.selection;
            savedEditorStateRef.current.set(prevId, {
              from,
              to,
              scrollOffset: editorContainerRef.current
                ? getLogicalScrollOffset(
                    editorContainerRef.current,
                    isVerticalModeNow(),
                  )
                : 0,
            });
          }
          await flush();
        } else if (prevId === nodeId) {
          // Same node, phase override changed: flush unsaved changes before reloading
          await flush();
        }
        cancel();
        saveSceneIdRef.current = nodeId;
        // Invalidate the save binding before loading the next document. The
        // old binding remains valid only until the pre-switch flush completes.
        mutationGate.beginLoad();
        loadedDocumentKeyRef.current = null;
        setLoadedDocumentKey(null);
        // ここから新コンテンツの適用が成功するまで、エディタ内の doc は
        // 保存禁止 (coreSave が skip)。途中失敗した doc を autosave が
        // 書き戻すと本文消失になるため。

        // Hold the external-update guard for the entire scene-switch sequence
        // (setContent + authorship load + foreshadow load). Releasing it earlier
        // lets a fast typist trigger autosave while marks are mid-load, which
        // would persist a doc with no setup marks and orphan every setup row.
        isApplyingExternalUpdate.current = true;
        try {
          const target = targetFromTab(contentType, nodeId, {
            tree: {
              nodeType: treeNodeType,
              storage: isFileBacked ? "file" : "database",
            },
            phaseIdOverride: overridePhaseId,
            sceneId: phaseResolutionSceneId,
          });
          const phaseContext =
            target.kind !== "codex"
              ? { mode: "base" as const }
              : target.phase.mode === "base"
                ? { mode: "base" as const }
                : target.phase.mode === "explicit"
                  ? { mode: "explicit" as const, phaseId: target.phase.phaseId }
                  : { mode: "auto" as const, sceneId: target.phase.sceneId };
          const loaded = await loadEditorDocument(target, {
            codex: {
              phase: phaseContext,
              sceneTimeIndex: phaseSceneTimeIndex,
              resolutionMode: phaseResolutionMode,
            },
          });
          if (cancelled) return;
          if (loaded.title !== undefined) {
            setChronicleEventTitle(loaded.title);
          }
          const strictContent =
            loaded.binding.kind === "tree" || loaded.binding.kind === "codex";
          mutationGate.runProgrammatic(() => {
            markStart(`sceneLoad.setContent.${loaded.binding.kind}`);
            editor!.commands.setContent(loaded.content, {
              emitUpdate: false,
              ...(strictContent ? { errorOnInvalidContent: true } : {}),
            });
            markEnd(`sceneLoad.setContent.${loaded.binding.kind}`);
          });
          if (loaded.binding.kind === "tree") {
            const contentLength =
              typeof loaded.content === "string"
                ? loaded.content.length
                : JSON.stringify(loaded.content).length;
            debugLog.info(
              "EditorPane",
              `load ${nodeId.slice(0, 8)}`,
              JSON.stringify({
                dbLen: contentLength,
                docLen: getDocText(editor!.state.doc).length,
                fileBacked: isFileBacked,
              }),
            );
            try {
              const beats = JSON.parse(loaded.unplacedBeatsDoc ?? "[]");
              useUnplacedBeatsStore.getState().setBeats(nodeId, beats, "load");
            } catch {
              useUnplacedBeatsStore.getState().setBeats(nodeId, [], "load");
            }
            const curPreview = useTreeStore.getState().nodePreviews[nodeId];
            if (curPreview?.placed == null) {
              const preview = extractPlacedBeatPreview(editor!.getJSON());
              if (preview !== "[]") {
                savePlacedBeatPreviewOnly(nodeId, preview).catch(() => {});
                useTreeStore
                  .getState()
                  .setNodePreview(nodeId, { placed: preview });
              }
            }
          }
          const loadedBinding = loaded.binding;
          setLoadedPhaseId(
            loadedBinding.kind === "codex" ? loadedBinding.phaseId : null,
          );

          // 3 ブランチとも setContent 成功 = エディタ内 doc はロード済み本物。
          // ここで初めて保存を解禁する。
          if (cancelled) return;
          mutationGate.commitLoad(loadedBinding);
          const nextDocumentKey = documentKeyFromBinding(loadedBinding);
          loadedDocumentKeyRef.current = nextDocumentKey;
          setLoadedDocumentKey(nextDocumentKey);

          if (!cancelled) {
            setIsSceneContentLoading(false);
          }

          // 表示用の count 系は EditorStatsFooter が isLoading の false 遷移で
          // 再計算・tree 同期する。ここでは auto-draft 判定用の空判定だけ行う。
          const count = getDocText(editor!.state.doc).length;
          setIsDirtyRef.current(false);
          wasEmptyRef.current = count === 0;

          if (!isEntryMode) {
            const sidecars = await loadSceneSidecars(
              nodeId,
              useTreeStore.getState().projectId,
            );
            applySceneSidecars(editor!, nodeId, sidecars, () => cancelled);
          }
        } finally {
          isApplyingExternalUpdate.current = false;
        }

        // シーン/Codex ロード完了後: 使い回しエディタの undo スタックを空にする。
        // 残すと Ctrl+Z が前シーンの doc スナップショットを復元して本文が消える。
        if (!cancelled && mutationGate.captureSave() && editor) {
          resetEditorHistory(editor.view);
        }

        // Reset scroll to the start edge after scene load; saved state will be
        // restored below. Both axes so the reset is writing-mode independent.
        if (editorContainerRef.current) {
          editorContainerRef.current.scrollTop = 0;
          editorContainerRef.current.scrollLeft = 0;
        }

        prevSceneIdRef.current = nodeId;

        // Decide whether to focus the editor immediately.
        // Tab clicks set the flag; Scenes-panel navigation does not.
        const focusNow = useEditorSessionStore
          .getState()
          .consumeEditorFocusRequest(groupIndex);

        // Clear any pending lazy restore from a previous scene switch so stale
        // state is never applied if this new switch doesn't produce saved data.
        pendingCursorRestoreRef.current = null;

        // 伏線パネル / セマンティック検索からのジャンプ要求は saved cursor
        // 復元より優先する。伏線が先 (両方が同 scene に立つことはほぼ無いが
        // 念のため固定順)。両方の store から必ず consume する: そうしないと
        // 敗者側 (例: fJump 採用時の semantic jump) が次の switchScene まで
        // 残り、別シーンの呼び出しで余計な飛び先になる。
        const fJump = useForeshadowNavStore.getState().consumeJump(nodeId);
        const sJumpRaw = useSemanticNavStore.getState().consumeJump(nodeId);
        const sJump = fJump ? null : sJumpRaw;
        if (fJump && !cancelled) {
          requestAnimationFrame(() => {
            if (cancelled) return;
            const ed = editorRef.current;
            if (!ed) return;
            const docSize = ed.state.doc.content.size;
            if (fJump.toPos > docSize) {
              ed.chain().focus().scrollIntoView().run();
              return;
            }
            const from = Math.min(fJump.fromPos, Math.max(0, docSize - 1));
            const to = Math.min(fJump.toPos, Math.max(0, docSize - 1));
            ed.chain()
              .focus()
              .setTextSelection({ from, to })
              .scrollIntoView()
              .run();
          });
        } else if (sJump && !cancelled) {
          requestAnimationFrame(() => {
            if (cancelled) return;
            const ed = editorRef.current;
            if (!ed) return;
            const range = findChunkInDoc(ed.state.doc, sJump.chunkText);
            if (!range) {
              ed.chain().focus().run();
              return;
            }
            const docSize = ed.state.doc.content.size;
            const from = Math.min(range.from, Math.max(0, docSize - 1));
            const to = Math.min(range.to, Math.max(0, docSize - 1));
            ed.chain()
              .focus()
              .setTextSelection({ from, to })
              .scrollIntoView()
              .run();
          });
        } else {
          // Restore cursor/scroll state if this node was previously visited.
          const saved = savedEditorStateRef.current.get(nodeId);
          if (saved && !cancelled) {
            if (focusNow) {
              // Tab click: focus the editor and restore cursor/scroll immediately.
              requestAnimationFrame(() => {
                if (cancelled) return;
                const ed = editorRef.current;
                if (ed) {
                  const docSize = ed.state.doc.content.size;
                  const from = Math.min(saved.from, Math.max(0, docSize - 1));
                  const to = Math.min(saved.to, Math.max(0, docSize - 1));
                  ed.chain().focus().setTextSelection({ from, to }).run();
                }
                if (editorContainerRef.current && saved.scrollOffset != null) {
                  setLogicalScrollOffset(
                    editorContainerRef.current,
                    saved.scrollOffset,
                    isVerticalModeNow(),
                  );
                }
              });
            } else {
              // Scenes-panel navigation: defer restore until the editor is focused
              // so keyboard navigation in the panel is not interrupted.
              pendingCursorRestoreRef.current = {
                from: saved.from,
                to: saved.to,
                scrollOffset: saved.scrollOffset,
              };
            }
          } else if (focusNow && !cancelled) {
            // A freshly created scene has no saved cursor state yet. Mobile
            // bootstrap/navigation still requested explicit editing focus, so
            // focus the loaded editor instead of leaving the bottom navigation
            // (or the temporary preparing state) as the keyboard target.
            requestAnimationFrame(() => {
              if (!cancelled) editorRef.current?.chain().focus().run();
            });
          }
        }
        if (externalReloadRequested && loadedDocumentKeyRef.current) {
          const reloadedDocumentKey = loadedDocumentKeyRef.current;
          useEditorSessionStore
            .getState()
            .setDocumentDirty(
              reloadedDocumentKey,
              false,
              editorInstanceIdRef.current,
            );
          useExternalWriteStore.getState().shiftConflict(reloadedDocumentKey);
        }
      } catch (err) {
        if (!cancelled) {
          mutationGate.failLoad();
          loadedDocumentKeyRef.current = null;
          setLoadedDocumentKey(null);
          setIsSceneContentLoading(false);
          // mutation gate は未ロード状態のまま = この doc は保存されない。無言で
          // rethrow すると「空のエディタが出て本文が消えた」ようにしか見えない
          // ため、ログ + トーストで可視化する。
          debugLog.error(
            "EditorPane",
            `switchScene failed ${nodeId.slice(0, 8)}`,
            errorDetail(err),
          );
          toast.error(
            i18next.t("sceneLoad.failed", { reason: rootCause(err) }),
          );
        }
        throw err;
      } finally {
        markEnd("editor.switchScene");
      }
    }

    switchScene();
    return () => {
      cancelled = true;
    };
  }, [
    nodeId,
    editor,
    flush,
    cancel,
    isCodexMode,
    isSnippetMode,
    isChronicleEventMode,
    isEntryMode,
    isFileBacked,
    treeNodeType,
    contentType,
    overridePhaseId,
    groupIndex,
    externalReloadNonce,
    codexPhaseStructureKey,
    phaseResolutionSceneId,
    phaseSceneTimeIndex,
    phaseResolutionMode,
    mutationGate,
    setIsDirtyRef,
    setLoadedPhaseId,
  ]);

  useEffect(() => {
    function onExternalReload(e: Event) {
      const detail = (e as CustomEvent<{ sceneId: string; content: string }>)
        .detail;
      if (detail.sceneId !== nodeId || !editorRef.current) return;
      if (guardInlineAiPending()) return;
      isApplyingExternalUpdate.current = true;
      try {
        const parsed =
          detail.content && detail.content !== "{}"
            ? JSON.parse(detail.content)
            : "";
        mutationGate.runProgrammatic(() => {
          editorRef.current!.commands.setContent(parsed, { emitUpdate: false });
        });
        resetEditorHistory(editorRef.current.view);
        setIsDirtyRef.current(false);
      } finally {
        isApplyingExternalUpdate.current = false;
      }
    }
    window.addEventListener("external-mount:reload-scene", onExternalReload);
    return () =>
      window.removeEventListener(
        "external-mount:reload-scene",
        onExternalReload,
      );
  }, [nodeId, mutationGate, setIsDirtyRef]);

  const isNote = !isEntryMode && activeNode?.nodeType === "note";

  const editorTitle = isCodexMode
    ? (activeCodexEntry?.name ?? "")
    : isSnippetMode
      ? (activeSnippetEntry?.title ?? "")
      : isChronicleEventMode
        ? chronicleEventTitle
        : (activeNode?.title ?? "");

  // contenteditable の accessible name。editorProps.attributes は生成時に固定
  // されるため、タブ切替・リネームに追従できるよう view.dom へ動的に付与する。
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute(
      "aria-label",
      editorTitle
        ? t("editor.a11y.editorBody", { title: editorTitle })
        : t("editor.a11y.editorBodyUntitled"),
    );
  }, [editor, editorTitle, t]);

  // Phase label for display in banner and title (null = no active phase / base content)
  const loadedPhaseLabel =
    loadedPhaseId != null
      ? (codexPhases?.find((p) => p.id === loadedPhaseId)?.label ?? null)
      : null;

  const handleTitleEditStart = () => {
    setTitleDraft(editorTitle);
    setTitleEditing(true);
  };

  const handleTitleSave = () => {
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === editorTitle) {
      setTitleEditing(false);
      return;
    }
    if (titleSaveInFlightRef.current) return;

    const documentKey = activeLoadedDocumentKey;
    if (!documentKey) return;
    const instanceId = editorInstanceIdRef.current;
    // Title writes are not driven by TipTap's update event, but they are still
    // part of the same document aggregate. Keep the exact session dirty until
    // the tracked write succeeds so workspace switching cannot discard it.
    useEditorSessionStore
      .getState()
      .setDocumentDirty(documentKey, true, instanceId);

    const write = trackPendingEditorWrite(
      (async () => {
        try {
          // Title and body share one aggregate version for Codex base,
          // Snippet, and Chronicle Event. Drain a pending body write first,
          // then advance the same session binding with the title write result.
          await flush();
          const snapshot = mutationGate.captureSave();

          if (isCodexMode) {
            if (
              snapshot?.binding.kind !== "codex" ||
              snapshot.binding.id !== nodeId
            ) {
              throw new Error("Codex title save target is no longer loaded");
            }
            const outcome = await updateCodexEntryStore(
              nodeId,
              { name: trimmed },
              // A Phase body has its own version row; renaming the parent entry
              // must not use the Phase version as the Codex base version.
              snapshot.binding.phaseId === null
                ? { baseVersion: snapshot.binding.loadedVersion }
                : undefined,
            );
            if (!outcome.persisted) {
              throw new Error(`Codex title was not persisted: ${nodeId}`);
            }
            if (outcome.persisted && snapshot.binding.phaseId === null) {
              const binding = {
                ...snapshot.binding,
                loadedVersion: outcome.version,
              } as const;
              mutationGate.commitSave(snapshot, binding);
              announcePersistedBinding(
                documentKeyFromBinding(binding),
                editorInstanceIdRef.current,
                binding,
              );
            } else if (outcome.persisted) {
              const binding = {
                kind: "codex",
                id: nodeId,
                phaseId: null,
                loadedVersion: outcome.version,
              } as const;
              announcePersistedBinding(
                documentKeyFromBinding(binding),
                editorInstanceIdRef.current,
                binding,
              );
            }
          } else if (isSnippetMode) {
            if (
              snapshot?.binding.kind !== "snippet" ||
              snapshot.binding.id !== nodeId
            ) {
              throw new Error("Snippet title save target is no longer loaded");
            }
            const outcome = await updateSnippetEntryStore(
              nodeId,
              { title: trimmed },
              { baseVersion: snapshot.binding.loadedVersion },
            );
            if (!outcome.persisted) {
              throw new Error(`Snippet title was not persisted: ${nodeId}`);
            }
            if (outcome.persisted) {
              const binding = {
                ...snapshot.binding,
                loadedVersion: outcome.version,
              } as const;
              mutationGate.commitSave(snapshot, binding);
              announcePersistedBinding(
                documentKeyFromBinding(binding),
                editorInstanceIdRef.current,
                binding,
              );
            }
          } else if (isChronicleEventMode) {
            if (
              snapshot?.binding.kind !== "chronicle-event" ||
              snapshot.binding.id !== nodeId
            ) {
              throw new Error(
                "Chronicle title save target is no longer loaded",
              );
            }
            const result = await uiUpdateEvent(
              {
                eventId: nodeId,
                title: trimmed,
                baseVersion: snapshot.binding.loadedVersion,
              },
              { suppressDocumentNotification: true },
            );
            const binding = {
              ...snapshot.binding,
              loadedVersion: result.version,
            } as const;
            mutationGate.commitSave(snapshot, binding);
            announcePersistedBinding(
              documentKeyFromBinding(binding),
              editorInstanceIdRef.current,
              binding,
            );
            if (
              loadedDocumentKeyRef.current?.kind === "chronicle-event" &&
              loadedDocumentKeyRef.current.id === nodeId
            ) {
              setChronicleEventTitle(trimmed);
            }
          } else {
            await updateNodeTitle(nodeId, trimmed);
          }
          if (!isDirtyRef.current) {
            useEditorSessionStore
              .getState()
              .setDocumentDirty(documentKey, false, instanceId);
          }
          setTitleEditing(false);
        } catch (error) {
          debugLog.warn("EditorPane", "title save failed", errorDetail(error));
          useEditorSessionStore
            .getState()
            .setDocumentDirty(documentKey, true, instanceId);
          if (isChronicleEventMode) {
            toast.error(t("chronicle.actionFailed", "操作に失敗しました"));
          }
          throw error;
        }
      })(),
    );
    titleSaveInFlightRef.current = write;
    void write
      .catch(() => {
        // Persistence owners already emitted the actionable notification.
        // Keeping the input open and the document dirty is the recovery path.
      })
      .finally(() => {
        if (titleSaveInFlightRef.current === write) {
          titleSaveInFlightRef.current = null;
        }
      });
  };

  const handleTitleCancel = () => {
    setTitleEditing(false);
  };

  // EditorPane (SceneEditor) は extraItems を渡さないので popup item は常に
  // kind="codex"。MentionItem 型のままハンドラに通す。
  const handleMentionSelect = useCallback(
    (item: MentionItem) => {
      mentionPopup?.command?.(item);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );

  const handleMentionSelectWithRole = useCallback(
    (item: MentionItem, role: MentionRole) => {
      mentionPopup?.command?.(item, role);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );

  const editorContentAreaProps = {
    editor,
    editorContainerRef,
    toolbarActionsRef,
    findOpen,
    findShowReplace,
    setFindOpen,
    showForeshadowMarks,
    gutterReserve,
    focusModeHideBeats,
    focusMode,
    typewriterMode: effectiveTypewriter,
    filterSource,
    editorSettings,
    editorTitle,
    loadedPhaseLabel,
    titleEditing,
    titleDraft,
    setTitleDraft,
    handleTitleSave,
    handleTitleCancel,
    handleTitleEditStart,
    isSceneContentLoading,
    sceneId: nodeId,
    canEditCodexSemanticLink:
      canEditCodexSemanticLink && editor?.isEditable === true,
    zenMode,
    onInlineAiCommand: dbNativeEditor ? handleInlineAiCommand : undefined,
  };

  const beatDragDrop = {
    sensors: beatSensors,
    collisionDetection: beatCollisionDetection,
    draggingBeat,
    onDragStart: handleBeatDragStart,
    onDragEnd: handleBeatDragEnd,
  };

  const handlePaletteSubmit = useCallback(
    (command: InlineAiCommand, prompt: string) => {
      if (!editor) return;
      const node = useTreeStore
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      const projectTitle =
        useWorkspaceStore.getState().activeWorkspaceName ?? "";
      const matchedCodexIds = useCodexHighlightStore.getState().matchedEntryIds;
      const codexEntries = useCodexStore.getState().entries;
      const context = buildInlineAiContext({
        editor,
        projectTitle,
        sceneTitle: node?.title ?? "",
        matchedCodexIds,
        codexEntries,
        arg: prompt || undefined,
      });
      generate(command, context);
    },
    [editor, generate, nodeId],
  );

  const handlePaletteSubmitAb = useCallback(
    (command: InlineAiCommand, prompt: string) => {
      if (!editor) return;
      const node = useTreeStore
        .getState()
        .nodes.find((candidate) => candidate.id === nodeId);
      const projectTitle =
        useWorkspaceStore.getState().activeWorkspaceName ?? "";
      const matchedCodexIds = useCodexHighlightStore.getState().matchedEntryIds;
      const codexEntries = useCodexStore.getState().entries;
      const context = buildInlineAiContext({
        editor,
        projectTitle,
        sceneTitle: node?.title ?? "",
        matchedCodexIds,
        codexEntries,
        arg: prompt || undefined,
      });
      const lang = getCurrentProjectLanguage();
      const messages: AbInlineState["messages"] = [
        {
          role: "system",
          content: buildInlineSystemPrompt(command, context, lang),
        },
        {
          role: "user",
          content: buildInlineUserPrompt(command, context, lang),
        },
      ];
      const { from, to } = editor.state.selection;
      const isReplace = command.mode === "replace" && from !== to;
      setAbInline({
        messages,
        mode: isReplace ? "replace" : "insert",
        originalRange: isReplace ? { from, to } : null,
        insertPos: isReplace ? null : from,
        projectId: getCurrentProjectId(),
      });
    },
    [editor, nodeId],
  );

  const handleAdoptAb = useCallback(
    (text: string) => {
      if (!abInline) return;
      showProvidedText(text, {
        mode: abInline.mode,
        originalRange: abInline.originalRange ?? undefined,
        insertPos: abInline.insertPos ?? undefined,
      });
      setAbInline(null);
    },
    [abInline, showProvidedText],
  );

  const handleStatusChange = useCallback(
    (status: SceneStatus) => {
      useTreeStore
        .getState()
        .setStatus(nodeId, status)
        .catch(() => {});
    },
    [nodeId],
  );

  const handleOpenRevisionHistory = useCallback(() => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (id && ed) {
      const content = JSON.stringify(ed.getJSON());
      useRevisionStore.getState().openHistory("scene", id, content);
    }
  }, []);

  const __renderResult = (
    <div
      ref={setPaneRef}
      data-droptarget-id={editorDropId}
      className="relative flex flex-1 flex-col overflow-hidden data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
    >
      <div
        className="contents"
        aria-hidden={phoneWorkspace && phoneMetaPanelOpen ? true : undefined}
        inert={phoneWorkspace && phoneMetaPanelOpen ? true : undefined}
      >
        <Toolbar
          editor={editor}
          onFindReplace={() => {
            setFindOpen(true);
            setFindShowReplace(true);
          }}
          actionsRef={toolbarActionsRef}
          panelOpen={phoneWorkspace ? phoneMetaPanelOpen : sceneMetaPanelOpen}
          onTogglePanel={handleTogglePanel}
          sceneId={isEntryMode ? undefined : nodeId}
          nodeType={activeNode?.nodeType}
          reorderOpen={paragraphReorder.open}
          onToggleReorder={
            dbNativeEditor ? paragraphReorder.toggleOverlay : undefined
          }
          reorderDisabled={!dbNativeEditor || readOnly}
        />
        <EditorPaneRibbon
          nodeId={nodeId}
          isEntryMode={isEntryMode}
          isFileBacked={isFileBacked}
          isNote={isNote}
          isCodexMode={isCodexMode}
          isSnippetMode={isSnippetMode}
          isChronicleEventMode={isChronicleEventMode}
          activeCodexEntry={activeCodexEntry}
          activeSnippetEntry={activeSnippetEntry}
          loadedPhaseLabel={loadedPhaseLabel}
          chronicleEventTitle={chronicleEventTitle}
          documentKey={activeLoadedDocumentKey}
          editorInstanceId={editorInstanceIdRef.current}
          onKeepExternalEdit={handleKeepExternalEdit}
          onReloadExternalEdit={handleReloadExternalEdit}
        />
        <EditorPaneViewport
          isPanelVisible={!phoneWorkspace && isPanelVisible}
          sceneMetaPanelWidth={sceneMetaPanelWidth}
          onPanelLayoutChanged={handlePanelLayoutChanged}
          contentAreaProps={editorContentAreaProps}
          sceneId={nodeId}
          editor={editor}
          setMentionPopup={setMentionPopupState}
          beatDragDrop={beatDragDrop}
        />
        <EditorPaneStatusBar
          activeStatus={activeStatus}
          editor={editor}
          getStatsSceneId={getStatsSceneId}
          isEntryMode={isEntryMode}
          isSceneContentLoading={isSceneContentLoading}
          showAttribution={showAttribution}
          aiRatio={aiRatio}
          isSaving={isSaving}
          isDirty={isDirty}
          onStatusChange={handleStatusChange}
          onOpenAttribution={() => togglePanel("attribution")}
          onOpenRevisionHistory={handleOpenRevisionHistory}
        />
        <EditorPaneOverlays
          editor={editor}
          paletteOpen={paletteOpen}
          palettePreselect={palettePreselect}
          onClosePalette={() => setPaletteOpen(false)}
          onSubmitPalette={handlePaletteSubmit}
          onSubmitPaletteAb={handlePaletteSubmitAb}
          abInline={abInline}
          onCloseAb={() => setAbInline(null)}
          onAdoptAb={handleAdoptAb}
          onAccept={acceptWithStaging}
          onReject={rejectWithStaging}
          onRetry={retry}
          anchorRef={editorContainerRef}
          isInlineAiOwner={isInlineAiOwner}
          mentionPopup={mentionPopup}
          mentionIndex={mentionIndex}
          onMentionSelect={handleMentionSelect}
          onMentionIndexChange={setMentionIndex}
          onMentionSelectWithRole={handleMentionSelectWithRole}
          paragraphReorder={{
            open: paragraphReorder.open,
            units: paragraphReorder.units,
            order: paragraphReorder.order,
            onOrderChange: paragraphReorder.setOrder,
            granularity: paragraphReorder.granularity,
            onGranularityChange: paragraphReorder.setGranularity,
            loading: paragraphReorder.loading,
            errorMessage: paragraphReorder.errorMessage,
            canConfirm: paragraphReorder.canConfirm,
            onConfirm: paragraphReorder.confirm,
            onCancel: paragraphReorder.closeOverlay,
          }}
          bunsetsuAvailable={bunsetsuAvailable}
          phraseAvailable={phraseAvailable}
          wordAvailable={wordAvailable}
        />
      </div>
      <PhoneSceneMetaSheet
        phoneWorkspace={phoneWorkspace}
        open={isPanelVisible}
        title={t("editor.toolbar.sceneMetaPanel")}
        closeLabel={t("common.close")}
        onClose={() => setPhoneMetaPanelOpen(false)}
        closeButtonRef={phoneMetaCloseRef}
      >
        <SceneMetaPanel
          sceneId={nodeId}
          editor={editor}
          setMentionPopup={setMentionPopupState}
          embeddedInPhoneSheet
        />
      </PhoneSceneMetaSheet>
    </div>
  );
  recordMark("editorPane.render", performance.now() - __perfStart, __perfStart);
  return __renderResult;
}
