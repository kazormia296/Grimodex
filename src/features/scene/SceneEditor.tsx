import { useEffect, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Toolbar } from "@/features/editor/Toolbar";
import { CharCount } from "@/features/editor/CharCount";
import { useSceneStore } from "./store";
import { loadSceneContent, saveSceneContent } from "./api";
import { useAutoSave } from "@/hooks/useAutoSave";

export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const prevSceneIdRef = useRef(activeSceneId);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const saveSceneIdRef = useRef(activeSceneId);

  const saveFn = useCallback(async () => {
    const id = saveSceneIdRef.current;
    const ed = editorRef.current;
    if (!id || !ed) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const md = (ed.storage as any).markdown.getMarkdown() as string;
    await saveSceneContent(id, md);
  }, []);

  const { schedule, cancel, flush } = useAutoSave(saveFn, 2000);

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate() {
      schedule();
    },
  });

  // Keep editorRef in sync
  editorRef.current = editor;

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
      prevSceneIdRef.current = activeSceneId;
    }

    switchScene();

    return () => {
      cancelled = true;
    };
  }, [activeSceneId, editor, flush, cancel]);

  const charCount = editor?.state.doc.textContent.length ?? 0;

  return (
    <div className="flex flex-col h-full">
      <Toolbar editor={editor} />
      <div className="flex-1 overflow-auto p-4">
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-1">
        <CharCount count={charCount} />
      </div>
    </div>
  );
}
