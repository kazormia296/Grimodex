import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Clock, BookOpen, Files, CalendarDays } from "lucide-react";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import { useEditor } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { resetEditorHistory } from "@/features/editor/editorDocumentLoad";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { FileBackedSceneBanner } from "@/features/external-mount/components/FileBackedSceneBanner";
import { NoteContextControls } from "@/features/editor/NoteContextControls";
import { Toolbar } from "@/features/editor/Toolbar";
import type { ToolbarActions } from "@/features/editor/Toolbar";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneFull, savePlacedBeatPreviewOnly } from "@/features/tree/api";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import { EditorStatsFooter } from "@/features/editor/EditorStatsFooter";
import {
  extractPlacedBeatPreview,
  extractPlacedBeatPreviewFromDoc,
} from "@/features/editor/beat/placedBeatPreview";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { getCodexEntry } from "@/features/codex/api";
import { getEvent } from "@/features/chronicle/api";
import { uiUpdateEvent } from "@/features/agent-writes/event";
import type {
  CodexMentionPopupState,
  MentionItem,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import { MentionPopup } from "@/features/chat/components/MentionPopup";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { buildInlineAiContext } from "@/features/editor/inlineAi/inlineAiContext";
import { getSnippet } from "@/features/snippets/api";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { ExternalEditConflictBanner } from "@/features/editor/ExternalEditConflictBanner";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useAutoSave, AlreadyNotifiedSaveError } from "@/hooks/useAutoSave";
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
import { AttributionLegend } from "@/features/attribution/AttributionLegend";
import { ReorderModeHint } from "@/features/editor/reorder/ReorderModeHint";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useImeDiagnostics } from "@/features/editor/useImeDiagnostics";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import { useTateChuYoko } from "@/features/editor/useTateChuYoko";
import { useEmphasisDotsFallback } from "@/features/editor/useEmphasisDotsFallback";
import { createWebKitFocusScrollGuard } from "@/features/editor/webkitFocusScrollGuard";
import { useShowInvisibles } from "@/features/editor/useShowInvisibles";
import { useEditorViewReady } from "@/features/editor/useEditorViewReady";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import {
  loadForeshadowAnchors,
  clearAllForeshadowMarks,
} from "@/features/foreshadow/saveAnchors";
import { listAnnotationsForScene } from "@/features/post-effect/api";
import {
  clampMarkRange,
  resolveAnchorLoads,
} from "@/features/editor/anchorLoads";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
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
import { InlineAIPalette } from "@/features/editor/inlineAi/InlineAIPalette";
import {
  buildSystemPrompt as buildInlineSystemPrompt,
  buildUserPrompt as buildInlineUserPrompt,
} from "@/features/editor/inlineAi/inlineAiApi";
import { AbInlineDialog } from "@/features/ab-test/AbInlineDialog";
import type { AbMessage } from "@/features/ab-test/abHarness";
import { InlineAIToolbar } from "@/features/editor/inlineAi/InlineAIToolbar";
import { SlashCommandPopup } from "@/features/editor/inlineAi/SlashCommandPopup";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { useTabStore } from "@/features/editor/tabStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
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
import { StatusBarIndicator } from "@/features/lint/StatusBarIndicator";
import { AiPolicyBadge } from "@/features/ai-policy/AiPolicyBadge";
import { LicenseBadge } from "@/features/license/LicenseBadge";
import { LicenseRestrictionBanner } from "@/features/license/LicenseRestrictionBanner";
import { useForeshadowNavStore } from "@/features/foreshadow/foreshadowNavStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { findChunkInDoc } from "@/features/semantic-search/findChunkInDoc";
import { toast } from "sonner";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import { markStart, markEnd, recordMark } from "@/lib/perfLog";
import i18next from "i18next";
import type { SceneStatus } from "@/features/tree/treeStore";
import type { GroupIndex, TabContentType } from "@/features/editor/tabStore";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { EditorContentArea } from "@/features/editor/EditorContentArea";
import { useParagraphReorderOverlay } from "@/features/editor/reorder/useParagraphReorderOverlay";
import { ReorderOverlay } from "@/features/editor/reorder/ReorderOverlay";
import { useBeatDragDrop } from "@/features/editor/useBeatDragDrop";
import { useEditorKeyboard } from "@/features/editor/useEditorKeyboard";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import type { TrashOrigin } from "@/features/trash-bin/types";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

function getStatusLabels(): Record<SceneStatus, string> {
  return {
    outline: i18next.t("editor.status.outline"),
    draft: i18next.t("editor.status.draft"),
    complete: i18next.t("editor.status.complete"),
    revision: i18next.t("editor.status.revision"),
    final: i18next.t("editor.status.final"),
  };
}

