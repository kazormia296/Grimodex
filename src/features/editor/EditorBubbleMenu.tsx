import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { useEditorState } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import {
  Bold,
  Flag,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquarePlus,
  Quote,
  Strikethrough,
  Type,
  Underline,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingBoolean } from "@/features/settings/useSettingControl";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { DURATIONS, VARIANTS, useReducedMotion } from "@/lib/animation";
import type { ToolbarActions } from "./Toolbar";

const GAP = 8;
const EDGE = 8;
const EST_HEIGHT = 44;
// 実測前の保守的な見積もり (実幅以上にしておけば初回フレームも画面外に出ない)。
const EST_WIDTH = 560;

interface EditorBubbleMenuProps {
  editor: Editor | null;
  toolbarActionsRef: React.RefObject<ToolbarActions | null>;
}

/** 選択範囲のスクリーン矩形。実 DOM 選択を優先 (複数行・縦書きも実寸で取れる)。 */
function getSelectionRect(editor: Editor): DOMRect | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r && (r.width || r.height || r.top || r.left || r.bottom)) return r;
  }
  // プログラム選択など DOM 選択が無いときは PM 座標から合成する。
  try {
    const { from, to } = editor.state.selection;
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to);
    const left = Math.min(a.left, b.left);
    const right = Math.max(a.right, b.right);
    const top = Math.min(a.top, b.top);
    const bottom = Math.max(a.bottom, b.bottom);
    return new DOMRect(
      left,
      top,
      Math.max(right - left, 1),
      Math.max(bottom - top, 1),
    );
  } catch {
    return null;
  }
}

export interface BubblePosition {
  top: number;
  left: number;
  placeBelow: boolean;
}

/**
 * 選択矩形からツールバーの固定配置を計算する純関数 (DOM 非依存・単体テスト対象)。
 * - 縦: 上に十分な余白が無ければ選択の下へ回す。
 * - 横: translate(-50%) 中央寄せ前提で、メニュー全幅がビューポートに収まるよう
 *   アンカー(center)を実測半幅ぶん内側にクランプする。狭すぎる場合は画面中央。
 */
export function computeBubblePosition(
  rect: DOMRect | null,
  menuWidth: number,
  vw: number,
): BubblePosition {
  if (!rect) return { top: 0, left: 0, placeBelow: false };
  const placeBelow = rect.top < EST_HEIGHT + GAP;
  const top = placeBelow ? rect.bottom + GAP : rect.top - GAP;
  const centerX = rect.left + rect.width / 2;
  const halfW = (menuWidth || EST_WIDTH) / 2;
  const min = halfW + EDGE;
  const max = vw - halfW - EDGE;
  const left = max < min ? vw / 2 : Math.min(Math.max(centerX, min), max);
  return { top, left, placeBelow };
}

