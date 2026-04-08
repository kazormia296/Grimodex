import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { useAttribution } from "@/features/attribution/useAttribution";

interface CodexContentEditorProps {
  content: string;
  onContentChange: (content: string) => void;
}

export function CodexContentEditor({
  content,
  onContentChange,
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

  return (
    <div
      data-testid="codex-content-editor"
      className="min-h-[80px] rounded-md border border-input bg-background px-2 py-1.5 text-sm [&_.ProseMirror]:min-h-[60px] [&_.ProseMirror]:outline-none"
    >
      <EditorContent editor={editor} />
    </div>
  );
}
