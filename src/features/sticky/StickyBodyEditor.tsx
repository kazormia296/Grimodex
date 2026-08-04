import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { getStickyEditorExtensions } from "@/features/editor/extensions";
import { useLicenseEditableSync } from "@/features/license/useLicenseEditableSync";
import { parseStickyBody } from "./StickyRichTextBody";

interface StickyBodyEditorProps {
  body: string;
  onContentChange: (body: string) => void;
  onEscape: () => void;
}

export function StickyBodyEditor({
  body,
  onContentChange,
  onEscape,
}: StickyBodyEditorProps) {
  const editor = useEditor({
    extensions: getStickyEditorExtensions(),
    content: parseStickyBody(body),
    onUpdate({ editor: current }) {
      onContentChange(JSON.stringify(current.getJSON()));
    },
  });
  useLicenseEditableSync(editor);

  useEffect(() => {
    if (!editor) return;
    const timer = window.setTimeout(() => editor.commands.focus("end"), 0);
    return () => window.clearTimeout(timer);
  }, [editor]);

  if (!editor) return null;

  return (
    <div
      data-editor-sticky-ignore="true"
      className="sticky-editor"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      <EditorContent editor={editor} />
    </div>
  );
}
