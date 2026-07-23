import {
  ArrowUpDown,
  Bold,
  BookOpen,
  Brackets,
  Check,
  EllipsisVertical,
  Focus,
  Maximize2,
  Hash,
  Italic,
  Keyboard,
  Layers,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  PanelRight,
  Pilcrow,
  Quote,
  Search,
  Sparkles,
  SpellCheck,
  Strikethrough,
  TextQuote,
  TextSelect,
  Underline,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatShortcut, isMac } from "@/lib/platform";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { LayersPopover } from "@/features/editor/LayersPopover";
import {
  useSettingBoolean,
  useSettingNumber,
} from "@/features/settings/useSettingControl";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useLayerAutoFollow } from "@/features/editor/useLayerAutoFollow";
import { useCurrentProject } from "@/features/project/projectStore";
import { primaryCountUnit } from "@/features/editor/charCountStats";
import { useCodexStore } from "@/features/codex/codexStore";
import { resolveReadingForSurface } from "@/features/codex/reading";
import { useCodexReadingRegistrationPrompt } from "@/features/editor/useCodexReadingRegistrationPrompt";
import { onWindowResized } from "@/lib/windowControls";

function ToolbarButton({
  active,
  onClick,
  label,
  children,
  disabled,
  allowFocus,
  ariaHasPopup,
  ariaExpanded,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  allowFocus?: boolean;
  ariaHasPopup?: React.AriaAttributes["aria-haspopup"];
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
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
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

export interface ToolbarActions {
  openLink: () => void;
  openRuby: () => void;
}

interface ToolbarProps {
  editor: Editor | null;
  onFindReplace: () => void;
  actionsRef?: React.RefObject<ToolbarActions | null>;
  panelOpen?: boolean;
  onTogglePanel?: () => void;
  sceneId?: string;
  nodeType?: string;
  reorderOpen?: boolean;
  onToggleReorder?: () => void;
  reorderDisabled?: boolean;
}

/**
 * 自動ルビへ安全に渡せる単一 textblock 内の平文選択だけを返す。
 * textBetween は hardBreak / ruby 等の leaf を省略するため、それだけで照合すると
 * 見た目が異なる範囲を Codex 表記として即時置換してしまう。
 */
function getAutoRubySurface(editor: Editor): string | null {
  const { from, to, empty, $from, $to } = editor.state.selection;
  if (empty || !$from.sameParent($to) || !$from.parent.isTextblock) return null;

  let hasNonTextInline = false;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) {
      hasNonTextInline = true;
      return false;
    }
  });
  if (hasNonTextInline) return null;

  return editor.state.doc.textBetween(from, to);
}

