import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { Toolbar } from "@/features/editor/Toolbar";
import { CharCount } from "@/features/editor/CharCount";
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
import { useCursorEffect } from "@/features/editor/useCursorEffect";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useEditorSettings } from "@/features/settings/hooks/useEditorSettings";
import { AttributionOverrideMenu } from "@/features/attribution/AttributionOverrideMenu";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { VerticalPreview } from "@/features/editor/VerticalPreview";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { useTabStore } from "@/features/editor/tabStore";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { shouldAutoDraftTransition } from "@/features/editor/autoStatusTransition";
import { shouldPromptSynopsis } from "@/features/editor/synopsisSuggestion";
import { generateSynopsisFromContent } from "@/features/chat/chatApi";
import { toast } from "sonner";
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
  const [charCount, setCharCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [isDirty, setIsDirty] = useState(false);

  const activeNode = useTreeStore((s) => s.nodes.find((n) => n.id === sceneId));
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [verticalPreviewOpen, setVerticalPreviewOpen] = useState(false);

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
    await coreSave();
    setIsDirtyRef.current(false);
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    if (shouldAutoRevision(id)) {
      const content = JSON.stringify(ed.getJSON());
      const rev = await createRevision({
        entityType: "scene",
        entityId: id,
        content,
        snapshotType: "auto",
      });
      if (rev) recordAutoRevision(id);
    }
  }, [coreSave, shouldAutoRevision, recordAutoRevision]);

  const editorSettings = useEditorSettings();
  const { schedule, cancel, flush } = useAutoSave(
    saveFn,
    editorSettings.autoSaveDelay,
  );

  const filterSource = useAttributionStore((s) => s.filterSource);

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
      const text = e.state.doc.textContent;
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
    onSelectionUpdate({ editor: e }) {
      setCursorPos(e.state.selection.anchor);
    },
    onFocus() {
      onFocus();
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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleManualSave]);

  useInsertHighlight(editor);
  useCodexHighlight(editor);

  const cursorAnimation = useCursorSettingsStore((s) => s.cursorAnimation);
  useCursorEffect(editor, cursorAnimation);
  useAttribution(editor);

  // Subscribe to content sync from the other pane
  useEffect(() => {
    if (!editor) return;
    const unsubscribe = useSceneContentStore
      .getState()
      .subscribe(sceneId, (content, sourceGroupIndex) => {
        if (sourceGroupIndex === groupIndex) return; // Skip our own updates
        // isApplyingExternalUpdate guards the onUpdate handler from re-broadcasting
        isApplyingExternalUpdate.current = true;
        editor.commands.setContent(
          content as Parameters<typeof editor.commands.setContent>[0],
        );
        isApplyingExternalUpdate.current = false;
      });
    return unsubscribe;
  }, [sceneId, groupIndex, editor]);

  // Load content when sceneId changes
  useEffect(() => {
    if (!editor || !sceneId) return;

    let cancelled = false;

    async function switchScene() {
      if (prevSceneIdRef.current && prevSceneIdRef.current !== sceneId) {
        await flush();
      }
      cancel();
      saveSceneIdRef.current = sceneId;

      const content = await loadSceneContent(sceneId);
      if (cancelled) return;
      editor!.commands.setContent(content || "");
      const text = editor!.state.doc.textContent;
      const count = text.length;
      setCharCount(count);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
      setCursorPos(0);
      setIsDirty(false);
      wasEmptyRef.current = count === 0;
      useTreeStore.getState().setCharCount(sceneId, count);

      const spans = await loadAuthorshipSpans(sceneId);
      if (!cancelled && spans.length > 0) {
        const markData = spansToMarkData(spans);
        const authorshipType = editor!.schema.marks["authorship"];
        if (authorshipType) {
          editor!
            .chain()
            .focus()
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

      prevSceneIdRef.current = sceneId;
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
        className={`flex-1 overflow-auto p-4${filterSource ? ` attribution-filter-${filterSource}` : ""}`}
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
      <div className="flex items-center justify-between border-t border-border px-3 py-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <CharCount count={charCount} />
          <span>{wordCount} 語</span>
          {cursorPos > 0 && <span>位置 {cursorPos}</span>}
        </div>
        <div className="flex items-center gap-3">
          {activeStatus && (
            <span className={STATUS_COLORS[activeStatus]}>
              {STATUS_LABELS[activeStatus]}
            </span>
          )}
          {isDirty ? (
            <span className="opacity-50">未保存</span>
          ) : (
            <span className="opacity-40">保存済</span>
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
            履歴
          </button>
        </div>
      </div>
      <VerticalPreview
        open={verticalPreviewOpen}
        onClose={() => setVerticalPreviewOpen(false)}
      />
    </div>
  );
}
