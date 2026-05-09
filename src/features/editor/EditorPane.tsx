import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Clock, BookOpen, Files } from "lucide-react";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import {
  countWords,
  manuscriptPages,
  readingMinutes,
} from "@/features/editor/charCountStats";
import { cn } from "@/lib/utils";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { SceneBeatEditorContextProvider } from "@/features/editor/beat/SceneBeatEditorContext";
import { Toolbar } from "@/features/editor/Toolbar";
import type { ToolbarActions } from "@/features/editor/Toolbar";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  loadSceneFull,
  savePlacedBeatPreviewOnly,
  saveSceneContent,
} from "@/features/tree/api";
import { countSceneBodyChars } from "@/features/editor/charCountForBody";
import { countBeats } from "@/features/editor/beat/countBeats";
import {
  extractPlacedBeatPreview,
  extractPlacedBeatPreviewFromDoc,
} from "@/features/editor/beat/placedBeatPreview";
import { extractUnplacedBeatPreview } from "@/features/editor/beat/unplacedBeatPreview";
import { extractBeatMentions } from "@/features/editor/beat/extractBeatMentions";
import { upsertSceneBeatMentions } from "@/features/editor/beat/mentionApi";
import { extractBeatPovOverrides } from "@/features/editor/beat/extractBeatPovOverrides";
import { upsertSceneBeatPovOverrides } from "@/features/editor/beat/beatPovCacheApi";
import { upsertSceneBodyMentions } from "@/features/editor/beat/bodyMentionApi";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { getCodexEntry } from "@/features/codex/api";
import type { CodexEntry } from "@/features/codex/api";
import type {
  CodexMentionPopupState,
  MentionRole,
} from "@/features/codex/CodexMentionExtension";
import { MentionPopup } from "@/features/chat/components/MentionPopup";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { buildInlineAiContext } from "@/features/editor/inlineAi/inlineAiContext";
import { getSnippet, updateSnippet } from "@/features/snippets/api";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useAutoSave } from "@/hooks/useAutoSave";
import { createRevision } from "@/features/revision/api";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { parseClipboardHtml } from "@/lib/clipboardAttribution";
import { useInsertHighlight } from "@/features/editor/InsertHighlight";
import { useGhostPreview } from "@/features/editor/useGhostPreview";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCursorOverlay } from "@/features/editor/useCursorOverlay";
import { useCharacterFade } from "@/features/editor/useCharacterFade";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useSettingNumber } from "@/features/settings/useSettingControl";
import { useCharCountMilestone } from "@/features/editor/useCharCountMilestone";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import {
  saveForeshadowAnchors,
  loadForeshadowAnchors,
  clearAllForeshadowMarks,
} from "@/features/foreshadow/saveAnchors";
import { VerticalPreview } from "@/features/editor/VerticalPreview";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { CommentAddPopover } from "@/features/editor/CommentAddPopover";
import { CommentHoverPopover } from "@/features/editor/CommentHoverPopover";
import { ForeshadowMarkPopover } from "@/features/foreshadow/ForeshadowMarkPopover";
import { ForeshadowMarkHoverPopover } from "@/features/foreshadow/ForeshadowMarkHoverPopover";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { useFocusMode } from "@/features/editor/useFocusMode";
import {
  useTypewriterScroll,
  computeTypewriterScrollTop,
} from "@/features/editor/useTypewriterScroll";
import { useInlineAiDiff } from "@/features/editor/inlineAi/useInlineAiDiff";
import { InlineAIPalette } from "@/features/editor/inlineAi/InlineAIPalette";
import { InlineAIToolbar } from "@/features/editor/inlineAi/InlineAIToolbar";
import { SlashCommandPopup } from "@/features/editor/inlineAi/SlashCommandPopup";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { useTabStore } from "@/features/editor/tabStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
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
import { useForeshadowNavStore } from "@/features/foreshadow/foreshadowNavStore";
import { useChatStore } from "@/features/chat/chatStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { markStart, markEnd } from "@/lib/perfLog";
import i18next from "i18next";
import type { SceneStatus } from "@/features/tree/treeStore";
import type { GroupIndex, TabContentType } from "@/features/editor/tabStore";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { EditorDropDiv } from "@/features/editor/EditorDropDiv";
import { useBeatDragDrop } from "@/features/editor/useBeatDragDrop";
import { useEditorKeyboard } from "@/features/editor/useEditorKeyboard";
import { useTrashBinCapture } from "@/features/editor/useTrashBinCapture";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { useFocusedContentEditorStore } from "@/store/focusedContentEditorStore";
import type { TrashOrigin } from "@/features/trash-bin/types";
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

interface EditorPaneProps {
  nodeId: string;
  contentType: TabContentType;
  groupIndex: GroupIndex;
  onFocus: () => void;
}

