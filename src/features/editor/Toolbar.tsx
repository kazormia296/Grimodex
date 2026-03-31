import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";

export interface ToolbarSlot {
  key: string;
  render: (editor: Editor) => ReactNode;
}

interface ToolbarProps {
  editor: Editor | null;
  extraSlots?: ToolbarSlot[];
}

export function Toolbar({ editor, extraSlots }: ToolbarProps) {
  if (!editor) return null;

  return (
    <div className="flex gap-1 border-b border-border p-1">
      <button
        type="button"
        aria-label="Bold"
        className={editor.isActive("bold") ? "bg-muted" : ""}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        B
      </button>
      <button
        type="button"
        aria-label="Italic"
        className={editor.isActive("italic") ? "bg-muted" : ""}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        I
      </button>
      <button
        type="button"
        aria-label="Heading"
        className={editor.isActive("heading") ? "bg-muted" : ""}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H
      </button>
      <button
        type="button"
        aria-label="List"
        className={editor.isActive("bulletList") ? "bg-muted" : ""}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        List
      </button>
      {extraSlots?.map((slot) => (
        <span key={slot.key}>{slot.render(editor)}</span>
      ))}
    </div>
  );
}
