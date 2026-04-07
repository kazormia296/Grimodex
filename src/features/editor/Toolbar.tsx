import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useSettingNumber } from "@/features/settings/useSettingControl";

function ToolbarButton({
  active,
  onClick,
  label,
  children,
  disabled,
  allowFocus,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  allowFocus?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={allowFocus ? undefined : (e) => e.preventDefault()}
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
  const [rubyPos, setRubyPos] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const overflowBtnRef = useRef<HTMLDivElement>(null);
  const overflowDropdownRef = useRef<HTMLDivElement>(null);
  const fontSizeBtnRef = useRef<HTMLDivElement>(null);
  const fontSizeDropdownRef = useRef<HTMLDivElement>(null);
  const rightGroupRef = useRef<HTMLDivElement>(null);
  const [rightGroupWidth, setRightGroupWidth] = useState(0);

  // Overflow detection: measure each button unit, hide those that don't fit
  const innerRef = useRef<HTMLDivElement>(null);
  const unit1Ref = useRef<HTMLDivElement>(null); // G1: B I U S ﹅
  const unit2Ref = useRef<HTMLDivElement>(null); // Sep + G2: H1 H2 H3
  const unit3Ref = useRef<HTMLDivElement>(null); // Sep + G3: ≡ 1. ❝ —
  const unit4Ref = useRef<HTMLDivElement>(null); // Sep + G4: Ruby Link * * *
  const unitWidths = useRef<number[]>([]);
  const [visibleUnitCount, setVisibleUnitCount] = useState(4);

  const { value: fontSize, setValue: setFontSize } = useSettingNumber(
    "editor.fontSize",
    18,
  );

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

  // Measure right group width so overflow calculation can account for it
  useEffect(() => {
    const el = rightGroupRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setRightGroupWidth(el.offsetWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Measure each button unit's width once after initial render (all units visible)
  useLayoutEffect(() => {
    unitWidths.current = [
      unit1Ref.current?.offsetWidth ?? 0,
      unit2Ref.current?.offsetWidth ?? 0,
      unit3Ref.current?.offsetWidth ?? 0,
      unit4Ref.current?.offsetWidth ?? 0,
    ];
  }, []);

  // Recompute how many units fit whenever container or right-group width changes
  useEffect(() => {
    const container = innerRef.current;
    if (!container) return;

    const recompute = () => {
      // Refresh measurements only when all units are currently in the DOM
      if (
        unit1Ref.current &&
        unit2Ref.current &&
        unit3Ref.current &&
        unit4Ref.current
      ) {
        unitWidths.current = [
          unit1Ref.current.offsetWidth,
          unit2Ref.current.offsetWidth,
          unit3Ref.current.offsetWidth,
          unit4Ref.current.offsetWidth,
        ];
      }
      if (!unitWidths.current.some((w) => w > 0)) return;

      // px-1.5 on both sides of the button row = 12px total horizontal padding
      const available = container.offsetWidth - rightGroupWidth - 12;
      if (available <= 0) return;

      let sum = 0;
      let count = 0;
      for (const w of unitWidths.current) {
        if (sum + w <= available) {
          sum += w;
          count++;
        } else {
          break;
        }
      }
      setVisibleUnitCount(count);
    };

    const observer = new ResizeObserver(recompute);
    observer.observe(container);
    recompute();
    return () => observer.disconnect();
  }, [rightGroupWidth]);

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

  useEffect(() => {
    if (!fontSizeOpen) return;
    function close(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !fontSizeBtnRef.current?.contains(target) &&
        !fontSizeDropdownRef.current?.contains(target)
      )
        setFontSizeOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [fontSizeOpen]);

  if (!editor) return null;

  function getSelectionCoords(): { x: number; y: number } | null {
    if (!editor) return null;
    const { from } = editor.state.selection;
    const coords = editor.view.coordsAtPos(from);
    const GAP = 6;
    const x = Math.min(coords.left, window.innerWidth - 320);
    const y = coords.bottom + GAP;
    return { x, y };
  }

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
    setRubyPos(getSelectionCoords());
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
    setLinkPos(getSelectionCoords());
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

  const hasOverflowedButtons = visibleUnitCount < 4;

  return (
    <div className="relative flex-shrink-0 border-b border-border">
      {/* Toolbar content area — overflow-hidden clips at panel width */}
      <div ref={innerRef} className="relative overflow-hidden">
        <div className="flex w-max items-center px-1.5 py-1">
          {/* Unit 1: インラインフォーマット (always in toolbar) */}
          <div ref={unit1Ref} className="flex items-center gap-0.5">
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
          </div>

          {/* Unit 2: ブロックフォーマット */}
          {visibleUnitCount >= 2 && (
            <div ref={unit2Ref} className="flex items-center gap-0.5">
              <Sep />
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
            </div>
          )}

          {/* Unit 3: リスト・引用 */}
          {visibleUnitCount >= 3 && (
            <div ref={unit3Ref} className="flex items-center gap-0.5">
              <Sep />
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
            </div>
          )}

          {/* Unit 4: 小説固有 */}
          {visibleUnitCount >= 4 && (
            <div ref={unit4Ref} className="flex items-center gap-0.5">
              <Sep />
              <ToolbarButton
                label="ルビ（ふりがな）"
                active={rubyOpen || editor.isActive("ruby")}
                onClick={openRuby}
                allowFocus
              >
                Ruby
              </ToolbarButton>
              <ToolbarButton
                label="リンク (Ctrl+K)"
                active={editor.isActive("link") || linkOpen}
                onClick={openLink}
                allowFocus
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
          )}
        </div>

        {/* Right group: absolutely positioned at right edge, opaque background */}
        <div
          ref={rightGroupRef}
          className="absolute inset-y-0 right-0 flex items-center gap-0.5 border-l border-border bg-background px-1.5"
        >
          <div ref={fontSizeBtnRef}>
            <ToolbarButton
              label="文字サイズ"
              active={fontSizeOpen}
              onClick={() => setFontSizeOpen((v) => !v)}
            >
              Aa
            </ToolbarButton>
          </div>
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

      {/* 文字サイズポップオーバー */}
      {fontSizeOpen && (
        <div
          ref={fontSizeDropdownRef}
          className="absolute right-0 top-full z-50 mt-1 rounded border border-border bg-background p-3 shadow-md"
        >
          <div className="flex items-center gap-2">
            <span className="min-w-[2.5rem] text-xs text-muted-foreground">
              {fontSize}px
            </span>
            <input
              type="range"
              min={14}
              max={24}
              step={1}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-28"
            />
          </div>
        </div>
      )}

      {/* オーバーフロードロップダウン */}
      {overflowOpen && (
        <div
          ref={overflowDropdownRef}
          className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-border bg-background py-1 shadow-md"
        >
          {/* ツールバーに収まらないボタン群 */}
          {visibleUnitCount < 2 && (
            <>
              <OverflowItem
                label="見出し 1"
                shortcut="Ctrl+1"
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level: 1 }).run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="見出し 2"
                shortcut="Ctrl+2"
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level: 2 }).run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="見出し 3"
                shortcut="Ctrl+3"
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level: 3 }).run();
                  setOverflowOpen(false);
                }}
              />
            </>
          )}
          {visibleUnitCount < 3 && (
            <>
              <OverflowItem
                label="箇条書き"
                onClick={() => {
                  editor.chain().focus().toggleBulletList().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="番号付きリスト"
                onClick={() => {
                  editor.chain().focus().toggleOrderedList().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="引用 (ブロッククォート)"
                onClick={() => {
                  editor.chain().focus().toggleBlockquote().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="水平線"
                onClick={() => {
                  insertHorizontalRule();
                  setOverflowOpen(false);
                }}
              />
            </>
          )}
          {visibleUnitCount < 4 && (
            <>
              <OverflowItem
                label="ルビ（ふりがな）"
                onClick={() => {
                  openRuby();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="リンク"
                shortcut="Ctrl+K"
                onClick={() => {
                  openLink();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label="シーン区切り (* * *)"
                onClick={() => {
                  editor.chain().focus().insertSceneBreak().run();
                  setOverflowOpen(false);
                }}
              />
            </>
          )}
          {hasOverflowedButtons && (
            <div className="my-1 border-t border-border" />
          )}
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

      {/* Ruby入力ダイアログ — 選択テキスト位置に表示 */}
      {rubyOpen &&
        rubyPos &&
        createPortal(
          <div
            className="fixed z-50 flex items-center gap-1.5 rounded border border-border bg-background p-2 shadow-md"
            style={{ left: rubyPos.x, top: rubyPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              type="text"
              placeholder="ベース"
              value={rubyBase}
              onChange={(e) => setRubyBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyRuby();
                if (e.key === "Escape") setRubyOpen(false);
              }}
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
          </div>,
          document.body,
        )}

      {/* Link入力ダイアログ — 選択テキスト位置に表示 */}
      {linkOpen &&
        linkPos &&
        createPortal(
          <div
            className="fixed z-50 flex items-center gap-1.5 rounded border border-border bg-background p-2 shadow-md"
            style={{ left: linkPos.x, top: linkPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
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
          </div>,
          document.body,
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
      onMouseDown={(e) => e.preventDefault()}
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
