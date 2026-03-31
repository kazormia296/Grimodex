import { useState, useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { getEditorExtensions } from "@/features/editor/extensions";
import { Toolbar } from "@/features/editor/Toolbar";
import { CharCount } from "@/features/editor/CharCount";
import { useSceneStore } from "./store";
import { loadSceneContent, saveSceneContent } from "./api";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useEditorStore } from "@/features/editor/editorStore";
import { useInsertHighlight } from "@/features/editor/InsertHighlight";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";
import { CodexPopover } from "@/features/editor/CodexPopover";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCursorEffect } from "@/features/editor/useCursorEffect";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { AttributionOverrideMenu } from "@/features/attribution/AttributionOverrideMenu";
import {
  saveAuthorshipSpans,
  loadAuthorshipSpans,
  spansToMarkData,
} from "@/features/attribution/api";
import type { ToolbarSlot } from "@/features/editor/Toolbar";
import { VerticalPreview } from "@/features/editor/VerticalPreview";

export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const prevSceneIdRef = useRef(activeSceneId);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const [charCount, setCharCount] = useState(0);

  const saveSceneIdRef = useRef(activeSceneId);

  const saveFn = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (ed.storage as any).markdown.getMarkdown() as string;
    await saveSceneContent(id, md);
    await saveAuthorshipSpans(id, ed.state.doc);
  }, []);

  const { schedule, cancel, flush } = useAutoSave(saveFn, 2000);

  const insertFromSnippet = useEditorStore((s) => s.insertFromSnippet);

  const editor = useEditor({
    extensions: getEditorExtensions(),
    content: "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
      handleDrop(_view, event) {
        const snippetData = event.dataTransfer?.getData(
          "application/x-noveloom-snippet",
        );
        if (!snippetData) return false;
        event.preventDefault();
        try {
          const { id, content } = JSON.parse(snippetData) as {
            id: number;
            content: string;
          };
          insertFromSnippet(content, id);
          return true;
        } catch {
          return false;
        }
      },
    },
    onUpdate({ editor: e }) {
      schedule();
      setCharCount(e.state.doc.textContent.length);
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

  // Insert highlight decoration (Task 2.4)
  useInsertHighlight(editor);

  // Codex name highlighting (Task 3.6)
  useCodexHighlight(editor);

  // Typewriter cursor effect
  const cursorAnimation = useCursorSettingsStore((s) => s.cursorAnimation);
  const toggleCursorAnimation = useCursorSettingsStore(
    (s) => s.toggleCursorAnimation,
  );
  useCursorEffect(editor, cursorAnimation);

  // Attribution visualization (Task 4.2)
  useAttribution(editor);
  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const toggleAttribution = useAttributionStore((s) => s.toggleAttribution);

  const cursorAnimationSlot: ToolbarSlot = {
    key: "cursor-animation-toggle",
    render: () => (
      <button
        type="button"
        aria-label="カーソルアニメーション"
        className={cursorAnimation ? "bg-muted" : ""}
        onClick={toggleCursorAnimation}
      >
        カーソル
      </button>
    ),
  };

  const attributionSlot: ToolbarSlot = {
    key: "attribution-toggle",
    render: () => (
      <button
        type="button"
        aria-label="帰属表示"
        className={showAttribution ? "bg-muted" : ""}
        onClick={toggleAttribution}
      >
        帰属
      </button>
    ),
  };

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
      setCharCount(editor!.state.doc.textContent.length);

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
        extraSlots={[cursorAnimationSlot, attributionSlot]}
      />
      <div className="flex-1 overflow-auto p-4">
        <EditorContent editor={editor} />
        <CodexPopover editor={editor} />
        <AttributionOverrideMenu editor={editor} />
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-1">
        <CharCount count={charCount} />
        <VerticalPreview />
      </div>
    </div>
  );
}
