import { useState, useEffect, useRef, useCallback } from "react";
import { Clock } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { Toolbar } from "@/features/editor/Toolbar";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { getCodexEntry, updateCodexEntry } from "@/features/codex/api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
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
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { AttributionOverrideMenu } from "@/features/attribution/AttributionOverrideMenu";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { VerticalPreview } from "@/features/editor/VerticalPreview";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { useFocusMode } from "@/features/editor/useFocusMode";
import {
  useTypewriterScroll,
  computeTypewriterScrollTop,
} from "@/features/editor/useTypewriterScroll";
import { useInlineAiDiff } from "@/features/editor/inlineAi/useInlineAiDiff";
import { InlineAIPalette } from "@/features/editor/inlineAi/InlineAIPalette";
import { InlineAIToolbar } from "@/features/editor/inlineAi/InlineAIToolbar";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";
import { useTabStore } from "@/features/editor/tabStore";
import {
  registerSaveHandler,
  unregisterSaveHandler,
} from "@/features/editor/editorSaveRegistry";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { shouldPromptSynopsis } from "@/features/editor/synopsisSuggestion";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import type { SceneStatus } from "@/features/tree/treeStore";
import type { GroupIndex, TabContentType } from "@/features/editor/tabStore";

const STATUS_LABELS: Record<SceneStatus, string> = {
  outline: "アウトライン",
  draft: "下書き",
  complete: "完成",
  revision: "改訂中",
  final: "最終",
};

const STATUS_COLORS: Record<SceneStatus, string> = {
  outline: "text-muted-foreground",
  draft: "text-yellow-500",
  complete: "text-green-500",
  revision: "text-purple-400",
  final: "text-blue-400",
};

