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
      title={label}
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
  const overflowBtnRef = useRef<HTMLDivElement>(null);
  const overflowDropdownRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const [rightGroupWidth, setRightGroupWidth] = useState(0);

  const { showAttribution, toggleAttribution } = useAttributionStore();
  const {
    focusMode,
    toggleFocusMode,
    typewriterMode,
    toggleTypewriterMode,
    showComments,
    toggleShowComments,
  } = useCursorSettingsStore();

  // Force re-render when editor selection/state changes so isActive() is accurate
  const [, setEditorTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => setEditorTick((t) => t + 1);
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  // Measure right group width so left scroll area can reserve space
  useEffect(() => {
    const el = rightGroupRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setRightGroupWidth(el.offsetWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!overflowOpen) return;
    function close(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !overflowBtnRef.current?.contains(target) &&
        !overflowDropdownRef.current?.contains(target)
      )
        setOverflowOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [overflowOpen]);

  if (!editor) return null;

  function openRuby() {
    if (!editor) return;
    if (editor.isActive("ruby")) {
      const attrs = editor.getAttributes("ruby");
      setRubyBase((attrs.base as string) ?? "");
      setRubyAnnotation((attrs.annotation as string) ?? "");
    } else {
      const { from, to } = editor.state.selection;
      setRubyBase(editor.state.doc.textBetween(from, to));
      setRubyAnnotation("");
    }
    setRubyOpen(true);
    setLinkOpen(false);
  }

  function applyRuby() {
    if (!rubyBase || !editor) return;
    editor.chain().focus().setRuby(rubyBase, rubyAnnotation).run();
    setRubyOpen(false);
  }

  function openLink() {
    if (!editor) return;
    setLinkUrl((editor.getAttributes("link").href as string) ?? "");
    setLinkOpen(true);
    setRubyOpen(false);
  }

  function applyLink() {
    if (!editor) return;
    if (linkUrl === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().setLink({ href: linkUrl }).run();
    setLinkOpen(false);
  }

  function insertHorizontalRule() {
    if (!editor) return;
    const { $from, empty } = editor.state.selection;
    if (empty) {
      const parent = $from.node($from.depth);
      const idx = $from.index($from.depth);
      const prevSib = idx > 0 ? parent.child(idx - 1) : null;
      if (prevSib?.type.name === "horizontalRule") return;
    }
    editor.chain().focus().setHorizontalRule().run();
  }

  return (
    <div className="relative flex-shrink-0 border-b border-border">
      {/* Toolbar content area — overflow-hidden clips at panel width */}
      <div className="relative overflow-hidden">
        {/* Scrollable format buttons — right padding reserves space for the right group */}
        <div
          className="no-scrollbar overflow-x-auto"
          style={{ paddingRight: rightGroupWidth }}
        >
          <div className="flex w-max items-center gap-0.5 px-1.5 py-1">
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
              onClick={() =>
                editor.chain().focus().toggleMark("emphasisDots").run()
              }
            >
              ﹅
            </ToolbarButton>
            <Sep />
            {/* G2: ブロックフォーマット */}
            <ToolbarButton
              label="見出し 1 (Ctrl+1)"
              active={editor.isActive("heading", { level: 1 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 1 }).run()
              }
            >
              H1
            </ToolbarButton>
            <ToolbarButton
              label="見出し 2 (Ctrl+2)"
              active={editor.isActive("heading", { level: 2 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run()
              }
            >
              H2
            </ToolbarButton>
            <ToolbarButton
              label="見出し 3 (Ctrl+3)"
              active={editor.isActive("heading", { level: 3 })}
              onClick={() =>
                editor.chain().focus().toggleHeading({ level: 3 }).run()
              }
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
              label="引用 (ブロッククォート)"
              active={editor.isActive("blockquote")}
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
            >
              ❝
            </ToolbarButton>
            <ToolbarButton label="水平線" onClick={insertHorizontalRule}>
              —
            </ToolbarButton>
            <Sep />
            {/* G4: 小説固有 */}
            <ToolbarButton
              label="ルビ（ふりがな）"
              active={rubyOpen || editor.isActive("ruby")}
              onClick={openRuby}
            >
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
          </div>
        </div>

        {/* Right group: absolutely positioned at right edge, opaque background */}
        <div
          ref={rightGroupRef}
          className="absolute inset-y-0 right-0 flex items-center gap-0.5 border-l border-border bg-background px-1.5"
        >
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
            onClick={toggleTypewriterMode}
          >
            TW
          </ToolbarButton>
          <Sep />
          <div ref={overflowBtnRef}>
            <ToolbarButton
              label="その他のオプション"
              active={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
            >
              ⋮
            </ToolbarButton>
          </div>
        </div>
      </div>

      {/* Ruby入力ポップオーバー — outside overflow-hidden wrapper */}
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

      {/* オーバーフロードロップダウン */}
      {overflowOpen && (
        <div
          ref={overflowDropdownRef}
          className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-border bg-background py-1 shadow-md"
        >
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