/**
 * A single TipTap editor pane.
 * Used as-is for the primary group, and duplicated for the secondary group.
 * When the same nodeId is open in both groups, edits propagate via sceneContentStore.
 * Supports both scene/note content (Markdown via Tauri) and codex entry content (ProseMirror JSON via DB).
 */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export function EditorPane({
  nodeId,
  contentType,
  groupIndex,
  onFocus,
}: EditorPaneProps) {
  const { t } = useTranslation();
  const isCodexMode = contentType === "codex";
  const isSnippetMode = contentType === "snippet";
  const prevSceneIdRef = useRef(nodeId);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  // Per-scene editor state: cursor position + scroll (session-only, no persistence)
  const savedEditorStateRef = useRef<
    Map<string, { from: number; to: number; scrollTop: number }>
  >(new Map());
  // Pending cursor/scroll restore for lazy application on next editor focus.
  // Set when the scene switch was triggered from the Scenes panel (no focus steal).
  // Cleared either when consumed by onFocus or when a new scene starts loading.
  const pendingCursorRestoreRef = useRef<{
    from: number;
    to: number;
    scrollTop: number;
  } | null>(null);
  const [charCount, setCharCount] = useState(0);
  const [, setWordCount] = useState(0);
  const [beatTotal, setBeatTotal] = useState(0);
  const [beatGenerated, setBeatGenerated] = useState(0);
  // Debounce footer stats and tree-store charCount sync. These are display-only
  // and don't need to update on every keystroke; settling 200ms after typing
  // stops avoids a full doc walk + four React re-renders + a store notification
  // (which fans out to every TreeNodeItem leaf selector) per character.
  const statSyncTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (statSyncTimeoutRef.current != null) {
        window.clearTimeout(statSyncTimeoutRef.current);
        statSyncTimeoutRef.current = null;
      }
    };
  }, []);
  const charCountRef = useRef<HTMLSpanElement>(null);
  const { value: targetCharCount } = useSettingNumber(
    "editor.targetCharCount",
    0,
  );
  useCharCountMilestone(charCount, targetCharCount, charCountRef);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const statusPopoverRef = useRef<HTMLDivElement>(null);
  const statusBadgeRef = useRef<HTMLButtonElement>(null);

  const activeNode = useTreeStore((s) =>
    isCodexMode || isSnippetMode ? null : s.nodes.find((n) => n.id === nodeId),
  );
  const activeCodexEntry = useCodexStore((s) =>
    isCodexMode ? s.entries.find((e) => e.id === nodeId) : null,
  );
  const activeSnippetEntry = useSnippetStore((s) =>
    isSnippetMode ? s.entries.find((e) => e.id === nodeId) : null,
  );
  // Codex tabs: which phase's content to display/edit (set via openCodexTab)
  const overridePhaseId = useTabStore((s) => {
    const allTabs = groupIndex === 0 ? s.tabs : s.secondaryTabs;
    return allTabs.find((t) => t.nodeId === nodeId)?.overridePhaseId ?? null;
  });
  // Phases for this codex entry (populated into store during load)
  const codexPhases = usePhaseStore((s) =>
    isCodexMode ? (s.phasesByEntry[nodeId] ?? null) : null,
  );
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const updateCodexEntryStore = useCodexStore((s) => s.update);
  const updateSnippetEntryStore = useSnippetStore((s) => s.update);
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;

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
  const [charCountPopoverOpen, setCharCountPopoverOpen] = useState(false);
  const charCountContainerRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [verticalPreviewOpen, setVerticalPreviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePreselect, setPalettePreselect] =
    useState<InlineAiCommand | null>(null);
  const [mentionPopup, setMentionPopupState] =
    useState<CodexMentionPopupState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const setIsDirtyRef = useRef(setIsDirty);
  setIsDirtyRef.current = setIsDirty;

  const saveSceneIdRef = useRef(nodeId);
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

  // Auto-draft: true when scene was empty at load time
  const wasEmptyRef = useRef(false);

  // Synopsis suggestion: track previous status to detect transitions (scene only)
  const prevStatusRef = useRef<SceneStatus | null>(activeStatus);
  useEffect(() => {
    if (isCodexMode || isSnippetMode) return;
    const prev = prevStatusRef.current;
    prevStatusRef.current = activeStatus;
    const synopsis = useTreeStore
      .getState()
      .nodes.find((n) => n.id === nodeId)?.synopsis;
    if (shouldPromptSynopsis(prev, activeStatus, synopsis)) {
      useSynopsisSuggestionStore.getState().propose(nodeId);
    }
  }, [activeStatus, nodeId, isCodexMode, isSnippetMode]);

  const coreSave = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
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
      await updateSnippet(id, { content });
      useSnippetStore.getState().update(id, { content });
    } else {
      const doc = ed.state.doc;
      markStart("editor.coreSave.countChars");
      const charCount = countSceneBodyChars(doc);
      markEnd("editor.coreSave.countChars");
      const beats = useUnplacedBeatsStore.getState().getBeats(id);
      const unplacedBeatsDoc = JSON.stringify(beats);
      markStart("editor.coreSave.getJSON");
      const sceneJsonStr = JSON.stringify(ed.getJSON());
      markEnd("editor.coreSave.getJSON");
      markStart("editor.coreSave.invokeSave");
      const { placedBeatPreview, unplacedBeatPreview } = await saveSceneContent(
        id,
        {
          content: sceneJsonStr,
          unplacedBeatsDoc,
          charCount,
        },
      );
      markEnd("editor.coreSave.invokeSave");
      // Mirror the derived previews into the tree store so the Grid panel
      // reflects placed/unplaced changes without waiting for the next
      // loadTree (e.g. unplaced→placed via drag&drop).
      // Phase 4: nodes[] ではなく nodePreviews を更新するので、whole-array
      // selector 29 サイトは notify されない (Phase 3 メモ参照)。
      markStart("editor.coreSave.treeMirror");
      useTreeStore.getState().setNodePreview(id, {
        placed: placedBeatPreview ?? null,
        unplaced: unplacedBeatPreview ?? null,
      });
      markEnd("editor.coreSave.treeMirror");
      markStart("editor.coreSave.saveAuthorship");
      await saveAuthorshipSpans(id, ed.state.doc);
      markEnd("editor.coreSave.saveAuthorship");
      markStart("editor.coreSave.saveForeshadow");
      await saveForeshadowAnchors(id, ed.state.doc);
      markEnd("editor.coreSave.saveForeshadow");
      markStart("editor.coreSave.upsertBeatMentions");
      upsertSceneBeatMentions(id, extractBeatMentions(doc)).catch((e) => {
        debugLog.error(
          "EditorPane",
          "upsertSceneBeatMentions failed",
          errorDetail(e),
        );
      });
      markEnd("editor.coreSave.upsertBeatMentions");
      markStart("editor.coreSave.upsertBeatPovOverrides");
      upsertSceneBeatPovOverrides(id, extractBeatPovOverrides(doc)).catch(
        (e) => {
          debugLog.error(
            "EditorPane",
            "upsertSceneBeatPovOverrides failed",
            errorDetail(e),
          );
        },
      );
      markEnd("editor.coreSave.upsertBeatPovOverrides");
      // Deferred body-mention scan — does not block the save response
      const allEntries = useCodexStore.getState().entries;
      if (allEntries.length > 0) {
        markStart("editor.coreSave.bodyMentionGetJSON");
        const docJsonStr = JSON.stringify(ed.getJSON());
        markEnd("editor.coreSave.bodyMentionGetJSON");
        setTimeout(() => {
          markStart("editor.coreSave.bodyMentionUpsert");
          upsertSceneBodyMentions(id, docJsonStr, allEntries)
            .catch((e) => {
              debugLog.error(
                "EditorPane",
                "upsertSceneBodyMentions failed",
                errorDetail(e),
              );
            })
            .finally(() => {
              markEnd("editor.coreSave.bodyMentionUpsert");
            });
        }, 0);
      }
      useTreeStore
        .getState()
        .refreshAiRatio(id)
        .catch(() => {});
      const chatState = useChatStore.getState();
      if (chatState.activeSceneId === id) {
        void chatState.refreshContextLayers();
      }
    }
    markEnd("editor.coreSave");
  }, []);

  const saveFn = useCallback(async () => {
    setIsSaving(true);
    try {
      await coreSave();
    } finally {
      setIsSaving(false);
    }
    setIsDirtyRef.current(false);

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

  // Register this pane's save function so the tab context menu can trigger it
  useEffect(() => {
    registerSaveHandler(nodeId, saveFn);
    return () => unregisterSaveHandler(nodeId);
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
    isCodexMode ? 0 : (s.aiRatios[nodeId] ?? 0),
  );
  const togglePanel = useLayoutStore((s) => s.togglePanel);

  const insertFromSnippet = useEditorStore((s) => s.insertFromSnippet);
  const insertFromPaste = useEditorStore((s) => s.insertFromPaste);

  const editor = useEditor({
    extensions: getEditorExtensions({
      setMentionPopup: (s) => {
        setMentionPopupState(s);
        setMentionIndex(0);
      },
    }),
    content: "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste(view, event, slice) {
        const html = event.clipboardData?.getData("text/html");
        const plainText = event.clipboardData?.getData("text/plain") ?? "";

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

        // Case 3: 外部テキスト貼り付け
        if (plainText) {
          insertFromPaste([{ text: plainText, source: "unknown" }]);
          return true;
        }
        return false;
      },
      handleDrop(view, event) {
        const snippetData = event.dataTransfer?.getData(
          "application/x-grimodex-snippet",
        );
        if (!snippetData) return false;
        event.preventDefault();
        try {
          const { id, content, source, originalContent } = JSON.parse(
            snippetData,
          ) as {
            id: string;
            content: string;
            source: "ai" | "human";
            originalContent: string | null;
          };
          const coords = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          insertFromSnippet(id, content, source, originalContent, coords?.pos);
          return true;
        } catch {
          return false;
        }
      },
    },
    onUpdate({ editor: e }) {
      if (isApplyingExternalUpdate.current) return;
      // インライン AI の生成中・diff 表示中はオートセーブを止める。
      // Accept/Reject が呼ばれて idle に戻った時点で reset + dispatch によって
      // 再度 onUpdate が走り、その時に通常の schedule が実行される。
      if (useInlineAiStore.getState().status !== "idle") return;
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
        if (!isCodexMode && !isSnippetMode && wasEmptyRef.current) {
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

      // Debounce stats: footer counts and tree-store charCount sync don't
      // need to update on every keystroke. The doc walk + setState x4 +
      // store fan-out happens once per typing burst instead of per char.
      if (statSyncTimeoutRef.current != null) {
        window.clearTimeout(statSyncTimeoutRef.current);
      }
      statSyncTimeoutRef.current = window.setTimeout(() => {
        statSyncTimeoutRef.current = null;
        markStart("editor.statSync");
        const text = getDocText(e.state.doc);
        const count = text.length;
        setCharCount(count);
        setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
        const bc = countBeats(e.state.doc);
        setBeatTotal(bc.total);
        setBeatGenerated(bc.generated);
        if (sid && !isCodexMode && !isSnippetMode) {
          useTreeStore.getState().setCharCount(sid, count);
        }
        markEnd("editor.statSync");
      }, 200);
      markEnd("editor.onUpdate");
    },
    onTransaction({ editor: e, transaction }) {
      if (!transaction.docChanged) return;
      if (isCodexMode || isSnippetMode) return;
      const sid = saveSceneIdRef.current;
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
      onFocus();
      // Trash bin の D&D 復元先として「最後にフォーカスしていたエディタ」を共有。
      // editor 参照も渡し、text-fragment 挿入時に直接 chain().insertContent を呼べるように。
      if (nodeId) {
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
        if (editorContainerRef.current) {
          editorContainerRef.current.scrollTop = pending.scrollTop;
        }
      }
    },
  });

  editorRef.current = editor;

  // Wrap view.dispatch to time the full TipTap dispatch cycle: state.apply +
  // plugin.appendTransactions + view.updateState (DOM patching) + listeners.
  // This is the only way to attribute longtasks whose work happens entirely
  // inside the TipTap pipeline (decorations diff, NodeView updates, DOM
  // mutations) — none of which our per-plugin marks reach.
  useEffect(() => {
    if (!editor) return;
    const view = editor.view;
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
  }, [editor]);

  // Register the primary editor in global store (for ChatPanel inserts)
  const setGlobalEditor = useEditorStore((s) => s.setEditor);
  useEffect(() => {
    if (groupIndex !== 0) return;
    setGlobalEditor(editor);
    return () => setGlobalEditor(null);
  }, [editor, setGlobalEditor, groupIndex]);

  // Linter — scene-only, primary group only.
  const lintSceneId =
    groupIndex === 0 && !isCodexMode && !isSnippetMode ? nodeId : null;
  useLinter(editor, lintSceneId);

  // ゴミ箱キャプチャ。Snippet タブは origin = null で skip、
  // Scene/Codex は対応する種別で記録する。
  const trashOrigin: TrashOrigin | null = isSnippetMode
    ? null
    : nodeId
      ? { kind: isCodexMode ? "codex" : "scene", id: nodeId }
      : null;
  useTrashBinCapture(editor, trashOrigin);

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

  // Ctrl+S / Ctrl+F / Ctrl+H / Ctrl+Shift+H key handlers
  const handleManualSave = useCallback(async () => {
    await flush();
    if (isCodexMode || isSnippetMode) return; // Codex/snippet entries: no revision on manual save
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
  }, [flush, isCodexMode, isSnippetMode]);

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
    isSnippetMode
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
  const focusModeHideBeats = editorSettings.focusModeHideBeats;
  const sceneMetaPanelOpen = editorSettings.sceneMetaPanelOpen;
  const sceneMetaPanelWidth = editorSettings.sceneMetaPanelWidth;
  const isPanelVisible =
    sceneMetaPanelOpen && !focusMode && !isCodexMode && !isSnippetMode;
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

  useTypewriterScroll(editor, typewriterMode, editorContainerRef);

  // When typewriter mode is toggled (on or off), scroll immediately to center
  // the cursor to prevent a visual jump from the 50vh padding being added/removed.
  useEffect(() => {
    if (!editorContainerRef.current || !editor) return;
    const container = editorContainerRef.current;
    const raf = requestAnimationFrame(() => {
      const { from } = editor.view.state.selection;
      let coordsTop: number;
      try {
        coordsTop = editor.view.coordsAtPos(from).top;
      } catch {
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const target = computeTypewriterScrollTop(
        coordsTop,
        containerRect.top,
        container.scrollTop,
        containerRect.height,
      );
      container.scrollTo({ top: Math.max(0, target), behavior: "auto" });
    });
    return () => cancelAnimationFrame(raf);
  }, [typewriterMode, editor, nodeId]);
  const { generate, accept, reject, rejectOrAbort, retry } =
    useInlineAiDiff(editor);
  void reject;

  useCursorOverlay(editor);
  useCharacterFade(editor);
  useAttribution(editor);

  // Listen for slash-command events dispatched by SlashCommandExtension
  useEffect(() => {
    if (!editor) return;
    function onSlashCommand(e: Event) {
      const cmd = (e as CustomEvent).detail?.command as
        | InlineAiCommand
        | undefined;
      if (!cmd) return;
      // Beat system: structural inserts skip the AI pipeline entirely.
      if (cmd.kind === "insert-node") {
        if (cmd.id === "sceneBeat") {
          editor.chain().focus().insertSceneBeat().run();
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
        editor,
        projectTitle,
        sceneTitle: node?.title ?? "",
        matchedCodexIds,
        codexEntries,
      });
      generate(cmd, context);
    }
    editor.view.dom.addEventListener("inlineai:slash-command", onSlashCommand);
    return () =>
      editor.view.dom.removeEventListener(
        "inlineai:slash-command",
        onSlashCommand,
      );
  }, [editor, nodeId, generate]);

  // Subscribe to content sync from the other pane (or CodexContentEditor mini-editor).
  // Apply is rAF-coalesced: a typing burst on the peer pane collapses to at most
  // one full-doc setContent per frame on the mirror, instead of one per keystroke.
  useEffect(() => {
    if (!editor) return;
    return subscribeLiveContentRafCoalesced(nodeId, groupIndex, (next) => {
      isApplyingExternalUpdate.current = true;
      try {
        editor.commands.setContent(
          next as Parameters<typeof editor.commands.setContent>[0],
          { emitUpdate: false },
        );
      } finally {
        isApplyingExternalUpdate.current = false;
      }
    });
  }, [nodeId, groupIndex, editor]);

  // Subscribe to unplaced beats changes → mark dirty and schedule save,
  // and live-sync the Grid preview cache for immediate UI feedback.
  useEffect(() => {
    if (!nodeId || isCodexMode || isSnippetMode) return;
    const unsubscribe = useUnplacedBeatsStore
      .getState()
      .subscribe(nodeId, () => {
        schedule();
        setIsDirtyRef.current(true);
        const beats = useUnplacedBeatsStore.getState().getBeats(nodeId);
        const unplaced = extractUnplacedBeatPreview(beats);
        useTreeStore.getState().setNodePreview(nodeId, {
          unplaced: unplaced === "[]" ? null : unplaced,
        });
      });
    return unsubscribe;
  }, [nodeId, isCodexMode, isSnippetMode, schedule]);

  // Load content when nodeId changes
  useEffect(() => {
    if (!editor || !nodeId) return;

    let cancelled = false;

    async function switchScene() {
      const prevId = prevSceneIdRef.current;
      if (prevId && prevId !== nodeId) {
        // Save current cursor/scroll state before leaving this scene
        const ed = editorRef.current;
        if (ed) {
          const { from, to } = ed.view.state.selection;
          savedEditorStateRef.current.set(prevId, {
            from,
            to,
            scrollTop: editorContainerRef.current?.scrollTop ?? 0,
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

      // Hold the external-update guard for the entire scene-switch sequence
      // (setContent + authorship load + foreshadow load). Releasing it earlier
      // lets a fast typist trigger autosave while marks are mid-load, which
      // would persist a doc with no setup marks and orphan every setup row.
      isApplyingExternalUpdate.current = true;
      try {
        if (isCodexMode) {
          // Load codex entry content (ProseMirror JSON)
          const entry = await getCodexEntry(nodeId);
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
          const parsed =
            rawContent && rawContent !== "{}" ? JSON.parse(rawContent) : "";
          editor!.commands.setContent(parsed, { emitUpdate: false });
        } else if (isSnippetMode) {
          // Load snippet content (HTML)
          const snippet = await getSnippet(nodeId);
          if (cancelled) return;
          editor!.commands.setContent(snippet?.content || "", {
            emitUpdate: false,
          });
        } else {
          // Load scene/note content + unplaced beats in one query
          const { content, unplacedBeatsDoc } = await loadSceneFull(nodeId);
          if (cancelled) return;
          const parsed = content && content !== "{}" ? JSON.parse(content) : "";
          editor!.commands.setContent(parsed, { emitUpdate: false });
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
              useTreeStore.getState().setNodePreview(nodeId, { placed: next });
            }
          }
        }

        const text = getDocText(editor!.state.doc);
        const count = text.length;
        setCharCount(count);
        setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
        const bc = countBeats(editor!.state.doc);
        setBeatTotal(bc.total);
        setBeatGenerated(bc.generated);
        setIsDirty(false);
        wasEmptyRef.current = count === 0;

        if (!isCodexMode && !isSnippetMode) {
          useTreeStore.getState().setCharCount(nodeId, count);

          const spans = await loadAuthorshipSpans(nodeId);
          if (!cancelled && spans.length > 0) {
            const markData = spansToMarkData(spans);
            const authorshipType = editor!.schema.marks["authorship"];
            if (authorshipType) {
              editor!
                .chain()
                .command(({ tr }) => {
                  tr.setMeta("programmaticInsert", true);
                  for (const { from, to, attrs } of markData) {
                    const docSize = tr.doc.content.size;
                    const clampedFrom = Math.min(from, docSize);
                    const clampedTo = Math.min(to, docSize);
                    if (clampedFrom < clampedTo) {
                      tr.addMark(
                        clampedFrom,
                        clampedTo,
                        authorshipType.create(attrs),
                      );
                    }
                  }
                  return true;
                })
                .run();
            }
          }

          // Load and apply foreshadow anchors
          const foreshadowMarks = await loadForeshadowAnchors(nodeId);
          if (!cancelled && foreshadowMarks.length > 0 && editor) {
            editor
              .chain()
              .command(({ tr }) => {
                tr.setMeta("programmaticInsert", true);
                clearAllForeshadowMarks((fn) => fn(tr));
                const schema = tr.doc.type.schema;
                for (const { from, to, markName, attrs } of foreshadowMarks) {
                  const markType = schema.marks[markName];
                  if (!markType) continue;
                  const docSize = tr.doc.content.size;
                  const cf = Math.min(from, docSize);
                  const ct = Math.min(to, docSize);
                  if (cf < ct) tr.addMark(cf, ct, markType.create(attrs));
                }
                return true;
              })
              .run();
          }
        }
      } finally {
        isApplyingExternalUpdate.current = false;
      }

      // Reset scroll to top after scene load; saved state will be restored below.
      if (editorContainerRef.current) {
        editorContainerRef.current.scrollTop = 0;
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

      // 伏線パネルからのジャンプ要求は saved cursor 復元より優先する。
      const fJump = useForeshadowNavStore.getState().consumeJump(nodeId);
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
              if (editorContainerRef.current) {
                editorContainerRef.current.scrollTop = saved.scrollTop;
              }
            });
          } else {
            // Scenes-panel navigation: defer restore until the editor is focused
            // so keyboard navigation in the panel is not interrupted.
            pendingCursorRestoreRef.current = {
              from: saved.from,
              to: saved.to,
              scrollTop: saved.scrollTop,
            };
          }
        }
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
    overridePhaseId,
    groupIndex,
  ]);

  const isNote =
    !isCodexMode && !isSnippetMode && activeNode?.nodeType === "note";

  const editorTitle = isCodexMode
    ? (activeCodexEntry?.name ?? "")
    : isSnippetMode
      ? (activeSnippetEntry?.title ?? "")
      : (activeNode?.title ?? "");

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
      } else {
        updateNodeTitle(nodeId, trimmed).catch(() => {});
      }
    }
    setTitleEditing(false);
  };

  const handleTitleCancel = () => {
    setTitleEditing(false);
  };

  const handleMentionSelect = useCallback(
    (entry: CodexEntry) => {
      mentionPopup?.command?.(entry);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );

  const handleMentionSelectWithRole = useCallback(
    (entry: CodexEntry, role: MentionRole) => {
      mentionPopup?.command?.(entry, role);
      setMentionPopupState(null);
    },
    [mentionPopup],
  );

  return (
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
        onVerticalPreview={() => setVerticalPreviewOpen(true)}
        actionsRef={toolbarActionsRef}
        panelOpen={sceneMetaPanelOpen}
        onTogglePanel={handleTogglePanel}
      />
      {isNote && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-medium">{t("editor.ribbon.noteEditing")}</span>
          <span className="text-amber-500/60">
            — {t("editor.ribbon.noteDescription")}
          </span>
        </div>
      )}
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
              <FindReplaceBar
                editor={editor}
                open={findOpen}
                showReplace={findShowReplace}
                onClose={() => setFindOpen(false)}
              />
              <EditorDropDiv
                outerRef={editorContainerRef}
                data-show-foreshadow-marks={
                  showForeshadowMarks ? "true" : "false"
                }
                data-focus-hide-beats={
                  focusModeHideBeats && focusMode ? "true" : undefined
                }
                className={`flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4${typewriterMode ? " typewriter-padding" : ""}${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    editor?.commands.focus();
                  }
                }}
              >
                <div
                  className={cn(
                    editorSettings.showLineNumbers && "editor-line-numbers",
                  )}
                  style={
                    {
                      fontFamily: editorSettings.fontFamily,
                      fontSize: `${editorSettings.fontSize}px`,
                      lineHeight: editorSettings.lineHeight,
                      maxWidth: `${editorSettings.maxContentWidth}px`,
                      margin: "0 auto",
                      wordBreak:
                        editorSettings.wordBreak as React.CSSProperties["wordBreak"],
                      lineBreak:
                        editorSettings.lineBreak as React.CSSProperties["lineBreak"],
                      "--editor-paragraph-indent": `${editorSettings.paragraphIndent}em`,
                    } as React.CSSProperties
                  }
                >
                  {editorTitle && (
                    <div
                      className="mb-6 border-b border-border/40 pb-4"
                      style={{
                        fontSize: `${Math.round(editorSettings.fontSize * 1.6)}px`,
                      }}
                    >
                      {titleEditing ? (
                        <input
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus
                          type="text"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={handleTitleSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleTitleSave();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              handleTitleCancel();
                            }
                          }}
                          className="w-full bg-transparent font-semibold text-content-foreground/60 outline-none placeholder:text-content-foreground/30"
                          style={{ fontFamily: "inherit", fontSize: "inherit" }}
                        />
                      ) : (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={handleTitleEditStart}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "F2")
                              handleTitleEditStart();
                          }}
                          className="cursor-text select-none font-semibold text-content-foreground/60 hover:text-content-foreground/80"
                        >
                          {editorTitle}
                        </div>
                      )}
                      {loadedPhaseLabel && (
                        <div
                          className="mt-1 text-sm font-normal text-purple-500/70"
                          style={{ fontSize: `${editorSettings.fontSize}px` }}
                        >
                          [{loadedPhaseLabel}]
                        </div>
                      )}
                    </div>
                  )}
                  <SceneBeatEditorContextProvider value={{ sceneId: nodeId }}>
                    <EditorContent editor={editor} />
                  </SceneBeatEditorContextProvider>
                  <CodexPopover editor={editor} />
                  <CommentAddPopover editor={editor} />
                  <ForeshadowMarkPopover editor={editor} />
                  <ForeshadowMarkHoverPopover
                    editor={editor}
                    containerRef={editorContainerRef}
                  />
                  <CommentHoverPopover
                    editor={editor}
                    containerRef={editorContainerRef}
                  />
                  <EditorContextMenu
                    editor={editor}
                    containerRef={editorContainerRef}
                    toolbarActionsRef={toolbarActionsRef}
                  />
                </div>
              </EditorDropDiv>
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
              <FindReplaceBar
                editor={editor}
                open={findOpen}
                showReplace={findShowReplace}
                onClose={() => setFindOpen(false)}
              />
              <EditorDropDiv
                outerRef={editorContainerRef}
                data-show-foreshadow-marks={
                  showForeshadowMarks ? "true" : "false"
                }
                data-focus-hide-beats={
                  focusModeHideBeats && focusMode ? "true" : undefined
                }
                className={`flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4${typewriterMode ? " typewriter-padding" : ""}${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
                onClick={(e) => {
                  if (e.target === e.currentTarget) {
                    editor?.commands.focus();
                  }
                }}
              >
                <div
                  className={cn(
                    editorSettings.showLineNumbers && "editor-line-numbers",
                  )}
                  style={
                    {
                      fontFamily: editorSettings.fontFamily,
                      fontSize: `${editorSettings.fontSize}px`,
                      lineHeight: editorSettings.lineHeight,
                      maxWidth: `${editorSettings.maxContentWidth}px`,
                      margin: "0 auto",
                      wordBreak:
                        editorSettings.wordBreak as React.CSSProperties["wordBreak"],
                      lineBreak:
                        editorSettings.lineBreak as React.CSSProperties["lineBreak"],
                      "--editor-paragraph-indent": `${editorSettings.paragraphIndent}em`,
                    } as React.CSSProperties
                  }
                >
                  {editorTitle && (
                    <div
                      className="mb-6 border-b border-border/40 pb-4"
                      style={{
                        fontSize: `${Math.round(editorSettings.fontSize * 1.6)}px`,
                      }}
                    >
                      {titleEditing ? (
                        <input
                          // eslint-disable-next-line jsx-a11y/no-autofocus
                          autoFocus
                          type="text"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onBlur={handleTitleSave}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleTitleSave();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              handleTitleCancel();
                            }
                          }}
                          className="w-full bg-transparent font-semibold text-content-foreground/60 outline-none placeholder:text-content-foreground/30"
                          style={{ fontFamily: "inherit", fontSize: "inherit" }}
                        />
                      ) : (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={handleTitleEditStart}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "F2")
                              handleTitleEditStart();
                          }}
                          className="cursor-text select-none font-semibold text-content-foreground/60 hover:text-content-foreground/80"
                        >
                          {editorTitle}
                        </div>
                      )}
                      {loadedPhaseLabel && (
                        <div
                          className="mt-1 text-sm font-normal text-purple-500/70"
                          style={{ fontSize: `${editorSettings.fontSize}px` }}
                        >
                          [{loadedPhaseLabel}]
                        </div>
                      )}
                    </div>
                  )}
                  <SceneBeatEditorContextProvider value={{ sceneId: nodeId }}>
                    <EditorContent editor={editor} />
                  </SceneBeatEditorContextProvider>
                  <CodexPopover editor={editor} />
                  <CommentAddPopover editor={editor} />
                  <ForeshadowMarkPopover editor={editor} />
                  <ForeshadowMarkHoverPopover
                    editor={editor}
                    containerRef={editorContainerRef}
                  />
                  <CommentHoverPopover
                    editor={editor}
                    containerRef={editorContainerRef}
                  />
                  <EditorContextMenu
                    editor={editor}
                    containerRef={editorContainerRef}
                    toolbarActionsRef={toolbarActionsRef}
                  />
                </div>
              </EditorDropDiv>
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
      <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {/* Left: status badge */}
        <div className="relative flex min-w-0 items-center">
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
        </div>
        {/* Right: stats + save state + history */}
        <div className="flex flex-shrink-0 items-center gap-3">
          <StatusBarIndicator />
          {showAttribution && aiRatio > 0 && (
            <button
              type="button"
              title={i18next.t("editor.status.openAttribution")}
              onClick={() => togglePanel("attribution")}
              className="tabular-nums text-purple-400 hover:text-foreground"
            >
              AI: {aiRatio}%
            </button>
          )}
          {beatTotal > 0 && (
            <span
              data-testid="beat-stats"
              className="tabular-nums text-muted-foreground"
            >
              Beats: {beatTotal}
              {beatGenerated > 0 && ` (${beatGenerated} generated)`}
            </span>
          )}
          <div ref={charCountContainerRef} className="relative">
            <button
              type="button"
              ref={charCountRef as React.RefObject<HTMLButtonElement>}
              data-testid="char-count"
              onClick={() => setCharCountPopoverOpen((v) => !v)}
              title={i18next.t("editor.status.charCountDetails")}
              className="flex items-center gap-1.5 tabular-nums hover:text-foreground"
            >
              <span>{charCount.toLocaleString()} chars</span>
              {targetCharCount > 0 && (
                <>
                  <span className="text-muted-foreground">
                    / {targetCharCount.toLocaleString()}
                  </span>
                  <span
                    className="relative h-1 w-12 overflow-hidden rounded-full bg-muted"
                    aria-hidden
                  >
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 transition-[width] duration-200",
                        charCount >= targetCharCount
                          ? "bg-emerald-500"
                          : "bg-primary",
                      )}
                      style={{
                        width: `${Math.min(100, (charCount / targetCharCount) * 100)}%`,
                      }}
                    />
                  </span>
                  {charCount > targetCharCount && (
                    <span className="text-rose-500">
                      +{(charCount - targetCharCount).toLocaleString()}
                    </span>
                  )}
                </>
              )}
            </button>
            <AnimatedDropdown
              open={charCountPopoverOpen}
              onClose={() => setCharCountPopoverOpen(false)}
              containerRef={charCountContainerRef}
              className="absolute bottom-6 right-0 z-50 min-w-[220px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
            >
              {(() => {
                const text = editor ? getDocText(editor.state.doc) : "";
                const wc = countWords(text);
                const pages = manuscriptPages(charCount);
                const minutes = readingMinutes(charCount);
                return (
                  <div className="flex flex-col gap-1.5 tabular-nums">
                    <Stat
                      label={i18next.t("editor.status.chars")}
                      value={charCount.toLocaleString()}
                    />
                    <Stat
                      label={i18next.t("editor.status.words")}
                      value={wc.toLocaleString()}
                    />
                    <Stat
                      label={i18next.t("editor.status.manuscriptPages")}
                      value={i18next.t("editor.status.manuscriptPagesValue", {
                        n: pages.toFixed(1),
                      })}
                    />
                    <Stat
                      label={i18next.t("editor.status.readingTime")}
                      value={i18next.t("editor.status.readingTimeValue", {
                        n: minutes,
                      })}
                    />
                    {targetCharCount > 0 && (
                      <>
                        <div className="my-1 border-t border-border" />
                        <Stat
                          label={i18next.t("editor.status.goal")}
                          value={`${targetCharCount.toLocaleString()} chars`}
                        />
                        <div className="flex items-center gap-2">
                          <span
                            className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted"
                            aria-hidden
                          >
                            <span
                              className={cn(
                                "absolute inset-y-0 left-0",
                                charCount >= targetCharCount
                                  ? "bg-emerald-500"
                                  : "bg-primary",
                              )}
                              style={{
                                width: `${Math.min(100, (charCount / targetCharCount) * 100)}%`,
                              }}
                            />
                          </span>
                          <span className="w-10 text-right text-muted-foreground">
                            {Math.round((charCount / targetCharCount) * 100)}%
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}
            </AnimatedDropdown>
          </div>
          {isSaving ? (
            <span className="opacity-50">Saving...</span>
          ) : isDirty ? (
            <span className="text-amber-500">Unsaved</span>
          ) : (
            <span className="opacity-40">Saved</span>
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
      <VerticalPreview
        open={verticalPreviewOpen}
        onClose={() => setVerticalPreviewOpen(false)}
      />
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
        />
      )}
      <InlineAIToolbar
        onAccept={accept}
        onReject={rejectOrAbort}
        onRetry={retry}
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
    </div>
  );
}
