import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Toolbar } from "@/features/editor/Toolbar";
import { CharCount } from "@/features/editor/CharCount";
import { useSceneStore } from "./store";

export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const scenes = useSceneStore((s) => s.scenes);
  const updateSceneContent = useSceneStore((s) => s.updateSceneContent);

  const activeScene = scenes.find((s) => s.id === activeSceneId);
  const prevSceneIdRef = useRef(activeSceneId);

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: activeScene?.content ?? "",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate({ editor: e }) {
      const html = e.getHTML();
      const currentId = useSceneStore.getState().activeSceneId;
      updateSceneContent(currentId, html);
    },
  });

  useEffect(() => {
    if (!editor || activeSceneId === prevSceneIdRef.current) return;

    // Save current content before switching
    const prevId = prevSceneIdRef.current;
    const prevContent = editor.getHTML();
    updateSceneContent(prevId, prevContent);

    // Load new scene content
    const newScene = useSceneStore
      .getState()
      .scenes.find((s) => s.id === activeSceneId);
    editor.commands.setContent(newScene?.content ?? "");
    prevSceneIdRef.current = activeSceneId;
  }, [activeSceneId, editor, updateSceneContent]);

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
