import { useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Toolbar } from "./Toolbar";
import { CharCount } from "./CharCount";

export function EditorPanel() {
  const [markdownOutput, setMarkdownOutput] = useState<string | null>(null);
  const [charCount, setCharCount] = useState(0);

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate({ editor: e }) {
      setCharCount(e.state.doc.textContent.length);
    },
  });

  const handleExport = useCallback(() => {
    if (!editor) return;
    const storage = editor.storage as unknown as { markdown: MarkdownStorage };
    const md = storage.markdown.getMarkdown();
    setMarkdownOutput(md);
  }, [editor]);

  return (
    <div className="flex flex-col h-full">
      <Toolbar editor={editor} />
      <div className="flex-1 overflow-auto p-4">
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center justify-between border-t border-border px-4 py-1">
        <CharCount count={charCount} />
        <button type="button" aria-label="Export" onClick={handleExport}>
          Export
        </button>
      </div>
      {markdownOutput !== null && (
        <pre data-testid="markdown-output" className="p-2 text-sm">
          {markdownOutput}
        </pre>
      )}
    </div>
  );
}
