import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";
import { useCodexHighlight } from "@/features/editor/useCodexHighlight";

interface CodexContentEditorProps {
  content: string;
  onContentChange: (content: string) => void;
  entryId?: string;
}

export function CodexContentEditor({
  content,
  onContentChange,
  entryId,
}: CodexContentEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit.configure(), AuthorshipMark],
    content,
    onUpdate: ({ editor: e }) => {
      try {
        onContentChange(JSON.stringify(e.getJSON()));
      } catch {
        // ignore serialization errors
      }
    },
  });

  useAttribution(editor);
  useCodexHighlight(editor, entryId ? [entryId] : []);

  return (
    <div
      data-testid="codex-content-editor"
      className="min-h-[80px] rounded-md border border-input bg-background px-2 py-1.5 text-sm [&_.ProseMirror]:min-h-[60px] [&_.ProseMirror]:outline-none"
    >
      <EditorContent editor={editor} />
    </div>
  );
}
