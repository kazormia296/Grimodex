import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface ToolbarSlot {
  key: string;
  render: (editor: Editor) => ReactNode;
}

interface ToolbarButtonProps {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}

function ToolbarButton({ active, onClick, label, children, disabled }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 min-w-[24px] items-center justify-center rounded px-1 text-xs font-medium transition-colors",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="mx-0.5 h-4 w-px bg-border" />;
}

interface ToolbarProps {
  editor: Editor | null;
  extraSlots?: ToolbarSlot[];
}

export function Toolbar({ editor, extraSlots }: ToolbarProps) {
  if (!editor) return null;

  return (
    <div className="flex flex-shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      {/* Format group */}
      <ToolbarButton
        label="太字 (Ctrl+B)"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <strong>B</strong>
      </ToolbarButton>
      <ToolbarButton
        label="斜体 (Ctrl+I)"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        label="下線 (Ctrl+U)"
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <span className="underline">U</span>
      </ToolbarButton>
      <ToolbarButton
        label="打ち消し線"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <span className="line-through">S</span>
      </ToolbarButton>
      <ToolbarButton
        label="傍点 (Ctrl+.)"
        active={editor.isActive("emphasisDots")}
        onClick={() => editor.chain().focus().toggleMark("emphasisDots").run()}
      >
        ﹅
      </ToolbarButton>

      <Separator />

      {/* Heading group */}
      <ToolbarButton
        label="見出し 1"
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        label="見出し 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        label="見出し 3"
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </ToolbarButton>

      <Separator />

      {/* List / Quote group */}
      <ToolbarButton
        label="箇条書き"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        •
      </ToolbarButton>
      <ToolbarButton
        label="番号付きリスト"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        1.
      </ToolbarButton>
      <ToolbarButton
        label="引用"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        ❝
      </ToolbarButton>

      <Separator />

      {/* Novel-specific group */}
      <ToolbarButton
        label="シーン区切り (* * *)"
        onClick={() => editor.chain().focus().insertSceneBreak().run()}
      >
        —
      </ToolbarButton>

      {/* Extra slots (right-aligned) */}
      {extraSlots && extraSlots.length > 0 && (
        <>
          <Separator />
          {extraSlots.map((slot) => (
            <span key={slot.key}>{slot.render(editor)}</span>
          ))}
        </>
      )}
    </div>
  );
}
