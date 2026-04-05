import { useState, useEffect, useRef, useCallback } from "react";
import { Clock } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { Toolbar } from "@/features/editor/Toolbar";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneContent, saveSceneContent } from "@/features/tree/api";
import { useAutoSave } from "@/hooks/useAutoSave";
import { createRevision } from "@/features/revision/api";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { parseClipboardHtml } from "@/lib/clipboardAttribution";
import { useInsertHighlight } from "@/features/editor/InsertHighlight";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCursorEffect } from "@/features/editor/useCursorEffect";
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
import type { GroupIndex } from "@/features/editor/tabStore";

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
  sceneId: string;
  groupIndex: GroupIndex;
  onFocus: () => void;
}

/**
 * A single TipTap editor pane.
 * Used as-is for the primary group, and duplicated for the secondary group.
 * When the same sceneId is open in both groups, edits propagate via sceneContentStore.
 */
export function EditorPane({ sceneId, groupIndex, onFocus }: EditorPaneProps) {
  const prevSceneIdRef = useRef(sceneId);
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

  const activeNode = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [verticalPreviewOpen, setVerticalPreviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePreselect, setPalettePreselect] =
    useState<InlineAiCommand | null>(null);

  const setIsDirtyRef = useRef(setIsDirty);
  setIsDirtyRef.current = setIsDirty;

  const saveSceneIdRef = useRef(sceneId);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  // Prevent feedback loop when applying external content sync
  const isApplyingExternalUpdate = useRef(false);

  // Auto-draft: true when scene was empty at load time
  const wasEmptyRef = useRef(false);

  // Synopsis suggestion: track previous status to detect transitions
  const prevStatusRef = useRef<SceneStatus | null>(activeStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = activeStatus;
    const synopsis = useTreeStore
      .getState()
      .nodes.find((n) => n.id === sceneId)?.synopsis;
    if (shouldPromptSynopsis(prev, activeStatus, synopsis)) {
      const id = sceneId;
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
  }, [activeStatus, sceneId]);

  const coreSave = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (ed.storage as any).markdown.getMarkdown() as string;
    await saveSceneContent(id, md);
    await saveAuthorshipSpans(id, ed.state.doc);
    useTreeStore
      .getState()
      .refreshAiRatio(id)
      .catch(() => {});
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
  }, [coreSave, shouldAutoRevision, recordAutoRevision]);

  // Register this pane's save function so the tab context menu can trigger it
  useEffect(() => {
    registerSaveHandler(sceneId, saveFn);
    return () => unregisterSaveHandler(sceneId);
  }, [sceneId, saveFn]);

  // Sync isDirty to the tab store for unsaved-changes detection
  useEffect(() => {
    useTabStore.getState().setTabDirty(sceneId, isDirty);
    return () => useTabStore.getState().setTabDirty(sceneId, false);
  }, [sceneId, isDirty]);

  const editorSettings = useEditorSettings();
  const { schedule, cancel, flush } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

  const filterSource = useAttributionStore((s) => s.filterSource);
  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const aiRatio = useTreeStore((s) => s.aiRatios[sceneId] ?? 0);
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
      handlePaste(_view, event) {
        const html = event.clipboardData?.getData("text/html");
        const plainText = event.clipboardData?.getData("text/plain") ?? "";
        const segments = parseClipboardHtml(html);
        if (segments) {
          insertFromPaste(segments);
          return true;
        }
        if (plainText) {
          insertFromPaste([{ text: plainText, source: "unknown" }]);
          return true;
        }
        return false;
      },
      handleDrop(_view, event) {
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
          insertFromSnippet(id, content, source, originalContent);
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
        useTreeStore.getState().setCharCount(sid, count);
        // Auto-promote preview tab to pinned when user starts editing
        if (groupIndex === 0) {
          useTabStore.getState().pinTab(sid);
        } else {
          useTabStore.getState().pinSecondaryTab(sid);
        }
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
        // Broadcast to other panes showing the same scene
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
  }, [flush]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
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

  useInsertHighlight(editor);
  useCodexHighlight(editor);
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
  }, [typewriterMode, editor, sceneId]);
  const { generate, accept, reject, retry } = useInlineAiDiff(editor);

  const cursorAnimation = useCursorSettingsStore((s) => s.cursorAnimation);
  useCursorEffect(editor, cursorAnimation);
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

  // Subscribe to content sync from the other pane
  useEffect(() => {
    if (!editor) return;
    const unsubscribe = useSceneContentStore
      .getState()
      .subscribe(sceneId, (content, sourceGroupIndex) => {
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
  }, [sceneId, groupIndex, editor]);

  // Load content when sceneId changes
  useEffect(() => {
    if (!editor || !sceneId) return;

    let cancelled = false;

    async function switchScene() {
      const prevId = prevSceneIdRef.current;
      if (prevId && prevId !== sceneId) {
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
      }
      cancel();
      saveSceneIdRef.current = sceneId;

      const content = await loadSceneContent(sceneId);
      if (cancelled) return;
      // Guard onUpdate so that programmatic content loading does not
      // trigger autosave scheduling or promote the preview tab to pinned.
      isApplyingExternalUpdate.current = true;
      try {
        editor!.commands.setContent(content || "");
      } finally {
        isApplyingExternalUpdate.current = false;
      }
      const text = getDocText(editor!.state.doc);
      const count = text.length;
      setCharCount(count);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
      setIsDirty(false);
      wasEmptyRef.current = count === 0;
      useTreeStore.getState().setCharCount(sceneId, count);

      const spans = await loadAuthorshipSpans(sceneId);
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

      prevSceneIdRef.current = sceneId;

      // Decide whether to focus the editor immediately.
      // Tab clicks set the flag; Scenes-panel navigation does not.
      const focusNow = useTabStore.getState().consumeEditorFocusRequest();

      // Clear any pending lazy restore from a previous scene switch so stale
      // state is never applied if this new switch doesn't produce saved data.
      pendingCursorRestoreRef.current = null;

      // Restore cursor/scroll state if this scene was previously visited.
      const saved = savedEditorStateRef.current.get(sceneId);
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
  }, [sceneId, editor, flush, cancel]);

  const isNote = activeNode?.nodeType === "note";

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
      <SynopsisHeader sceneId={sceneId} />
      <FindReplaceBar
        editor={editor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      <div
        ref={editorContainerRef}
        className={`flex-1 overflow-auto p-4${typewriterMode ? " typewriter-padding" : ""}${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
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
          }}
        >
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
                          .setStatus(sceneId, s)
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
              .nodes.find((n) => n.id === sceneId);
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