/** Returns the full text of a document, including ruby base characters (which are atom nodes and not part of textContent). */
function getDocText(doc: ProseMirrorNode): string {
  let text = "";
  doc.descendants((node) => {
    if (node.type.name === "ruby") {
      text += (node.attrs.base as string) ?? "";
      return false;
    }
    if (node.isText) {
      text += node.text ?? "";
    }
  });
  return text;
}

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
export function EditorPane({
  nodeId,
  contentType,
  groupIndex,
  onFocus,
}: EditorPaneProps) {
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
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [verticalPreviewOpen, setVerticalPreviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePreselect, setPalettePreselect] =
    useState<InlineAiCommand | null>(null);

  const setIsDirtyRef = useRef(setIsDirty);
  setIsDirtyRef.current = setIsDirty;

  const saveSceneIdRef = useRef(nodeId);
  // Codex mode: non-null when the loaded content came from a phase contentOverride → save back to that phase
  const activePhaseIdRef = useRef<string | null>(null);
  // Reactive version of activePhaseIdRef for display purposes
  const [loadedPhaseId, setLoadedPhaseId] = useState<string | null>(null);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  // Prevent feedback loop when applying external content sync
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
      const id = nodeId;
      toast("Synopsis が未記入です", {
        description: "自動生成しますか？",
        duration: 10000,
        action: {
          label: "Generate",
          onClick: async () => {
            const node = useTreeStore.getState().nodes.find((n) => n.id === id);
            if (!node) return;
            try {
              const content = await loadSceneContent(id);
              if (!content?.trim()) {
                toast.warning("シーン本文が空のため生成できません");
                return;
              }
              const generated = await generateSynopsisFromContent(
                node.title,
                content,
              );
              await useTreeStore
                .getState()
                .updateSynopsis(id, generated.trim());
              toast.success("Synopsis を生成しました");
            } catch {
              toast.error("Synopsis 生成に失敗しました");
            }
          },
        },
        cancel: {
          label: "Dismiss",
          onClick: () => {},
        },
      });
    }
  }, [activeStatus, nodeId, isCodexMode, isSnippetMode]);

  const coreSave = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    if (isCodexMode) {
      const content = JSON.stringify(ed.getJSON());
      const phaseId = activePhaseIdRef.current;
      if (phaseId) {
        await usePhaseStore
          .getState()
          .updatePhase(phaseId, { contentOverride: content });
      } else {
        await updateCodexEntry(id, { content });
      }
    } else if (isSnippetMode) {
      const content = ed.getHTML();
      await updateSnippet(id, { content });
      useSnippetStore.getState().update(id, { content });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = (ed.storage as any).markdown.getMarkdown() as string;
      await saveSceneContent(id, md);
      await saveAuthorshipSpans(id, ed.state.doc);
      useTreeStore
        .getState()
        .refreshAiRatio(id)
        .catch(() => {});
    }
  }, [isCodexMode, isSnippetMode]);

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
    if (!isCodexMode && !isSnippetMode) {
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
  }, [isCodexMode, coreSave, shouldAutoRevision, recordAutoRevision]);

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
    extensions: getEditorExtensions(),
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
      schedule();
      setIsDirtyRef.current(true);
      const text = getDocText(e.state.doc);
      const count = text.length;
      setCharCount(count);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
      const sid = saveSceneIdRef.current;
      if (sid) {
        // Auto-promote preview tab to pinned when user starts editing
        if (groupIndex === 0) {
          useTabStore.getState().pinTab(sid);
        } else {
          useTabStore.getState().pinSecondaryTab(sid);
        }
        if (!isCodexMode && !isSnippetMode) {
          useTreeStore.getState().setCharCount(sid, count);
          // Auto-transition outline → draft on first keystroke in empty scene
          const nodeStatus = useTreeStore
            .getState()
            .nodes.find((n) => n.id === sid)?.status as
            | SceneStatus
            | null
            | undefined;
          if (
            shouldAutoDraftTransition(
              count,
              wasEmptyRef.current,
              nodeStatus ?? null,
            )
          ) {
            wasEmptyRef.current = false;
            useTreeStore
              .getState()
              .setStatus(sid, "draft")
              .catch(() => {});
          }
        }
        // Broadcast to other panes showing the same content
        useSceneContentStore
          .getState()
          .setLiveContent(sid, e.getJSON(), groupIndex);
      }
    },
    onSelectionUpdate() {},
    onFocus() {
      onFocus();
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

  // Register the primary editor in global store (for ChatPanel inserts)
  const setGlobalEditor = useEditorStore((s) => s.setEditor);
  useEffect(() => {
    if (groupIndex !== 0) return;
    setGlobalEditor(editor);
    return () => setGlobalEditor(null);
  }, [editor, setGlobalEditor, groupIndex]);

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
  }, [flush, isCodexMode]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!paneRef.current?.contains(document.activeElement)) return;
      if (e.ctrlKey && e.key === "s" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        handleManualSave();
      } else if (e.ctrlKey && e.key === "f" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(false);
      } else if (e.ctrlKey && e.key === "h" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(true);
      } else if (e.ctrlKey && e.shiftKey && e.key === "H") {
        e.preventDefault();
        const id = saveSceneIdRef.current;
        const ed = editorRef.current;
        if (id && ed) {
          const content = JSON.stringify(ed.getJSON());
          useRevisionStore.getState().openHistory("scene", id, content);
        }
      } else if (e.ctrlKey && e.shiftKey && e.key === " ") {
        e.preventDefault();
        setPalettePreselect(null);
        setPaletteOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleManualSave]);

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
  const { generate, accept, reject, retry } = useInlineAiDiff(editor);

  useCursorOverlay(editor);
  useAttribution(editor);

  // Listen for slash-command events dispatched by SlashCommandExtension
  useEffect(() => {
    if (!editor) return;
    function onSlashCommand(e: Event) {
      const cmd = (e as CustomEvent).detail?.command as
        | InlineAiCommand
        | undefined;
      if (cmd) {
        setPalettePreselect(cmd);
        setPaletteOpen(true);
      }
    }
    editor.view.dom.addEventListener("inlineai:slash-command", onSlashCommand);
    return () =>
      editor.view.dom.removeEventListener(
        "inlineai:slash-command",
        onSlashCommand,
      );
  }, [editor]);

  // Subscribe to content sync from the other pane (or CodexContentEditor mini-editor)
  useEffect(() => {
    if (!editor) return;
    const unsubscribe = useSceneContentStore
      .getState()
      .subscribe(nodeId, (content, sourceGroupIndex) => {
        if (sourceGroupIndex === groupIndex) return; // Skip our own updates
        // isApplyingExternalUpdate guards the onUpdate handler from re-broadcasting
        isApplyingExternalUpdate.current = true;
        try {
          editor.commands.setContent(
            content as Parameters<typeof editor.commands.setContent>[0],
          );
        } finally {
          isApplyingExternalUpdate.current = false;
        }
      });
    return unsubscribe;
  }, [nodeId, groupIndex, editor]);

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
          editor!.commands.setContent(parsed);
        } else if (isSnippetMode) {
          // Load snippet content (HTML)
          const snippet = await getSnippet(nodeId);
          if (cancelled) return;
          editor!.commands.setContent(snippet?.content || "");
        } else {
          // Load scene/note content (Markdown)
          const content = await loadSceneContent(nodeId);
          if (cancelled) return;
          editor!.commands.setContent(content || "");
        }
      } finally {
        isApplyingExternalUpdate.current = false;
      }

      const text = getDocText(editor!.state.doc);
      const count = text.length;
      setCharCount(count);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
      setIsDirty(false);
      wasEmptyRef.current = count === 0;

      if (!isCodexMode && !isSnippetMode) {
        useTreeStore.getState().setCharCount(nodeId, count);

        const spans = await loadAuthorshipSpans(nodeId);
        if (!cancelled && spans.length > 0) {
          const markData = spansToMarkData(spans);
          const authorshipType = editor!.schema.marks["authorship"];
          if (authorshipType) {
            isApplyingExternalUpdate.current = true;
            try {
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
            } finally {
              isApplyingExternalUpdate.current = false;
            }
          }
        }
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

  return (
    <div ref={paneRef} className="flex flex-1 flex-col overflow-hidden">
      <Toolbar
        editor={editor}
        onFindReplace={() => {
          setFindOpen(true);
          setFindShowReplace(true);
        }}
        onVerticalPreview={() => setVerticalPreviewOpen(true)}
      />
      {isNote && (
        <div className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs text-amber-600 dark:text-amber-400">
          <span className="font-medium">ノート編集中</span>
          <span className="text-amber-500/60">
            — このファイルはシーンではなくノートです
          </span>
        </div>
      )}
      {isCodexMode && (
        <div className="flex items-center gap-1.5 border-b border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-600 dark:text-purple-400">
          <span className="font-medium">📖 Codex エントリ編集中</span>
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
          <span className="font-medium">📎 スニペット編集中</span>
          {activeSnippetEntry && (
            <span className="text-emerald-500/60">
              — {activeSnippetEntry.title}
            </span>
          )}
        </div>
      )}
      {!isCodexMode && !isSnippetMode && <SynopsisHeader sceneId={nodeId} />}
      <FindReplaceBar
        editor={editor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      <div
        ref={editorContainerRef}
        className={`flex-1 overflow-auto bg-content-background text-content-foreground-secondary p-4${typewriterMode ? " typewriter-padding" : ""}${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
        onClick={(e) => {
          // Focus editor when clicking on the padding/background area
          if (e.target === e.currentTarget) {
            editor?.commands.focus();
          }
        }}
      >
        <div
          style={{
            fontFamily: editorSettings.fontFamily,
            fontSize: `${editorSettings.fontSize}px`,
            lineHeight: editorSettings.lineHeight,
            maxWidth: `${editorSettings.maxContentWidth}px`,
            margin: "0 auto",
            wordBreak:
              editorSettings.wordBreak as React.CSSProperties["wordBreak"],
            lineBreak:
              editorSettings.lineBreak as React.CSSProperties["lineBreak"],
          }}
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
          <EditorContent editor={editor} />
          <CodexPopover editor={editor} />
          <AttributionOverrideMenu editor={editor} />
          <EditorContextMenu
            editor={editor}
            containerRef={editorContainerRef}
          />
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground">
        {/* Left: status badge */}
        <div className="relative flex min-w-0 items-center">
          {activeStatus ? (
            <>
              <button
                ref={statusBadgeRef}
                type="button"
                title="ステータスを変更"
                onClick={() => setStatusPopoverOpen((v) => !v)}
                className={`rounded px-1.5 py-0.5 font-medium hover:bg-accent ${STATUS_COLORS[activeStatus]}`}
              >
                {STATUS_LABELS[activeStatus]}
              </button>
              {statusPopoverOpen && (
                <div
                  ref={statusPopoverRef}
                  className="absolute bottom-full left-0 z-50 mb-1 min-w-[120px] rounded border border-border bg-background py-1 shadow-md"
                >
                  {(
                    Object.entries(STATUS_LABELS) as [SceneStatus, string][]
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
          {showAttribution && aiRatio > 0 && (
            <button
              type="button"
              title="Attributionパネルを開く"
              onClick={() => togglePanel("attribution")}
              className="tabular-nums text-purple-400 hover:text-foreground"
            >
              AI: {aiRatio}%
            </button>
          )}
          <span data-testid="char-count" className="tabular-nums">
            {charCount.toLocaleString()} chars
          </span>
          {isSaving ? (
            <span className="opacity-50">Saving...</span>
          ) : isDirty ? (
            <span className="text-amber-500">Unsaved</span>
          ) : (
            <span className="opacity-40">Saved</span>
          )}
          <button
            type="button"
            title="リビジョン履歴 (Ctrl+Shift+H)"
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
            const sceneText = editor.getText();
            const { from, to } = editor.state.selection;
            const selectedText =
              from !== to ? editor.state.doc.textBetween(from, to) : undefined;
            generate(command, {
              projectTitle: node?.title ?? "",
              sceneTitle: node?.title ?? "",
              sceneText,
              codexSummaries: "",
              selectedText,
              arg: prompt || undefined,
            });
          }}
        />
      )}
      <InlineAIToolbar onAccept={accept} onReject={reject} onRetry={retry} />
    </div>
  );
}
