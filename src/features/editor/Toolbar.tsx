import { useState, useRef, useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";

function ToolbarButton({
  active,
  onClick,
  label,
  children,
  disabled,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
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

function Sep() {
  return <div className="mx-0.5 h-4 w-px bg-border" />;
}

interface ToolbarProps {
  editor: Editor | null;
  onFindReplace: () => void;
  onVerticalPreview: () => void;
}

export function Toolbar({
  editor,
  onFindReplace,
  onVerticalPreview,
}: ToolbarProps) {
  const [rubyOpen, setRubyOpen] = useState(false);
  const [rubyBase, setRubyBase] = useState("");
  const [rubyAnnotation, setRubyAnnotation] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  const { showAttribution, toggleAttribution } = useAttributionStore();
  const {
    cursorAnimation: typewriterMode,
    toggleCursorAnimation: toggleTypewriter,
    focusMode,
    toggleFocusMode,
    showComments,
    toggleShowComments,
  } = useCursorSettingsStore();

  useEffect(() => {
    if (!overflowOpen) return;
    function close(e: MouseEvent) {
      if (!overflowRef.current?.contains(e.target as Node))
        setOverflowOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [overflowOpen]);

  if (!editor) return null;

  function openRuby() {
    const { from, to } = editor!.state.selection;
    setRubyBase(editor!.state.doc.textBetween(from, to));
    setRubyAnnotation("");
    setRubyOpen(true);
    setLinkOpen(false);
  }

  function applyRuby() {
    if (!rubyBase) return;
    editor!.chain().focus().setRuby(rubyBase, rubyAnnotation).run();
    setRubyOpen(false);
  }

  function openLink() {
    setLinkUrl((editor!.getAttributes("link").href as string) ?? "");
    setLinkOpen(true);
    setRubyOpen(false);
  }

  function applyLink() {
    if (linkUrl === "") editor!.chain().focus().unsetLink().run();
    else editor!.chain().focus().setLink({ href: linkUrl }).run();
    setLinkOpen(false);
  }

  return (
    <div className="relative flex flex-shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      {/* G1: インラインフォーマット */}
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
        label="取り消し線 (Ctrl+Shift+X)"
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
      <Sep />
      {/* G2: ブロックフォーマット */}
      <ToolbarButton
        label="見出し 1 (Ctrl+1)"
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        label="見出し 2 (Ctrl+2)"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        label="見出し 3 (Ctrl+3)"
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        H3
      </ToolbarButton>
      <Sep />
      {/* G3: リスト・引用 */}
      <ToolbarButton
        label="箇条書き"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        ≡
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
      <ToolbarButton
        label="水平線"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        —
      </ToolbarButton>
      <Sep />
      {/* G4: 小説固有 */}
      <ToolbarButton label="ルビ" active={rubyOpen} onClick={openRuby}>
        Ruby
      </ToolbarButton>
      <ToolbarButton
        label="リンク (Ctrl+K)"
        active={editor.isActive("link") || linkOpen}
        onClick={openLink}
      >
        Link
      </ToolbarButton>
      <ToolbarButton
        label="シーン区切り (* * *)"
        onClick={() => editor.chain().focus().insertSceneBreak().run()}
      >
        * * *
      </ToolbarButton>

      {/* Ruby入力ポップオーバー */}
      {rubyOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 flex items-center gap-1.5 rounded border border-border bg-background p-2 shadow-md">
          <input
            autoFocus
            type="text"
            placeholder="ベース"
            value={rubyBase}
            onChange={(e) => setRubyBase(e.target.value)}
            className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
          />
          <input
            type="text"
            placeholder="ふりがな"
            value={rubyAnnotation}
            onChange={(e) => setRubyAnnotation(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyRuby();
              if (e.key === "Escape") setRubyOpen(false);
            }}
            className="w-24 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
          />
          <button
            type="button"
            onClick={applyRuby}
            className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => setRubyOpen(false)}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {/* Link入力ポップオーバー */}
      {linkOpen && (
        <div className="absolute left-0 top-full z-50 mt-1 flex items-center gap-1.5 rounded border border-border bg-background p-2 shadow-md">
          <input
            autoFocus
            type="url"
            placeholder="https://..."
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyLink();
              if (e.key === "Escape") setLinkOpen(false);
            }}
            className="w-56 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
          />
          <button
            type="button"
            onClick={applyLink}
            className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => setLinkOpen(false)}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
      )}

      {/* スペーサー */}
      <div className="flex-1" />

      {/* G5: ビュートグル（右寄せ） */}
      <ToolbarButton
        label="帰属表示"
        active={showAttribution}
        onClick={toggleAttribution}
      >
        Attr
      </ToolbarButton>
      <ToolbarButton
        label="コメント表示（未実装）"
        active={showComments}
        onClick={toggleShowComments}
        disabled
      >
        Cmt
      </ToolbarButton>
      <ToolbarButton
        label="フォーカスモード"
        active={focusMode}
        onClick={toggleFocusMode}
      >
        Focus
      </ToolbarButton>
      <ToolbarButton
        label="タイプライターモード"
        active={typewriterMode}
        onClick={toggleTypewriter}
      >
        TW
      </ToolbarButton>
      <Sep />

      {/* オーバーフローメニュー */}
      <div ref={overflowRef} className="relative">
        <ToolbarButton
          label="その他のオプション"
          active={overflowOpen}
          onClick={() => setOverflowOpen((v) => !v)}
        >
          ⋮
        </ToolbarButton>
        {overflowOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-border bg-background py-1 shadow-md">
            <OverflowItem
              label="検索と置換"
              shortcut="Ctrl+H"
              onClick={() => {
                onFindReplace();
                setOverflowOpen(false);
              }}
            />
            <OverflowItem label="目標文字数..." disabled />
            <OverflowItem
              label="縦書きプレビュー"
              onClick={() => {
                onVerticalPreview();
                setOverflowOpen(false);
              }}
            />
            <div className="my-1 border-t border-border" />
            <OverflowItem label="ブレッドクラムを表示" disabled />
            <OverflowItem label="行番号を表示" disabled />
          </div>
        )}
      </div>
    </div>
  );
}

function OverflowItem({
  label,
  shortcut,
  onClick,
  disabled,
}: {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
        disabled
          ? "pointer-events-none text-muted-foreground opacity-50"
          : "text-foreground hover:bg-accent",
      )}
    >
      <span>{label}</span>
      {shortcut && (
        <span className="ml-4 text-muted-foreground">{shortcut}</span>
      )}
    </button>
  );
}
