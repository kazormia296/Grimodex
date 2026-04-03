import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { Toolbar } from "@/features/editor/Toolbar";
import { CharCount } from "@/features/editor/CharCount";
import { SynopsisHeader } from "@/features/editor/SynopsisHeader";
import { useSceneStore } from "./store";
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
import { useCursorEffect } from "@/features/editor/useCursorEffect";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { AttributionOverrideMenu } from "@/features/attribution/AttributionOverrideMenu";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import { VerticalPreview } from "@/features/editor/VerticalPreview";
import { EditorContextMenu } from "@/features/editor/EditorContextMenu";
import { FindReplaceBar } from "@/features/editor/FindReplaceBar";
import { RevisionHistoryModal } from "@/features/revision/RevisionHistoryModal";
import type { SceneStatus } from "@/features/tree/treeStore";

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

export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const prevSceneIdRef = useRef(activeSceneId);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [charCount, setCharCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const [isDirty, setIsDirty] = useState(false);

  const activeNode = useTreeStore((s) =>
    s.nodes.find((n) => n.id === activeSceneId),
  );
  const activeStatus = (activeNode?.status ?? null) as SceneStatus | null;

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const [verticalPreviewOpen, setVerticalPreviewOpen] = useState(false);

  const setIsDirtyRef = useRef(setIsDirty);
  setIsDirtyRef.current = setIsDirty;

  const saveSceneIdRef = useRef(activeSceneId);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  /** Core save: writes Markdown + authorship spans */
  const coreSave = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (ed.storage as any).markdown.getMarkdown() as string;
    await saveSceneContent(id, md);
    await saveAuthorshipSpans(id, ed.state.doc);
  }, []);

  /** Auto-save callback: saves content + creates auto-revision if interval passed */
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

  const { schedule, cancel, flush } = useAutoSave(saveFn, 2000);

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

        // External paste: mark as unknown
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
      schedule();
      setIsDirtyRef.current(true);
      const text = e.state.doc.textContent;
      setCharCount(text.length);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
    },
    onSelectionUpdate({ editor: e }) {
      setCursorPos(e.state.selection.anchor);
    },
  });

  // Keep editorRef in sync
  editorRef.current = editor;

  // Register editor in global store for cross-feature access (Task 2.4)
  const setEditor = useEditorStore((s) => s.setEditor);
  useEffect(() => {
    setEditor(editor);
    return () => setEditor(null);
  }, [editor, setEditor]);

  // Ctrl+S: manual save + manual revision (F-4)
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

  // Insert highlight decoration (Task 2.4)
  useInsertHighlight(editor);

  // Codex name highlighting (Task 3.6)
  useCodexHighlight(editor);

  // Typewriter cursor effect
  const cursorAnimation = useCursorSettingsStore((s) => s.cursorAnimation);
  useCursorEffect(editor, cursorAnimation);

  // Attribution visualization (Task 4.2)
  useAttribution(editor);

  // Load content when active scene changes
  useEffect(() => {
    if (!editor || !activeSceneId) return;

    let cancelled = false;

    async function switchScene() {
      // Flush pending save for previous scene using its ID
      if (prevSceneIdRef.current && prevSceneIdRef.current !== activeSceneId) {
        await flush();
      }

      // Cancel any pending timer before switching saveSceneIdRef
      cancel();
      saveSceneIdRef.current = activeSceneId;

      const content = await loadSceneContent(activeSceneId);
      if (cancelled) return;
      editor!.commands.setContent(content || "");
      const text = editor!.state.doc.textContent;
      setCharCount(text.length);
      setWordCount(text.trim() === "" ? 0 : text.trim().split(/\s+/).length);
      setCursorPos(0);
      setIsDirty(false);

      // Restore authorship marks from DB
      const spans = await loadAuthorshipSpans(activeSceneId);
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
                // Clamp to doc size to avoid out-of-range errors
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

      prevSceneIdRef.current = activeSceneId;
    }

    switchScene();

    return () => {
      cancelled = true;
    };
  }, [activeSceneId, editor, flush, cancel]);

  return (
    <div className="flex flex-col h-full">
      <Toolbar
        editor={editor}
        onFindReplace={() => { setFindOpen(true); setFindShowReplace(true); }}
        onVerticalPreview={() => setVerticalPreviewOpen(true)}
      />
      <SynopsisHeader sceneId={activeSceneId} />
      <FindReplaceBar
        editor={editor}
        open={findOpen}
        showReplace={findShowReplace}
        onClose={() => setFindOpen(false)}
      />
      <div ref={editorContainerRef} className="flex-1 overflow-auto p-4">
        <EditorContent editor={editor} />
        <CodexPopover editor={editor} />
        <AttributionOverrideMenu editor={editor} />
        <EditorContextMenu editor={editor} containerRef={editorContainerRef} />
      </div>
      {/* C-3: Enhanced status bar */}
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
      <RevisionHistoryModal />
    </div>
  );
}