export function Toolbar({
  editor,
  onFindReplace,
  actionsRef,
  panelOpen,
  onTogglePanel,
  sceneId,
  nodeType,
  reorderOpen,
  onToggleReorder,
  reorderDisabled,
}: ToolbarProps) {
  const [rubyOpen, setRubyOpen] = useState(false);
  const [rubyBase, setRubyBase] = useState("");
  const [rubyAnnotation, setRubyAnnotation] = useState("");
  const [rubyFocusAnnotation, setRubyFocusAnnotation] = useState(false);
  const [rubyPos, setRubyPos] = useState<{ x: number; y: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkPos, setLinkPos] = useState<{ x: number; y: number } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const { t } = useTranslation();
  const promptCodexReadingRegistration = useCodexReadingRegistrationPrompt();
  const overflowBtnRef = useRef<HTMLDivElement>(null);
  const overflowDropdownRef = useRef<HTMLDivElement>(null);
  const fontSizeBtnRef = useRef<HTMLDivElement>(null);
  const fontSizeDropdownRef = useRef<HTMLDivElement>(null);
  const layersBtnRef = useRef<HTMLDivElement>(null);
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
  const { value: lineHeight, setValue: setLineHeight } = useSettingNumber(
    "editor.lineHeight",
    2.0,
  );
  const { value: maxContentWidth, setValue: setMaxContentWidth } =
    useSettingNumber("editor.maxContentWidth", 720);
  const { value: paragraphSpacing, setValue: setParagraphSpacing } =
    useSettingNumber("editor.paragraphSpacing", 8);

  const { value: spellCheck, setValue: setSpellCheck } = useSettingBoolean(
    "editor.spellCheck",
    false,
  );
  const { value: smartQuotes, setValue: setSmartQuotes } = useSettingBoolean(
    "editor.smartQuotes",
    false,
  );
  const { value: smartDashes, setValue: setSmartDashes } = useSettingBoolean(
    "editor.smartDashes",
    false,
  );
  const { value: bubbleMenu, setValue: setBubbleMenu } = useSettingBoolean(
    "editor.bubbleMenu",
    true,
  );
  const { value: aozoraInput, setValue: setAozoraInput } = useSettingBoolean(
    "editor.aozoraInput",
    true,
  );
  const { value: autoPairBrackets, setValue: setAutoPairBrackets } =
    useSettingBoolean("editor.autoPairBrackets", true);
  const { value: showInvisibles, setValue: setShowInvisibles } =
    useSettingBoolean("editor.showInvisibles", false);
  const { value: inlineAiCommand, setValue: setInlineAiCommand } =
    useSettingBoolean("editor.inlineAiCommand", true);

  const { value: targetCharCount, setValue: setTargetCharCount } =
    useSettingNumber("editor.targetCharCount", 0);
  // 目標値ラベルの単位語は一次メトリクス (= PROJECT 言語) に従う。フッタの
  // 目標行 (EditorStatsFooter) と単位を一致させる (同じ targetCharCount 値)。
  const targetUnit = primaryCountUnit(useCurrentProject()?.language);

  const { value: showLineNumbers, setValue: setShowLineNumbers } =
    useSettingBoolean("editor.showLineNumbers", false);
  const { value: verticalMode, setValue: setVerticalMode } = useSettingBoolean(
    "editor.verticalMode",
    false,
  );

  const showAttribution = useAttributionStore((s) => s.showAttribution);
  const {
    focusMode,
    toggleFocusMode,
    typewriterMode,
    toggleTypewriterMode,
    zenMode,
    toggleZenMode,
    fullscreenMode,
    syncFullscreenMode,
    toggleFullscreenMode,
    showComments,
    showForeshadowMarks,
    showLint,
  } = useCursorSettingsStore();
  const showAnnotations = useAnnotationStore((s) => s.showAnnotations);
  const showReaderComments = useAnnotationStore((s) => s.showReaderComments);

  useEffect(() => {
    let disposed = false;
    let unlistenNative: (() => void) | undefined;
    const sync = () => {
      void syncFullscreenMode();
    };
    sync();
    document.addEventListener("fullscreenchange", sync);
    void onWindowResized(sync)
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNative = unlisten;
      })
      .catch(() => {
        // Web Editor has no native window bridge; fullscreenchange covers it.
      });
    return () => {
      disposed = true;
      document.removeEventListener("fullscreenchange", sync);
      unlistenNative?.();
    };
  }, [syncFullscreenMode]);

  // パネル連動 (Auto) モード: layerAutoFollow ON の間、パネル可視状態に
  // レイヤー表示を追従させる。Toolbar はエディタごとに1つなので、split view
  // でも各エディタが自分の rebuild meta を受け取る。
  useLayerAutoFollow(editor);

  // isActive 系のボタン状態だけを selector で抽出する。useEditorState は
  // deepEqual 比較なので、フラグが実際に変わったときだけ Toolbar が再レンダー
  // される。旧実装（transaction/selectionUpdate ごとに tick state を進める）は
  // 平文タイピング中も毎キーストロークで 862 行の full re-render を起こしていた。
  // 注意: editor が null→非null に変わった直後は最初の transaction まで
  // active が初期値のまま（EditorPane は空 content でマウント→即 setContent
  // が transaction を出すため実害なし。非空 content マウントを導入するなら要再検証）。
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            emphasisDots: e.isActive("emphasisDots"),
            heading1: e.isActive("heading", { level: 1 }),
            heading2: e.isActive("heading", { level: 2 }),
            heading3: e.isActive("heading", { level: 3 }),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            blockquote: e.isActive("blockquote"),
            ruby: e.isActive("ruby"),
            link: e.isActive("link"),
          }
        : null,
  });

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

  // Overflow メニュー: 開いたら最初の項目へフォーカス (menu パターン)。
  useEffect(() => {
    if (!overflowOpen) return;
    overflowDropdownRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled)")
      ?.focus();
  }, [overflowOpen]);

  function closeOverflowAndRestoreFocus() {
    setOverflowOpen(false);
    overflowBtnRef.current?.querySelector("button")?.focus();
  }

  function handleOverflowMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeOverflowAndRestoreFocus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // number input 内では矢印キーの値増減 (native 挙動) を優先する。
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = Array.from(
      overflowDropdownRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input",
      ) ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next =
      idx === -1
        ? items[e.key === "ArrowDown" ? 0 : items.length - 1]
        : items[
            (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length
          ];
    next?.focus();
  }

  if (!editor) return null;

  // Register imperative handles so EditorPane can trigger dialogs via keyboard shortcuts.
  if (actionsRef) actionsRef.current = { openLink, openRuby };

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
      setRubyFocusAnnotation(false);
    } else {
      const { from, to } = editor.state.selection;
      const selected = editor.state.doc.textBetween(from, to);
      const autoRubySurface = getAutoRubySurface(editor);
      const codexReading = autoRubySurface
        ? resolveReadingForSurface(
            autoRubySurface,
            useCodexStore.getState().completionTargets,
          )
        : null;
      if (autoRubySurface && codexReading) {
        editor.chain().focus().setRuby(autoRubySurface, codexReading).run();
        setRubyOpen(false);
        setLinkOpen(false);
        return;
      }
      setRubyBase(selected);
      setRubyAnnotation("");
      // When text is pre-selected, base is already filled → focus annotation field.
      setRubyFocusAnnotation(selected.length > 0);
    }
    setRubyPos(getSelectionCoords());
    setRubyOpen(true);
    setLinkOpen(false);
  }

  function applyRuby() {
    if (!rubyBase || !editor) return;
    const applied = editor
      .chain()
      .focus()
      .setRuby(rubyBase, rubyAnnotation)
      .run();
    setRubyOpen(false);
    if (applied) promptCodexReadingRegistration(rubyBase, rubyAnnotation);
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

  // レイヤーボタンの状態ドット: ON のレイヤーのチャネル色を並べる
  // (Codex は常時系なのでドットに含めない)。順序はポップオーバーの行順に揃える。
  const layerDots: string[] = [];
  if (showAttribution) layerDots.push("var(--attribution-ai)");
  if (showComments) layerDots.push("var(--deco-comment)");
  if (sceneId && nodeType === "scene" && showReaderComments)
    layerDots.push("var(--deco-reader-comment)");
  if (showForeshadowMarks) layerDots.push("var(--deco-foreshadow-setup)");
  // 校閲の指摘 (校閲+Lint 統合レイヤー) は1ドット
  if ((sceneId && nodeType === "scene" && showAnnotations) || showLint)
    layerDots.push("var(--deco-issue-warning)");

  if (zenMode) return null;

  return (
    <div
      role="toolbar"
      aria-label={t("editor.toolbar.label")}
      className="glass-editor-chrome relative flex-shrink-0 border-b border-border"
    >
      {/* Toolbar content area — overflow-hidden clips at panel width */}
      <div ref={innerRef} className="relative overflow-hidden">
        <div className="flex w-max items-center px-1.5 py-1">
          {/* Unit 1: インラインフォーマット (always in toolbar) */}
          <div ref={unit1Ref} className="flex items-center gap-0.5">
            <ToolbarButton
              label={t("editor.toolbar.bold")}
              active={active?.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold size={14} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.italic")}
              active={active?.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic size={14} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.underline")}
              active={active?.underline}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            >
              <Underline size={14} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.strikethrough")}
              active={active?.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={14} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.emphasisDots")}
              active={active?.emphasisDots}
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
                label={t("editor.toolbar.heading1")}
                active={active?.heading1}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 1 }).run()
                }
              >
                H1
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.heading2")}
                active={active?.heading2}
                onClick={() =>
                  editor.chain().focus().toggleHeading({ level: 2 }).run()
                }
              >
                H2
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.heading3")}
                active={active?.heading3}
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
                label={t("editor.toolbar.bulletList")}
                active={active?.bulletList}
                onClick={() => editor.chain().focus().toggleBulletList().run()}
              >
                <List size={14} />
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.orderedList")}
                active={active?.orderedList}
                onClick={() => editor.chain().focus().toggleOrderedList().run()}
              >
                <ListOrdered size={14} />
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.blockquote")}
                active={active?.blockquote}
                onClick={() => editor.chain().focus().toggleBlockquote().run()}
              >
                <TextQuote size={14} />
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.horizontalRule")}
                onClick={insertHorizontalRule}
              >
                <Minus size={14} />
              </ToolbarButton>
            </div>
          )}

          {/* Unit 4: 小説固有 */}
          {visibleUnitCount >= 4 && (
            <div ref={unit4Ref} className="flex items-center gap-0.5">
              <Sep />
              <ToolbarButton
                label={t("editor.toolbar.ruby")}
                active={rubyOpen || !!active?.ruby}
                onClick={openRuby}
                allowFocus
              >
                {/* ふり仮名の2段グリフ — 日本語固有機能はアイコン化せず
                    文字のまま (デザイン 1a) */}
                <span className="flex flex-col items-center leading-none">
                  <span className="text-[6.5px] tracking-wide text-muted-foreground">
                    ふり
                  </span>
                  <span className="text-[10px] font-semibold">仮名</span>
                </span>
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.link")}
                active={!!active?.link || linkOpen}
                onClick={openLink}
                allowFocus
              >
                <LinkIcon size={13} />
              </ToolbarButton>
              <ToolbarButton
                label={t("editor.toolbar.sceneBreak")}
                onClick={() => editor.chain().focus().insertSceneBreak().run()}
              >
                {/* シーン区切りのグリフアイコン — 本文中の「* * *」と1対1で
                    対応するアスタリスク3連 (旧: 線+極小ドットは判読不能だった) */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M4 9v6" />
                  <path d="M1.4 10.5 6.6 13.5" />
                  <path d="M1.4 13.5 6.6 10.5" />
                  <path d="M12 9v6" />
                  <path d="M9.4 10.5 14.6 13.5" />
                  <path d="M9.4 13.5 14.6 10.5" />
                  <path d="M20 9v6" />
                  <path d="M17.4 10.5 22.6 13.5" />
                  <path d="M17.4 13.5 22.6 10.5" />
                </svg>
              </ToolbarButton>
            </div>
          )}
        </div>

        {/* Right group: translucent over an active editor background. */}
        <div
          ref={rightGroupRef}
          className="editor-background-glass absolute inset-y-0 right-0 flex items-center gap-0.5 border-l border-border px-1.5"
        >
          {/* Editor settings: 文字サイズ */}
          <div ref={fontSizeBtnRef}>
            <ToolbarButton
              label={t("editor.toolbar.fontSize")}
              active={fontSizeOpen}
              onClick={() => setFontSizeOpen((v) => !v)}
            >
              Aa
            </ToolbarButton>
          </div>
          {/* 表示モードセグメント: 集中 / タイプライター / 縦書き */}
          <div className="flex items-center gap-px rounded-md border border-border bg-muted/30 p-0.5">
            <ToolbarButton
              label={t("editor.toolbar.zenMode")}
              active={zenMode}
              onClick={toggleZenMode}
            >
              Zen
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.fullscreenMode")}
              active={fullscreenMode}
              onClick={toggleFullscreenMode}
            >
              <Maximize2 size={13} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.focusMode")}
              active={focusMode}
              onClick={toggleFocusMode}
            >
              <Focus size={13} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.typewriterMode")}
              active={typewriterMode}
              onClick={toggleTypewriterMode}
              disabled={verticalMode}
            >
              <Keyboard size={13} />
            </ToolbarButton>
            <ToolbarButton
              label={t("editor.toolbar.verticalMode")}
              active={verticalMode}
              onClick={() => setVerticalMode(!verticalMode)}
            >
              縦
            </ToolbarButton>
          </div>
          {onToggleReorder !== undefined && (
            <ToolbarButton
              label={t("editor.toolbar.reorderMode")}
              active={reorderOpen ?? false}
              disabled={reorderDisabled}
              onClick={onToggleReorder}
            >
              <ArrowUpDown size={13} />
            </ToolbarButton>
          )}
          {/* 本文レイヤー: 旧 Attr/Cmt/Fs/Rv 個別トグルを1ボタン+ポップオーバーに集約 */}
          <div ref={layersBtnRef}>
            <ToolbarButton
              label={t("editor.toolbar.layers")}
              active={layersOpen}
              ariaHasPopup="dialog"
              ariaExpanded={layersOpen}
              onClick={() => setLayersOpen((v) => !v)}
            >
              <span className="flex items-center gap-1">
                <Layers size={13} />
                <span className="flex items-center gap-[2.5px]">
                  {layerDots.length > 0 ? (
                    layerDots.map((color, i) => (
                      <span
                        key={i}
                        className="h-[5px] w-[5px] rounded-full"
                        style={{ background: color }}
                      />
                    ))
                  ) : (
                    <span className="h-[5px] w-[5px] rounded-full bg-border" />
                  )}
                </span>
              </span>
            </ToolbarButton>
          </div>
          {onTogglePanel !== undefined && (
            <ToolbarButton
              label={t("editor.toolbar.sceneMetaPanel")}
              active={panelOpen ?? false}
              onClick={onTogglePanel}
            >
              <PanelRight size={14} />
            </ToolbarButton>
          )}
          <Sep />
          <div ref={overflowBtnRef}>
            <ToolbarButton
              label={t("editor.toolbar.moreOptions")}
              active={overflowOpen}
              ariaHasPopup="menu"
              ariaExpanded={overflowOpen}
              onClick={() => setOverflowOpen((v) => !v)}
            >
              <EllipsisVertical size={14} />
            </ToolbarButton>
          </div>
        </div>
      </div>

      {/* 本文レイヤーポップオーバー (body へ portal) */}
      <LayersPopover
        editor={editor}
        open={layersOpen}
        onClose={() => setLayersOpen(false)}
        triggerRef={layersBtnRef}
        sceneId={sceneId}
        nodeType={nodeType}
      />

      {/* 文字サイズ・行組みポップオーバー */}
      {fontSizeOpen && (
        <div
          ref={fontSizeDropdownRef}
          className="absolute right-0 top-full z-50 mt-1 w-52 rounded border border-border bg-popover p-3 shadow-md"
        >
          <div className="flex flex-col gap-3">
            <TypographySliderRow
              label={t("settings.editor.fontSize")}
              displayValue={`${fontSize}px`}
              min={14}
              max={24}
              step={1}
              value={fontSize}
              onChange={setFontSize}
            />
            <TypographySliderRow
              label={t("settings.editor.lineHeight")}
              displayValue={lineHeight.toFixed(1)}
              min={1.2}
              max={3.0}
              step={0.1}
              value={lineHeight}
              onChange={setLineHeight}
            />
            <TypographySliderRow
              label={t("settings.editor.maxWidth")}
              displayValue={`${maxContentWidth}px`}
              min={480}
              max={960}
              step={40}
              value={maxContentWidth}
              onChange={setMaxContentWidth}
            />
            <TypographySliderRow
              label={t("settings.editor.paragraphSpacing")}
              displayValue={`${paragraphSpacing}px`}
              min={0}
              max={24}
              step={2}
              value={paragraphSpacing}
              onChange={setParagraphSpacing}
            />
          </div>
        </div>
      )}

      {/* オーバーフロードロップダウン */}
      {overflowOpen && (
        <div
          ref={overflowDropdownRef}
          role="menu"
          tabIndex={-1}
          aria-label={t("editor.toolbar.moreOptions")}
          onKeyDown={handleOverflowMenuKeyDown}
          className="absolute right-0 top-full z-50 mt-1 min-w-[200px] rounded border border-border bg-popover py-1 shadow-md"
        >
          {/* ツールバーに収まらないボタン群 */}
          {visibleUnitCount < 2 && (
            <>
              <OverflowItem
                label={t("editor.toolbar.heading1Short")}
                shortcut="Ctrl+1"
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level: 1 }).run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.heading2Short")}
                shortcut="Ctrl+2"
                onClick={() => {
                  editor.chain().focus().toggleHeading({ level: 2 }).run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.heading3Short")}
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
                label={t("editor.toolbar.bulletList")}
                onClick={() => {
                  editor.chain().focus().toggleBulletList().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.orderedList")}
                onClick={() => {
                  editor.chain().focus().toggleOrderedList().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.blockquote")}
                onClick={() => {
                  editor.chain().focus().toggleBlockquote().run();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.horizontalRule")}
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
                label={t("editor.toolbar.rubyShort")}
                onClick={() => {
                  openRuby();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.linkShort")}
                shortcut="Ctrl+K"
                onClick={() => {
                  openLink();
                  setOverflowOpen(false);
                }}
              />
              <OverflowItem
                label={t("editor.toolbar.sceneBreak")}
                onClick={() => {
                  editor.chain().focus().insertSceneBreak().run();
                  setOverflowOpen(false);
                }}
              />
            </>
          )}
          {hasOverflowedButtons && (
            <div aria-hidden className="my-1 border-t border-border" />
          )}
          <OverflowItem
            label={t("editor.toolbar.findReplace")}
            icon={Search}
            // Ctrl+H is Windows/Linux only — ⌘H is macOS "Hide", so no Mac hint.
            shortcut={isMac() ? undefined : "Ctrl+H"}
            onClick={() => {
              onFindReplace();
              setOverflowOpen(false);
            }}
          />
          <div className="flex items-center justify-between px-3 py-1 text-xs text-foreground">
            <span>
              {t(
                targetUnit === "word"
                  ? "editor.toolbar.targetWordCount"
                  : "editor.toolbar.targetCharCount",
              )}
            </span>
            <input
              type="number"
              min={0}
              aria-label={t(
                targetUnit === "word"
                  ? "editor.toolbar.targetWordCount"
                  : "editor.toolbar.targetCharCount",
              )}
              value={targetCharCount === 0 ? "" : targetCharCount}
              placeholder="0"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                setTargetCharCount(isNaN(v) || v < 0 ? 0 : v);
              }}
              className="ml-2 w-20 rounded border border-input bg-background px-1.5 py-0.5 text-right tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div aria-hidden className="my-1 border-t border-border" />
          <OverflowItem
            label={t("editor.toolbar.showLineNumbers")}
            icon={Hash}
            checked={showLineNumbers}
            onClick={() => setShowLineNumbers(!showLineNumbers)}
          />
          <div aria-hidden className="my-1 border-t border-border" />
          <div
            role="presentation"
            className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t("settings.editor.experience")}
          </div>
          <OverflowItem
            label={t("settings.editor.spellCheck")}
            icon={SpellCheck}
            checked={spellCheck}
            onClick={() => setSpellCheck(!spellCheck)}
          />
          <OverflowItem
            label={t("settings.editor.smartQuotes")}
            icon={Quote}
            checked={smartQuotes}
            onClick={() => setSmartQuotes(!smartQuotes)}
          />
          <OverflowItem
            label={t("settings.editor.smartDashes")}
            icon={Minus}
            checked={smartDashes}
            onClick={() => setSmartDashes(!smartDashes)}
          />
          <OverflowItem
            label={t("settings.editor.bubbleMenu")}
            icon={TextSelect}
            checked={bubbleMenu}
            onClick={() => setBubbleMenu(!bubbleMenu)}
          />
          <OverflowItem
            label={t("settings.editor.aozoraInput")}
            icon={BookOpen}
            checked={aozoraInput}
            onClick={() => setAozoraInput(!aozoraInput)}
          />
          <OverflowItem
            label={t("settings.editor.autoPairBrackets")}
            icon={Brackets}
            checked={autoPairBrackets}
            onClick={() => setAutoPairBrackets(!autoPairBrackets)}
          />
          <OverflowItem
            label={t("settings.editor.showInvisibles")}
            icon={Pilcrow}
            checked={showInvisibles}
            onClick={() => setShowInvisibles(!showInvisibles)}
          />
          <OverflowItem
            label={t("settings.editor.slashCommand")}
            icon={Sparkles}
            checked={inlineAiCommand}
            onClick={() => setInlineAiCommand(!inlineAiCommand)}
          />
        </div>
      )}

      {/* Ruby入力ダイアログ — 選択テキスト位置に表示 */}
      {rubyOpen &&
        rubyPos &&
        createPortal(
          <div
            className="fixed z-50 flex items-center gap-1.5 rounded border border-border bg-popover p-2 shadow-md"
            style={{ left: rubyPos.x, top: rubyPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={!rubyFocusAnnotation}
              type="text"
              placeholder={t("editor.toolbar.rubyBase")}
              value={rubyBase}
              onChange={(e) => setRubyBase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyRuby();
                if (e.key === "Escape") setRubyOpen(false);
              }}
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
            />
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus={rubyFocusAnnotation}
              type="text"
              placeholder={t("editor.toolbar.rubyAnnotation")}
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
              {t("common.ok")}
            </button>
            <button
              type="button"
              onClick={() => setRubyOpen(false)}
              aria-label={t("common.close")}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>,
          document.body,
        )}

      {/* Link入力ダイアログ — 選択テキスト位置に表示 */}
      {linkOpen &&
        linkPos &&
        createPortal(
          <div
            className="fixed z-50 flex items-center gap-1.5 rounded border border-border bg-popover p-2 shadow-md"
            style={{ left: linkPos.x, top: linkPos.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              type="url"
              placeholder={t("editor.toolbar.urlPlaceholder")}
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
              {t("common.ok")}
            </button>
            <button
              type="button"
              onClick={() => setLinkOpen(false)}
              aria-label={t("common.close")}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

function TypographySliderRow({
  label,
  displayValue,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  displayValue: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full"
      />
    </div>
  );
}

function OverflowItem({
  label,
  shortcut,
  onClick,
  disabled,
  checked,
  icon: Icon,
}: {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      role={checked !== undefined ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checked}
      className={cn(
        "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
        disabled
          ? "pointer-events-none text-muted-foreground opacity-50"
          : "text-foreground hover:bg-accent",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {checked !== undefined && (
          <span
            aria-hidden
            className={cn(
              "inline-flex w-3 flex-shrink-0 items-center justify-center",
              checked ? "opacity-100" : "opacity-0",
            )}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
        {Icon && (
          <Icon
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 flex-shrink-0",
              checked === false && "text-muted-foreground",
            )}
            strokeWidth={2}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      {shortcut && (
        <span className="ml-2 flex-shrink-0 text-muted-foreground">
          {formatShortcut(shortcut)}
        </span>
      )}
    </button>
  );
}