function BubbleButton({
  testId,
  label,
  active,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      {...(active !== undefined ? { "aria-pressed": active } : {})}
      // 押下でエディタの選択が外れない (= 直後のコマンドが選択へ効く) よう preventDefault。
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-[28px] items-center justify-center rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * 選択時に本文の上へ浮かぶ書式・構造ツールバー。`/` メニュー (= インライン AI 専用)
 * とは役割を分け、選択に効く操作 (太字/見出し/ルビ/傍点/コメント/伏線 等) を集約する。
 * ルビ/リンクは Toolbar が登録する actionsRef のダイアログを再利用し、コメント/伏線は
 * cursorSettingsStore の picker を開く (どちらも選択を前提とする既存経路)。
 */
export function EditorBubbleMenu({
  editor,
  toolbarActionsRef,
}: EditorBubbleMenuProps) {
  const { t } = useTranslation();
  const { value: enabled } = useSettingBoolean("editor.bubbleMenu", true);
  const reduced = useReducedMotion();
  const [menuWidth, setMenuWidth] = useState(0);
  const [, forceTick] = useState(0);
  // マウント時に実測幅を取り、横クランプに使う (callback ref なので無限更新しない)。
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (node && node.offsetWidth) setMenuWidth(node.offsetWidth);
  }, []);
  // ダイアログ/ピッカーがフォーカスを奪うと editor が blur する → その間は隠す。
  // 初期値 true: 非空選択は基本的にフォーカス操作の結果なので、blur イベントが
  // 来るまでは表示してよい (テスト環境ではフォーカスイベントが無いので表示される)。
  const [hasFocus, setHasFocus] = useState(true);

  // 選択 (from/to/empty) と active 状態を購読。deepEqual なので変化時のみ再描画。
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            from: e.state.selection.from,
            to: e.state.selection.to,
            empty: e.state.selection.empty,
            isNodeSel: e.state.selection instanceof NodeSelection,
            editable: e.isEditable,
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            emphasisDots: e.isActive("emphasisDots"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            bullet: e.isActive("bulletList"),
            ordered: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            ruby: e.isActive("ruby"),
            link: e.isActive("link"),
          }
        : null,
  });

  useEffect(() => {
    if (!editor) return;
    const onFocus = () => setHasFocus(true);
    const onBlur = () => setHasFocus(false);
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => {
      editor.off("focus", onFocus);
      editor.off("blur", onBlur);
    };
  }, [editor]);

  const visible =
    !!editor &&
    enabled &&
    !!state &&
    state.editable &&
    !state.empty &&
    !state.isNodeSel &&
    hasFocus;

  // 表示中はスクロール/リサイズで位置を追従させる。
  useEffect(() => {
    if (!visible) return;
    const onMove = () => forceTick((v) => v + 1);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [visible]);

  if (!visible || !editor || !state) return null;

  const rect = getSelectionRect(editor);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const { top, left, placeBelow } = computeBubblePosition(rect, menuWidth, vw);

  const chain = () => editor.chain().focus();

  return createPortal(
    <div
      style={{
        position: "fixed",
        top,
        left,
        transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
      }}
      className="z-50"
    >
      <motion.div
        ref={measureRef}
        role="toolbar"
        aria-label={t("editor.bubbleMenu.label")}
        initial={reduced ? false : VARIANTS.scaleIn.initial}
        animate={reduced ? undefined : VARIANTS.scaleIn.animate}
        transition={{ duration: reduced ? 0 : DURATIONS.fast }}
        className="flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 shadow-lg"
      >
        <BubbleButton
          testId="bubble-bold"
          label={t("editor.toolbar.bold")}
          active={state.bold}
          onClick={() => chain().toggleBold().run()}
        >
          <Bold className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-italic"
          label={t("editor.toolbar.italic")}
          active={state.italic}
          onClick={() => chain().toggleItalic().run()}
        >
          <Italic className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-underline"
          label={t("editor.toolbar.underline")}
          active={state.underline}
          onClick={() => chain().toggleUnderline().run()}
        >
          <Underline className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-strike"
          label={t("editor.toolbar.strikethrough")}
          active={state.strike}
          onClick={() => chain().toggleStrike().run()}
        >
          <Strikethrough className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-emphasis"
          label={t("editor.toolbar.emphasisDots")}
          active={state.emphasisDots}
          onClick={() => chain().toggleMark("emphasisDots").run()}
        >
          <span className="text-sm leading-none">﹅</span>
        </BubbleButton>

        <Sep />
        <BubbleButton
          testId="bubble-h1"
          label={t("editor.toolbar.heading1")}
          active={state.h1}
          onClick={() => chain().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-h2"
          label={t("editor.toolbar.heading2")}
          active={state.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-h3"
          label={t("editor.toolbar.heading3")}
          active={state.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="h-3.5 w-3.5" />
        </BubbleButton>

        <Sep />
        <BubbleButton
          testId="bubble-bullet"
          label={t("editor.toolbar.bulletList")}
          active={state.bullet}
          onClick={() => chain().toggleBulletList().run()}
        >
          <List className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-ordered"
          label={t("editor.toolbar.orderedList")}
          active={state.ordered}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-quote"
          label={t("editor.toolbar.blockquote")}
          active={state.quote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Quote className="h-3.5 w-3.5" />
        </BubbleButton>

        <Sep />
        <BubbleButton
          testId="bubble-ruby"
          label={t("editor.toolbar.ruby")}
          active={state.ruby}
          onClick={() => toolbarActionsRef.current?.openRuby()}
        >
          <Type className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-link"
          label={t("editor.toolbar.link")}
          active={state.link}
          onClick={() => toolbarActionsRef.current?.openLink()}
        >
          <Link2 className="h-3.5 w-3.5" />
        </BubbleButton>

        <Sep />
        <BubbleButton
          testId="bubble-comment"
          label={t("editor.bubbleMenu.comment")}
          onClick={() =>
            useCursorSettingsStore.getState().setCommentPickerOpen(true)
          }
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </BubbleButton>
        <BubbleButton
          testId="bubble-foreshadow"
          label={t("editor.bubbleMenu.foreshadow")}
          onClick={() =>
            useCursorSettingsStore.getState().setForeshadowPickerOpen(true)
          }
        >
          <Flag className="h-3.5 w-3.5" />
        </BubbleButton>
      </motion.div>
    </div>,
    document.body,
  );
}