const STATUS_COLORS: Record<SceneStatus, string> = {
  outline: "text-muted-foreground",
  draft: "text-yellow-500",
  complete: "text-green-500",
  revision: "text-purple-400",
  final: "text-blue-400",
};

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
  // WebKitGTK の focus 時 selection 先頭リセット → scrollToSelection ジャンプの
  // 抑止ガード（editorProps.handleScrollToSelection と onFocus で使う）。
  const focusScrollGuardRef = useRef(createWebKitFocusScrollGuard());
  // count 系 state (charCount/beat) は EditorStatsFooter に分離済み。本体に
  // 置くとタイピング休止ごとの stat 更新で 2200 行ペイン全体が再レンダー
  // されるため、footer が editor の update イベントを自前購読して再計算する。
  const externalReloadNonce = useExternalWriteStore(
    (s) => s.reloadNonce[nodeId] ?? 0,
  );
  const [isDirty, setIsDirty] = useState(false);
  const [isSceneContentLoading, setIsSceneContentLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const statusPopoverRef = useRef<HTMLDivElement>(null);
  const statusBadgeRef = useRef<HTMLButtonElement>(null);

  const activeNode = useTreeStore((s) =>
    isEntryMode ? null : s.nodes.find((n) => n.id === nodeId),
  );
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
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateCodexEntryStore = useCodexStore((s) => s.update);
  const updateSnippetEntryStore = useSnippetStore((s) => s.update);
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;
  const focusedAnnotationId = useAnnotationStore((s) => s.focusedAnnotationId);

  const paneRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);

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
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePreselect, setPalettePreselect] =
    useState<InlineAiCommand | null>(null);
  // A/B 比較 (③): インライン AI を 2 構成で並列生成して見比べるモーダル。
  const [abInline, setAbInline] = useState<{
    messages: AbMessage[];
    mode: "insert" | "replace";
    originalRange: { from: number; to: number } | null;
    insertPos: number | null;
    projectId: string;
  } | null>(null);
  const [mentionPopup, setMentionPopupState] =
    useState<CodexMentionPopupState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // isDirty の同期ミラー。React state (isDirty) の tabStore への同期は
  // レンダー後 effect まで遅れるため、外部 flush (saveScene) の dirty ゲート
  // (dirtyGatedSaveHandler) は打鍵と同じ tick で更新されるこの ref を正とする。
  // 更新は setIsDirtyRef 経由に一本化してあり、両者は乖離しない。
  const isDirtyRef = useRef(false);
  // 編集世代カウンタ: dirty を立てる (=編集イベント) たびに ++。saveFn は
  // save 開始時の世代を記録し、「同世代のときのみ」dirty をクリアする。
  // coreSave の await 中に入った編集の dirty=true を無条件クリアでクロバー
  // すると、外部 flush の dirty ゲートが clean 誤判定 → headless 適用
  // (autoApplyProse) の resync が未保存編集を上書き消失させるため。
  const editGenerationRef = useRef(0);
  const setIsDirtyRef = useRef<(dirty: boolean) => void>(() => {});
  setIsDirtyRef.current = (dirty: boolean) => {
    if (dirty) editGenerationRef.current += 1;
    isDirtyRef.current = dirty;
    setIsDirty(dirty);
  };

  const saveSceneIdRef = useRef(nodeId);
  // EditorStatsFooter が tree 同期時に fire 時点のロード済み id を読むための
  // stable getter（inline arrow だと footer の購読が毎レンダー再構築される）。
  const getStatsSceneId = useCallback(() => saveSceneIdRef.current, []);
  // Tracks the contentType of whatever doc is currently loaded into the editor.
  // Updated atomically with `saveSceneIdRef` inside switchScene so that
  // pending autosave flushes route to the same backend the in-editor content
  // belongs to — even when the prop has already flipped to a new tab's type.
  // Reading from the prop directly would misroute scene A's pending edits to
  // codex/snippet on tab switch within the autosave window.
  const saveContentTypeRef = useRef<TabContentType>(contentType);
  // Codex mode: non-null when the loaded content came from a phase contentOverride → save back to that phase
  const activePhaseIdRef = useRef<string | null>(null);
  // Reactive version of activePhaseIdRef for display purposes
  const [loadedPhaseId, setLoadedPhaseId] = useState<string | null>(null);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  // Prevent feedback loop when applying external content sync.
  const isApplyingExternalUpdate = useRef(false);

  // 「ロードに成功した本物の doc」以外は保存禁止 — 空/欠損 doc の autosave が
  // DB (file-backed なら writeBack でファイル) を上書きする本文消失の最終防衛線。
  // **初期値は true**: mount 直後のエディタは content:"" の空 doc であり、
  // switchScene 冒頭の flush() はロードより前に走る。ここが false だと、
  // ロード前の窓で何かが autosave を arm しただけで空 doc が DB に保存される
  // (実際に起きた「リニアモード解除で本文全消失」の正体)。
  // switchScene 開始でも悲観的に true、コンテンツ適用成功時のみ false。
  const loadFailedRef = useRef(true);

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

  const coreSave = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    if (loadFailedRef.current) {
      debugLog.warn(
        "EditorPane",
        `save skipped: load failed ${id.slice(0, 8)}`,
      );
      return;
    }
    markStart("editor.coreSave");
    // Branch on the ref, not the closure-captured prop, so a pending autosave
    // flush always saves to the backend matching the doc currently in the
    // editor — even mid-tab-switch when the prop has already flipped.
    const ctx = saveContentTypeRef.current;
    if (ctx === "codex") {
      const content = JSON.stringify(ed.getJSON());
      const phaseId = activePhaseIdRef.current;
      if (phaseId) {
        await usePhaseStore
          .getState()
          .updatePhase(phaseId, { contentOverride: content });
      } else {
        // updateText goes through codexStore so the in-memory entries[] is
        // refreshed too — otherwise the Codex panel keeps the pre-edit doc
        // and reverts visually on entry-navigation until a filter / reload
        // pulls fresh data from DB.
        await useCodexStore.getState().updateText(id, { content });
      }
    } else if (ctx === "snippet") {
      const content = ed.getHTML();
      // updateSnippet 直呼び + store.update の二重 DB 書き込みを store 経由の
      // 1 回に集約 (entries 反映 / timelapse 記録 / undo 履歴も store が担う)。
      // 二重のままだと store 側の OCC (baseVersion) が直呼びの更新と自己衝突する。
      //
      // store.update は false の全経路 (OCC 衝突 / 行なし=削除済み / 失敗)
      // をユーザ通知 (conflict handler / toast) 済みの上で返す契約 (snippetStore
      // 参照)。ここで throw に変換して saveFn へ伝播させ、setIsDirty(false) を
      // 走らせない — 旧・直呼び (throw) と同じく「保存されていないのに clean
      // 表示」で編集が失われるのを防ぐ。通知済みなので AlreadyNotifiedSaveError:
      // useAutoSave の catch は autoSave.failed トーストを重ねない (二重防止)。
      const saved = await useSnippetStore.getState().update(id, { content });
      if (!saved) {
        throw new AlreadyNotifiedSaveError(
          `snippet save not persisted (version conflict or update failure): ${id}`,
        );
      }
    } else if (ctx === "chronicle_event") {
      // 出来事の詳細（ProseMirror JSON）。インスペクタと同じ tracked-write 経路
      // （uiUpdateEvent）で保存し、undo/redo・鮮度カウンタを一貫させる。
      const content = JSON.stringify(ed.getJSON());
      await uiUpdateEvent({ eventId: id, detail: content });
    } else {
      // 本文保存の全副作用カスケードは persistSceneBody が正本。
      // ライブエディタもエージェントの off-screen 自動適用も同じ経路を通す。
      await persistSceneBody(id, ed.state.doc);
    }
    markEnd("editor.coreSave");
  }, []);

  const saveFn = useCallback(async () => {
    if (loadFailedRef.current) {
      // coreSave 側でも skip するが、ここで弾かないと後続の auto-revision が
      // 未ロードの空 doc を getJSON してリビジョン履歴に書き込んでしまう
      // (実機ログで確認: save skipped 直後に空 doc の revision insert)。
      // dirty 解除も「保存していないのに消す」ことになるので丸ごと skip する。
      debugLog.warn(
        "EditorPane",
        `saveFn skipped: load failed ${saveSceneIdRef.current?.slice(0, 8) ?? ""}`,
      );
      return;
    }
    // save 開始時の編集世代 (下の条件付き dirty クリア用)。ここから coreSave の
    // doc 捕捉までは同期区間なので、捕捉に入った編集を取りこぼさない。
    const editGenAtStart = editGenerationRef.current;
    setIsSaving(true);
    try {
      await coreSave();
    } finally {
      setIsSaving(false);
    }
    // coreSave の await 中に編集が入っていた場合 (世代不一致) は dirty を維持
    // する。無条件クリアだと外部 flush の dirty ゲートが clean 誤判定し、
    // headless 適用の resync がその編集を上書き消失させる。
    if (editGenerationRef.current === editGenAtStart) {
      setIsDirtyRef.current(false);
    }

    // Auto-revision is non-critical — don't let it trigger "save failed" toast
    // Codex/snippet tabs don't use the revision system
    if (saveContentTypeRef.current === "scene") {
      try {
        const id = saveSceneIdRef.current;
        const ed = editorRef.current;
        if (!id || !ed) return;
        const intervalMs =
          useSettingsStore.getState().getNumber("revision.autoInterval", 5) *
          60 *
          1000;
        if (shouldAutoRevision(id, intervalMs)) {
          const content = JSON.stringify(ed.getJSON());
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
  }, [coreSave, shouldAutoRevision, recordAutoRevision]);

  // Register this pane's save function so external callers (tab context menu,
  // agent writes, rename cascade, …) can flush it. dirty ゲート付き:
  // clean な editor への外部 flush は no-op (詳細は dirtyGatedSaveHandler)。
  useEffect(() => {
    const handler = dirtyGatedSaveHandler(() => isDirtyRef.current, saveFn);
    registerSaveHandler(nodeId, handler);
    return () => unregisterSaveHandler(nodeId, handler);
  }, [nodeId, saveFn]);

  // Sync isDirty to the tab store for unsaved-changes detection
  useEffect(() => {
    useTabStore.getState().setTabDirty(nodeId, isDirty);
    return () => useTabStore.getState().setTabDirty(nodeId, false);
  }, [nodeId, isDirty]);

  const editorSettings = useEditorSettings();
  const { schedule, cancel, flush } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

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
  const isFileBacked = isFileBackedNode(activeNode?.sourceUri);

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
        // WebKitGTK: focus 時の DOM selection 先頭リセットに対する PM の
        // scrollToSelection が「先頭へスクロール」ジャンプになるのを抑止
        // （詳細は webkitFocusScrollGuard.ts）。
        handleScrollToSelection(view) {
          return focusScrollGuardRef.current.handleScrollToSelection(view);
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
        handleKeyDown(_view, event) {
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
        if (isApplyingExternalUpdate.current) return;
        // TipTap は setEditable 等の「doc 未変更」イベントでも 'update' を
        // emit する (transaction.steps が空)。これを保存に流すと、未ロードの
        // 空 doc に pending が arm され本文消失の引き金になる (実機で
        // useLicenseEditableSync の mount 同期がこれを踏んでいた)。
        // 実際に doc が変わった transaction だけを保存系に通す。
        if (!transaction.docChanged) return;
        // インライン AI の生成中・diff 表示中はオートセーブを止める。
        // Accept/Reject が呼ばれて idle に戻った時点で reset + dispatch によって
        // 再度 onUpdate が走り、その時に通常の schedule が実行される。
        // owner 判定 (activeEditor === e) なので、分割ビューで別ペインが生成中でも
        // このペインの通常編集は保存される (LinearSceneBlock.onUpdate と同契約)。
        {
          const ai = useInlineAiStore.getState();
          if (ai.status !== "idle" && ai.activeEditor === e) return;
        }
        if (loadFailedRef.current) {
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
          if (hasOtherLiveContentSubscriber(sid)) {
            markStart("editor.setLiveContent");
            useSceneContentStore
              .getState()
              .setLiveContent(sid, e.getJSON(), groupIndex);
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
        if (sid && !isApplyingExternalUpdate.current && !isChronicleEventMode) {
          try {
            const steps = transaction.steps.map((s) => s.toJSON());
            const domain = isCodexMode
              ? "codex"
              : isSnippetMode
                ? "snippet"
                : "editor";
            const entityType = isCodexMode
              ? "codex_entry"
              : isSnippetMode
                ? "snippet"
                : "scene";
            recordChangeEvent({
              domain,
              opType: "doc.step",
              sceneId: !isEntryMode ? sid : null,
              entityType,
              entityId: sid,
              payload: { steps },
            });
          } catch (err) {
            // 防御的: capture 失敗で本流の onTransaction を止めない。
            console.warn("[timelapse] editor capture failed", err);
          }
        }
        if (isEntryMode) return;
        if (!sid) return;
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
        focusScrollGuardRef.current.noteFocus();
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
    if (!editor || !lintSceneId) return;
    const unsubscribe = useForeshadowNavStore.subscribe((state, prev) => {
      const jump = state.pendingJump;
      if (!jump || jump === prev.pendingJump) return;
      if (jump.sceneId !== lintSceneId) return;
      // シーンが未ロードの間は無視（switchScene が後で消費する）。
      if (prevSceneIdRef.current !== lintSceneId) return;
      const consumed = useForeshadowNavStore
        .getState()
        .consumeJump(lintSceneId);
      if (!consumed) return;
      // saved cursor の遅延復元が残っているとフォーカス時に上書きされるためクリア。
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
    });
    return unsubscribe;
  }, [editor, lintSceneId]);

  // 同シーン内のセマンティック検索結果ジャンプ要求を処理する (Step 9 TODO)。
  // 構造は foreshadow と同じ。chunk_text を findChunkInDoc で PM position に
  // 変換して setTextSelection + scrollIntoView。
  useEffect(() => {
    if (!editor || !lintSceneId) return;
    const unsubscribe = useSemanticNavStore.subscribe((state, prev) => {
      const jump = state.pendingJump;
      if (!jump || jump === prev.pendingJump) return;
      if (jump.sceneId !== lintSceneId) return;
      if (prevSceneIdRef.current !== lintSceneId) return;
      const consumed = useSemanticNavStore.getState().consumeJump(lintSceneId);
      if (!consumed) return;
      pendingCursorRestoreRef.current = null;
      const range = findChunkInDoc(editor.state.doc, consumed.chunkText);
      if (!range) {
        // 一致無しならスクロールだけ (シーン先頭に戻すのは過剰なのでフォーカスのみ)。
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
    });
    return unsubscribe;
  }, [editor, lintSceneId]);

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
    if (loadFailedRef.current) return;
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    const content = JSON.stringify(ed.getJSON());
    await createRevision({
      entityType: "scene",
      entityId: id,
      content,
      snapshotType: "manual",
    });
  }, [flush, isEntryMode]);

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

  // Close status popover on outside click
  useEffect(() => {
    if (!statusPopoverOpen) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !statusBadgeRef.current?.contains(target) &&
        !statusPopoverRef.current?.contains(target)
      )
        setStatusPopoverOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [statusPopoverOpen]);

  const activeGroupIndex = useTabStore((s) => s.activeGroupIndex);
  const isActiveGroup = groupIndex === activeGroupIndex;

  useInsertHighlight(editor);
  useGhostPreview(editor);
  useCodexHighlight(
    editor,
    // Snippet / Chronicle-event は補助コンテンツなので Codex ハイライトは見せるが
    // matchedEntryIds（シーン単位の CodexQuick が参照するグローバル集合）は更新しない。
    isSnippetMode || isChronicleEventMode
      ? { skipMatchedIds: true }
      : isCodexMode
        ? { excludeEntryIds: [nodeId], skipMatchedIds: !isActiveGroup }
        : !isActiveGroup
          ? { skipMatchedIds: true }
          : undefined,
  );
  useFocusMode(editor);
  const typewriterMode = useCursorSettingsStore((s) => s.typewriterMode);
  const focusMode = useCursorSettingsStore((s) => s.focusMode);
  const showForeshadowMarks = useCursorSettingsStore(
    (s) => s.showForeshadowMarks,
  );
  // ガター生成レイヤーのON数から本文 inline-start の予約幅を算出する
  // （オーバーレイ表示中はアイコンが必ず見えるよう領域を確保する）。
  const showCommentsLayer = useCursorSettingsStore((s) => s.showComments);
  const showLintLayer = useCursorSettingsStore((s) => s.showLint);
  const showAnnotationsLayer = useAnnotationStore((s) => s.showAnnotations);
  const showReaderCommentsLayer = useAnnotationStore(
    (s) => s.showReaderComments,
  );
  const gutterReserve = gutterReserveInlineSize(
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
  // フォーカスモードでも詳細ペインは隠さない（本文の減光は FocusModePlugin 側）
  const isPanelVisible = sceneMetaPanelOpen && !isEntryMode;
  const handleTogglePanel = useCallback(() => {
    useSettingsStore
      .getState()
      .set("editor.sceneMetaPanelOpen", String(!sceneMetaPanelOpen));
  }, [sceneMetaPanelOpen]);
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
  const inlineAiDiff = useInlineAiDiff(dbNativeEditor);
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

  useCursorOverlay(mountedEditor);
  useImeDiagnostics(mountedEditor);
  useCharacterFade(mountedEditor);
  useTateChuYoko(mountedEditor);
  useEmphasisDotsFallback(mountedEditor);
  useShowInvisibles(mountedEditor);
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
    if (!editor) return;
    return subscribeLiveContentRafCoalesced(nodeId, groupIndex, (next) => {
      isApplyingExternalUpdate.current = true;
      try {
        markStart("editor.externalSync.setContent");
        editor.commands.setContent(
          next as Parameters<typeof editor.commands.setContent>[0],
          { emitUpdate: false },
        );
        markEnd("editor.externalSync.setContent");
      } finally {
        isApplyingExternalUpdate.current = false;
      }
    });
  }, [nodeId, groupIndex, editor]);

  // Subscribe to unplaced beats changes → mark dirty and schedule save,
  // and live-sync the Grid preview cache for immediate UI feedback.
  useEffect(() => {
    if (!nodeId || isEntryMode) return;
    const unsubscribe = useUnplacedBeatsStore
      .getState()
      .subscribe(nodeId, () => {
        if (loadFailedRef.current) {
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
  }, [nodeId, isEntryMode, schedule]);

  // Load content when nodeId changes
  useEffect(() => {
    if (!editor || !nodeId) return;

    let cancelled = false;
    setIsSceneContentLoading(true);

    async function switchScene() {
      markStart("editor.switchScene");
      try {
        const prevId = prevSceneIdRef.current;
        if (prevId && prevId !== nodeId) {
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
        // Update *after* flush() above so the flush still routes scene A's
        // pending edits to the scene backend, even though the prop has already
        // flipped to the new tab's contentType.
        saveContentTypeRef.current = contentType;
        // ここから新コンテンツの適用が成功するまで、エディタ内の doc は
        // 保存禁止 (coreSave が skip)。途中失敗した doc を autosave が
        // 書き戻すと本文消失になるため。
        loadFailedRef.current = true;

        // Hold the external-update guard for the entire scene-switch sequence
        // (setContent + authorship load + foreshadow load). Releasing it earlier
        // lets a fast typist trigger autosave while marks are mid-load, which
        // would persist a doc with no setup marks and orphan every setup row.
        isApplyingExternalUpdate.current = true;
        try {
          if (isCodexMode) {
            // Load codex entry content (ProseMirror JSON)
            const entry = await getCodexEntry(getCurrentProjectId(), nodeId);
            if (cancelled) return;

            // Load phases into store so TabBar and banner can display the phase label
            await usePhaseStore.getState().loadPhasesForEntry(nodeId);
            if (cancelled) return;

            const phaseStore = usePhaseStore.getState();
            const phases = phaseStore.phasesByEntry[nodeId] ?? [];
            const globalSceneOrder = phaseStore.globalSceneOrder;
            let phaseContentOverride: string | null = null;
            let resolvedPhaseId: string | null = null;

            if (overridePhaseId === "__base__") {
              // Explicit base: skip phase resolution, show entry.content as-is
            } else if (overridePhaseId) {
              // Explicit phase ID from preview: load that phase's contentOverride
              const targetPhase = phases.find((p) => p.id === overridePhaseId);
              if (targetPhase?.contentOverride != null) {
                phaseContentOverride = targetPhase.contentOverride;
                resolvedPhaseId = targetPhase.id;
              }
            } else {
              // Auto-resolve: use the phase active at the current scene
              const activeSceneId = useTreeStore.getState().activeSceneId;
              if (activeSceneId) {
                const currentOrder = globalSceneOrder.get(activeSceneId);
                if (currentOrder !== undefined) {
                  const applicable = phases
                    .filter(
                      (p) =>
                        p.anchorNodeId != null &&
                        globalSceneOrder.has(p.anchorNodeId) &&
                        globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder,
                    )
                    .sort(
                      (a, b) =>
                        globalSceneOrder.get(a.anchorNodeId!)! -
                        globalSceneOrder.get(b.anchorNodeId!)!,
                    );
                  const activePhase = applicable[applicable.length - 1] ?? null;
                  if (activePhase?.contentOverride != null) {
                    phaseContentOverride = activePhase.contentOverride;
                    resolvedPhaseId = activePhase.id;
                  }
                }
              }
            }
            activePhaseIdRef.current = resolvedPhaseId;
            setLoadedPhaseId(resolvedPhaseId);

            const rawContent = phaseContentOverride ?? entry?.content ?? null;
            markStart("sceneLoad.parseContent.codex");
            const parsed =
              rawContent && rawContent !== "{}" ? JSON.parse(rawContent) : "";
            markEnd("sceneLoad.parseContent.codex");
            markStart("sceneLoad.setContent.codex");
            editor!.commands.setContent(parsed, {
              emitUpdate: false,
              errorOnInvalidContent: true,
            });
            markEnd("sceneLoad.setContent.codex");
          } else if (isSnippetMode) {
            const snippet = await getSnippet(getCurrentProjectId(), nodeId);
            if (cancelled) return;
            markStart("sceneLoad.setContent.snippet");
            editor!.commands.setContent(tiptapContentFromDb(snippet?.content), {
              emitUpdate: false,
            });
            markEnd("sceneLoad.setContent.snippet");
          } else if (isChronicleEventMode) {
            // 出来事の詳細（ProseMirror JSON）をロード。タイトルはリボン表示用。
            const ev = await getEvent(getCurrentProjectId(), nodeId);
            if (cancelled) return;
            setChronicleEventTitle(ev?.title ?? "");
            markStart("sceneLoad.setContent.chronicle");
            editor!.commands.setContent(tiptapContentFromDb(ev?.detail), {
              emitUpdate: false,
            });
            markEnd("sceneLoad.setContent.chronicle");
          } else {
            // Load scene/note content + unplaced beats in one query
            markStart("sceneLoad.loadSceneFull");
            const { content, unplacedBeatsDoc } = await loadSceneFull(nodeId);
            markEnd("sceneLoad.loadSceneFull");
            if (cancelled) return;
            markStart(`sceneLoad.parseContent.scene.${content?.length ?? 0}`);
            const parsed =
              content && content !== "{}" ? JSON.parse(content) : "";
            markEnd(`sceneLoad.parseContent.scene.${content?.length ?? 0}`);
            markStart(`sceneLoad.setContent.scene.${content?.length ?? 0}`);
            // errorOnInvalidContent: スキーマ未知ノードを TipTap の silent
            // fallback (空 doc 化) に流さず throw → 下の catch で保存停止。
            editor!.commands.setContent(parsed, {
              emitUpdate: false,
              errorOnInvalidContent: true,
            });
            markEnd(`sceneLoad.setContent.scene.${content?.length ?? 0}`);
            debugLog.info(
              "EditorPane",
              `load ${nodeId.slice(0, 8)}`,
              JSON.stringify({
                dbLen: content?.length ?? 0,
                docLen: getDocText(editor!.state.doc).length,
                fileBacked: isFileBacked,
              }),
            );
            try {
              const beats = JSON.parse(unplacedBeatsDoc);
              useUnplacedBeatsStore.getState().setBeats(nodeId, beats, "load");
            } catch {
              useUnplacedBeatsStore.getState().setBeats(nodeId, [], "load");
            }

            // Lazy backfill of placed_beat_preview for legacy scenes that have
            // placed sceneBeat nodes but no cached preview yet.
            const curPreview = useTreeStore.getState().nodePreviews[nodeId];
            if (curPreview?.placed == null) {
              const preview = extractPlacedBeatPreview(editor!.getJSON());
              if (preview !== "[]") {
                const next = preview;
                savePlacedBeatPreviewOnly(nodeId, next).catch(() => {});
                useTreeStore
                  .getState()
                  .setNodePreview(nodeId, { placed: next });
              }
            }
          }

          // 3 ブランチとも setContent 成功 = エディタ内 doc はロード済み本物。
          // ここで初めて保存を解禁する。
          loadFailedRef.current = false;

          if (!cancelled) {
            setIsSceneContentLoading(false);
          }

          // 表示用の count 系は EditorStatsFooter が isLoading の false 遷移で
          // 再計算・tree 同期する。ここでは auto-draft 判定用の空判定だけ行う。
          const count = getDocText(editor!.state.doc).length;
          setIsDirtyRef.current(false);
          wasEmptyRef.current = count === 0;

          if (!isEntryMode) {
            // 帰属/伏線/疑似コメントは互いにデータ依存の無い独立リード。直列 await
            // だと各 IPC 往復 + drizzle warmed microtask(~150ms/件)が積み上がるので
            // 並列化して往復レイテンシを重ねる（所見#4）。SQLite 実行自体は単一
            // Mutex で直列化されるが、往復 + await microtask は隠せる。allSettled で
            // 1 つの失敗が他のマーク適用を巻き込まないようにする(部分適用維持)。
            markStart("sceneLoad.loadAnchors.parallel");
            const [spansR, foreshadowR, annotationR] = await Promise.allSettled(
              [
                loadAuthorshipSpans(nodeId),
                loadForeshadowAnchors(nodeId),
                listAnnotationsForScene({
                  projectId: useTreeStore.getState().projectId,
                  sceneId: nodeId,
                }),
              ],
            );
            markEnd("sceneLoad.loadAnchors.parallel");

            // 結果解決(fulfilled→value / rejected→欠落値) と rejected の収集は
            // resolveAnchorLoads(純関数) に切り出し。dispatch / clamp / store 書き込み
            // / !cancelled ガードは下のとおり当コンポーネントに残す(部分適用維持)。
            const { spans, foreshadowMarks, annotations, errors } =
              resolveAnchorLoads(spansR, foreshadowR, annotationR);

            // allSettled で 1 件の失敗は部分適用に留めるが、無音だと
            // マーク欠落の原因が追えない。rejected は最低限ログに残す
            // (旧直列 await は throw→unhandledrejection で console に出ていた)。
            for (const { label, reason } of errors) {
              debugLog.error(
                "EditorPane",
                `sceneLoad.loadAnchors:${label} failed`,
                errorDetail(reason),
              );
            }

            if (!cancelled) {
              const markData = spans.length > 0 ? spansToMarkData(spans) : [];
              const authorshipType = editor!.schema.marks["authorship"];
              const willApplyAuthorship =
                markData.length > 0 && !!authorshipType;
              const willApplyForeshadow =
                foreshadowMarks.length > 0 && !!editor;

              // 帰属マークと伏線マークは別 mark type・別 range で互いに干渉しない。
              // 1 本の chain にまとめて view.dispatch を 2→1 に減らす(AnnotationPlugin
              // の余分な full-doc walk も 1 回削減)。
              if (willApplyAuthorship || willApplyForeshadow) {
                markStart(
                  `sceneLoad.applyAnchorMarks.${markData.length}+${foreshadowMarks.length}`,
                );
                editor!
                  .chain()
                  .command(({ tr }) => {
                    tr.setMeta("programmaticInsert", true);
                    if (willApplyAuthorship) {
                      for (const { from, to, attrs } of markData) {
                        const r = clampMarkRange(from, to, tr.doc.content.size);
                        if (r) {
                          tr.addMark(
                            r.from,
                            r.to,
                            authorshipType!.create(attrs),
                          );
                        }
                      }
                    }
                    if (willApplyForeshadow) {
                      clearAllForeshadowMarks((fn) => fn(tr));
                      const schema = tr.doc.type.schema;
                      for (const {
                        from,
                        to,
                        markName,
                        attrs,
                      } of foreshadowMarks) {
                        const markType = schema.marks[markName];
                        if (!markType) continue;
                        const r = clampMarkRange(from, to, tr.doc.content.size);
                        if (r) tr.addMark(r.from, r.to, markType.create(attrs));
                      }
                    }
                    return true;
                  })
                  .run();
                markEnd(
                  `sceneLoad.applyAnchorMarks.${markData.length}+${foreshadowMarks.length}`,
                );
              }
            }

            // Load and apply post-effect annotation anchors。store 書き込みは元
            // コードどおり無条件、editor へのマーク適用のみ !cancelled でガードする。
            // annotations は resolveAnchorLoads が fulfilled 時に response object、
            // rejected 時に null を返すので、旧 annotationR.status==="fulfilled" と等価。
            if (annotations) {
              const annotationResp = annotations;
              useAnnotationStore.getState().setFocusedAnnotationId(null);
              useAnnotationStore
                .getState()
                .setAnnotations(nodeId, annotationResp.annotations);
              if (!cancelled && editor) {
                applyAnnotationsToEditor(editor, annotationResp.annotations);
              }
            }
          }
        } finally {
          isApplyingExternalUpdate.current = false;
        }

        // シーン/Codex ロード完了後: 使い回しエディタの undo スタックを空にする。
        // 残すと Ctrl+Z が前シーンの doc スナップショットを復元して本文が消える。
        if (!cancelled && !loadFailedRef.current && editor) {
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
        const focusNow = useTabStore
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
          }
        }
      } catch (err) {
        if (!cancelled) {
          setIsSceneContentLoading(false);
          // loadFailedRef は true のまま = この doc は保存されない。無言で
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
    overridePhaseId,
    groupIndex,
    externalReloadNonce,
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
        editorRef.current.commands.setContent(parsed, { emitUpdate: false });
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
  }, [nodeId]);

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
    if (trimmed && trimmed !== editorTitle) {
      if (isCodexMode) {
        updateCodexEntryStore(nodeId, { name: trimmed }).catch(() => {});
      } else if (isSnippetMode) {
        updateSnippetEntryStore(nodeId, { title: trimmed }).catch(() => {});
      } else if (isChronicleEventMode) {
        setChronicleEventTitle(trimmed);
        uiUpdateEvent({ eventId: nodeId, title: trimmed }).catch(() => {});
      } else {
        updateNodeTitle(nodeId, trimmed).catch(() => {});
      }
    }
    setTitleEditing(false);
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

  const __renderResult = (
    <div
      ref={setPaneRef}
      data-droptarget-id={editorDropId}
      className="flex flex-1 flex-col overflow-hidden data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
    >
      <Toolbar
        editor={editor}
        onFindReplace={() => {
          setFindOpen(true);
          setFindShowReplace(true);
        }}
        actionsRef={toolbarActionsRef}
        panelOpen={sceneMetaPanelOpen}
        onTogglePanel={handleTogglePanel}
        sceneId={isEntryMode ? undefined : nodeId}
        nodeType={activeNode?.nodeType}
        reorderOpen={paragraphReorder.open}
        onToggleReorder={
          dbNativeEditor ? paragraphReorder.toggleOverlay : undefined
        }
        reorderDisabled={!dbNativeEditor || readOnly}
      />
      <LicenseRestrictionBanner />
      {isFileBacked && !isEntryMode && <FileBackedSceneBanner />}
      <ExternalEditConflictBanner nodeId={nodeId} />
      {isNote && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-medium">{t("editor.ribbon.noteEditing")}</span>
          <span className="text-amber-500/60">
            — {t("editor.ribbon.noteDescription")}
          </span>
        </div>
      )}
      {isNote && <NoteContextControls nodeId={nodeId} />}
      {isCodexMode && (
        <div className="flex items-center gap-1.5 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-600 dark:text-purple-400">
          <span className="flex items-center gap-1 font-medium">
            <BookOpen className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.codexEditing")}
          </span>
          {activeCodexEntry && (
            <span className="text-purple-500/60">
              — {activeCodexEntry.name}
            </span>
          )}
          {loadedPhaseLabel && (
            <span className="ml-auto rounded bg-purple-500/20 px-1.5 py-0.5 font-medium">
              {loadedPhaseLabel}
            </span>
          )}
        </div>
      )}
      {isSnippetMode && (
        <div className="flex items-center gap-1.5 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-600 dark:text-emerald-400">
          <span className="flex items-center gap-1 font-medium">
            <Files className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.snippetEditing")}
          </span>
          {activeSnippetEntry && (
            <span className="text-emerald-500/60">
              — {activeSnippetEntry.title}
            </span>
          )}
        </div>
      )}
      {isChronicleEventMode && (
        <div className="flex items-center gap-1.5 border-b border-sky-500/30 bg-sky-500/10 px-3 py-1 text-xs text-sky-600 dark:text-sky-400">
          <span className="flex items-center gap-1 font-medium">
            <CalendarDays className="h-3 w-3" aria-hidden />
            {t("editor.ribbon.chronicleEditing")}
          </span>
          {chronicleEventTitle && (
            <span className="text-sky-500/60">— {chronicleEventTitle}</span>
          )}
        </div>
      )}
      <DndContext
        sensors={beatSensors}
        collisionDetection={beatCollisionDetection}
        onDragStart={handleBeatDragStart}
        onDragEnd={handleBeatDragEnd}
      >
        {isPanelVisible ? (
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            onLayoutChanged={handlePanelLayoutChanged}
          >
            <ResizablePanel
              id="editor-main"
              minSize="40%"
              className="flex flex-col overflow-hidden"
            >
              <EditorContentArea
                editor={editor}
                editorContainerRef={editorContainerRef}
                toolbarActionsRef={toolbarActionsRef}
                findOpen={findOpen}
                findShowReplace={findShowReplace}
                setFindOpen={setFindOpen}
                showForeshadowMarks={showForeshadowMarks}
                gutterReserve={gutterReserve}
                focusModeHideBeats={focusModeHideBeats}
                focusMode={focusMode}
                typewriterMode={effectiveTypewriter}
                filterSource={filterSource}
                editorSettings={editorSettings}
                editorTitle={editorTitle}
                loadedPhaseLabel={loadedPhaseLabel}
                titleEditing={titleEditing}
                titleDraft={titleDraft}
                setTitleDraft={setTitleDraft}
                handleTitleSave={handleTitleSave}
                handleTitleCancel={handleTitleCancel}
                handleTitleEditStart={handleTitleEditStart}
                isSceneContentLoading={isSceneContentLoading}
                sceneId={nodeId}
                onInlineAiCommand={
                  dbNativeEditor ? handleInlineAiCommand : undefined
                }
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="scene-meta"
              minSize="15%"
              maxSize="50%"
              defaultSize={`${sceneMetaPanelWidth}%`}
              className="flex flex-col overflow-hidden"
            >
              <SceneMetaPanel
                sceneId={nodeId}
                editor={editor}
                setMentionPopup={setMentionPopupState}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <EditorContentArea
                editor={editor}
                editorContainerRef={editorContainerRef}
                toolbarActionsRef={toolbarActionsRef}
                findOpen={findOpen}
                findShowReplace={findShowReplace}
                setFindOpen={setFindOpen}
                showForeshadowMarks={showForeshadowMarks}
                gutterReserve={gutterReserve}
                focusModeHideBeats={focusModeHideBeats}
                focusMode={focusMode}
                typewriterMode={effectiveTypewriter}
                filterSource={filterSource}
                editorSettings={editorSettings}
                editorTitle={editorTitle}
                loadedPhaseLabel={loadedPhaseLabel}
                titleEditing={titleEditing}
                titleDraft={titleDraft}
                setTitleDraft={setTitleDraft}
                handleTitleSave={handleTitleSave}
                handleTitleCancel={handleTitleCancel}
                handleTitleEditStart={handleTitleEditStart}
                isSceneContentLoading={isSceneContentLoading}
                sceneId={nodeId}
                onInlineAiCommand={
                  dbNativeEditor ? handleInlineAiCommand : undefined
                }
              />
            </div>
          </div>
        )}
        <DragOverlay dropAnimation={null}>
          {draggingBeat && (
            <div
              className="rounded border border-border bg-popover px-2 py-1 text-xs shadow-md opacity-90 whitespace-nowrap"
              style={{ width: "max-content", maxWidth: "320px" }}
            >
              {draggingBeat.content
                .map((c) => ("text" in c ? String(c.text ?? "") : ""))
                .join("")
                .slice(0, 40) || "Beat"}
            </div>
          )}
        </DragOverlay>
      </DndContext>
      <div className="glass-editor-chrome flex flex-shrink-0 items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {/* Left: status badge */}
        <div className="relative flex min-w-0 items-center gap-2">
          {activeStatus ? (
            <>
              <button
                ref={statusBadgeRef}
                type="button"
                title={i18next.t("editor.status.changeStatus")}
                onClick={() => setStatusPopoverOpen((v) => !v)}
                className={`rounded px-1.5 py-0.5 font-medium hover:bg-accent ${STATUS_COLORS[activeStatus]}`}
              >
                {getStatusLabels()[activeStatus]}
              </button>
              {statusPopoverOpen && (
                <div
                  ref={statusPopoverRef}
                  className="absolute bottom-full left-0 z-50 mb-1 min-w-[120px] rounded border border-border bg-popover py-1 shadow-md"
                >
                  {(
                    Object.entries(getStatusLabels()) as [SceneStatus, string][]
                  ).map(([s, label]) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        useTreeStore
                          .getState()
                          .setStatus(nodeId, s)
                          .catch(() => {});
                        setStatusPopoverOpen(false);
                      }}
                      className={`flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-accent ${s === activeStatus ? "font-medium" : ""} ${STATUS_COLORS[s]}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : null}
          {/* Attribution overlay legend — only while the overlay is on, kept on
             the left away from the purple AI-ratio badge to avoid color clash. */}
          {showAttribution && (
            <AttributionLegend className="text-[10px] text-muted-foreground" />
          )}
          {/* 推敲リオーダー（Alt=段落 / Alt+Shift=文・文節）の操作案内 */}
          <ReorderModeHint className="text-[10px] text-muted-foreground" />
        </div>
        {/* Right: stats + save state + history */}
        <div className="flex flex-shrink-0 items-center gap-3">
          <AiPolicyBadge />
          <LicenseBadge />
          <StatusBarIndicator />
          {showAttribution && aiRatio > 0 && (
            <button
              type="button"
              title={i18next.t("editor.status.openAttribution")}
              onClick={() => togglePanel("attribution")}
              className="tabular-nums text-attribution-ai hover:text-foreground"
            >
              AI: {aiRatio}%
            </button>
          )}
          <EditorStatsFooter
            editor={editor}
            getSyncSceneId={getStatsSceneId}
            syncToTree={!isEntryMode}
            isLoading={isSceneContentLoading}
          />
          {isSaving ? (
            <span className="opacity-50">{t("editor.status.saving")}</span>
          ) : isDirty ? (
            <span className="text-amber-500">{t("editor.status.unsaved")}</span>
          ) : (
            <span className="opacity-40">{t("editor.status.saved")}</span>
          )}
          <button
            type="button"
            title={i18next.t("editor.status.revisionHistory")}
            onClick={() => {
              const id = saveSceneIdRef.current;
              const ed = editorRef.current;
              if (id && ed) {
                const content = JSON.stringify(ed.getJSON());
                useRevisionStore.getState().openHistory("scene", id, content);
              }
            }}
            className="hover:text-foreground"
          >
            <Clock className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {editor && (
        <InlineAIPalette
          editor={editor}
          open={paletteOpen}
          preselectedCommand={palettePreselect}
          onClose={() => setPaletteOpen(false)}
          onSubmit={(command, prompt) => {
            const node = useTreeStore
              .getState()
              .nodes.find((n) => n.id === nodeId);
            const projectTitle =
              useWorkspaceStore.getState().activeWorkspaceName ?? "";
            const matchedCodexIds =
              useCodexHighlightStore.getState().matchedEntryIds;
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
          }}
          onSubmitAb={(command, prompt) => {
            if (!editor) return;
            const node = useTreeStore
              .getState()
              .nodes.find((n) => n.id === nodeId);
            const projectTitle =
              useWorkspaceStore.getState().activeWorkspaceName ?? "";
            const matchedCodexIds =
              useCodexHighlightStore.getState().matchedEntryIds;
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
            const messages: AbMessage[] = [
              {
                role: "system",
                content: buildInlineSystemPrompt(command, context, lang),
              },
              {
                role: "user",
                content: buildInlineUserPrompt(command, context, lang),
              },
            ];
            // 採用後に showProvidedText で diff 挿入できるよう、起動時点の
            // 選択範囲 / 挿入位置を確定して保持する。
            const { from, to } = editor.state.selection;
            const isReplace = command.mode === "replace" && from !== to;
            setAbInline({
              messages,
              mode: isReplace ? "replace" : "insert",
              originalRange: isReplace ? { from, to } : null,
              insertPos: isReplace ? null : from,
              projectId: getCurrentProjectId(),
            });
          }}
        />
      )}
      {abInline && (
        <AbInlineDialog
          open
          onOpenChange={(next) => {
            if (!next) setAbInline(null);
          }}
          projectId={abInline.projectId}
          messages={abInline.messages}
          onAdopt={(text) => {
            showProvidedText(text, {
              mode: abInline.mode,
              originalRange: abInline.originalRange ?? undefined,
              insertPos: abInline.insertPos ?? undefined,
            });
            setAbInline(null);
          }}
        />
      )}
      <InlineAIToolbar
        onAccept={acceptWithStaging}
        onReject={rejectWithStaging}
        onRetry={retry}
        anchorRef={editorContainerRef}
        isOwner={isInlineAiOwner}
      />
      <SlashCommandPopup />
      {mentionPopup &&
        createPortal(
          <MentionPopup
            items={mentionPopup.items}
            selectedIndex={mentionIndex}
            onSelect={handleMentionSelect}
            onChangeIndex={setMentionIndex}
            clientRect={mentionPopup.clientRect}
            onSelectWithRole={handleMentionSelectWithRole}
          />,
          document.body,
        )}
      <ReorderOverlay
        open={paragraphReorder.open}
        units={paragraphReorder.units}
        order={paragraphReorder.order}
        onOrderChange={paragraphReorder.setOrder}
        granularity={paragraphReorder.granularity}
        onGranularityChange={paragraphReorder.setGranularity}
        loading={paragraphReorder.loading}
        errorMessage={paragraphReorder.errorMessage}
        canConfirm={paragraphReorder.canConfirm}
        onConfirm={paragraphReorder.confirm}
        onCancel={paragraphReorder.closeOverlay}
        bunsetsuAvailable={bunsetsuAvailable}
        phraseAvailable={phraseAvailable}
        wordAvailable={wordAvailable}
      />
    </div>
  );
  recordMark("editorPane.render", performance.now() - __perfStart, __perfStart);
  return __renderResult;
}
