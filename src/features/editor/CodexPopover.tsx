import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { Editor, EditorEvents } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { requestOpenInCodex } from "@/features/codex/multiwindow/codexSelectionRouting";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { useResolvedCodexStates } from "@/features/codex/useResolvedCodexStates";
import { useUnrevealedSecretForeshadows } from "@/features/codex/codexSpoilerFlags";

const FALLBACK_TYPE_COLORS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

interface PopoverState {
  visible: boolean;
  x: number;
  y: number;
  entryId: string | null;
  entryLabel: string | null;
}

interface CodexPopoverProps {
  editor?: Editor | null;
  /** DOM要素を直接渡す場合（editor不要のコンテナベースモード） */
  containerEl?: HTMLElement | null;
}

function targetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

/** Explicit author links win when an automatic string-match decoration overlaps. */
function resolveCodexTarget(target: EventTarget | null): Element | null {
  const base = targetElement(target);
  return (
    base?.closest(".codex-semantic-link") ??
    base?.closest(".codex-highlight") ??
    null
  );
}

function isInsideCodexTarget(target: EventTarget | null): boolean {
  const base = targetElement(target);
  return !!(base?.closest(".codex-popover") || resolveCodexTarget(target));
}

export function CodexPopover({ editor, containerEl }: CodexPopoverProps) {
  const entries = useCodexStore((s) => s.entries);
  const completionTargets = useCodexStore((s) => s.completionTargets);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const [popover, setPopover] = useState<PopoverState>({
    visible: false,
    x: 0,
    y: 0,
    entryId: null,
    entryLabel: null,
  });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverStateRef = useRef(popover);
  popoverStateRef.current = popover;
  // Escape で閉じた entry は caret が離れるまで再表示しない
  const suppressedEntryRef = useRef<string | null>(null);

  const showForElement = useCallback((el: Element) => {
    const entryId = el.getAttribute("data-codex-entry-id");
    if (!entryId) return;
    const entryLabel = el.getAttribute("data-codex-entry-label");

    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    const rect = el.getBoundingClientRect();
    setPopover({
      visible: true,
      x: rect.left,
      y: rect.bottom + 4,
      entryId,
      entryLabel,
    });
  }, []);

  const handleMouseOver = useCallback(
    (e: MouseEvent) => {
      const target = resolveCodexTarget(e.target);
      if (!target) return;
      showForElement(target);
    },
    [showForElement],
  );

  // containerEl モードで codex-highlight がフォーカス可能になった場合の
  // キーボード経路（エディタ本文は selectionUpdate 側が担う）
  const handleFocusIn = useCallback(
    (e: FocusEvent) => {
      const target = resolveCodexTarget(e.target);
      if (!target) return;
      showForElement(target);
    },
    [showForElement],
  );

  const handleFocusOut = useCallback((e: FocusEvent) => {
    const target = resolveCodexTarget(e.target);
    if (!target) return;
    if (!isInsideCodexTarget(e.relatedTarget)) {
      hideTimerRef.current = setTimeout(() => {
        setPopover((s) => ({ ...s, visible: false }));
      }, 200);
    }
  }, []);

  // キーボードユーザー向け: caret が codex-highlight 内に入ったら popover を表示
  const handleSelectionUpdate = useCallback(
    ({ editor: ed, transaction }: EditorEvents["selectionUpdate"]) => {
      // 入力・IME 由来の selection 変化では反応しない（執筆の妨害防止）
      if (transaction.docChanged || ed.view.composing) return;
      let el: Element | null = null;
      const { selection } = ed.state;
      if (selection.empty) {
        try {
          const { node } = ed.view.domAtPos(selection.from);
          el = resolveCodexTarget(node);
        } catch {
          el = null;
        }
      }
      if (!el) {
        suppressedEntryRef.current = null;
        setPopover((s) => (s.visible ? { ...s, visible: false } : s));
        return;
      }
      const entryId = el.getAttribute("data-codex-entry-id");
      if (!entryId || entryId === suppressedEntryRef.current) return;
      suppressedEntryRef.current = null;
      showForElement(el);
    },
    [showForElement],
  );

  const handleMouseOut = useCallback((e: MouseEvent) => {
    const target = resolveCodexTarget(e.target);
    if (target && !isInsideCodexTarget(e.relatedTarget)) {
      hideTimerRef.current = setTimeout(() => {
        setPopover((s) => ({ ...s, visible: false }));
      }, 200);
    }
  }, []);

  useEffect(() => {
    let dom: HTMLElement | null = null;
    if (containerEl) {
      dom = containerEl;
    } else if (editor && !editor.isDestroyed) {
      try {
        dom = editor.view.dom;
      } catch {
        // エディタがまだマウントされていない、または破棄済みの場合はスキップ
        return;
      }
    }
    if (!dom) return;
    dom.addEventListener("mouseover", handleMouseOver);
    dom.addEventListener("mouseout", handleMouseOut);
    dom.addEventListener("focusin", handleFocusIn);
    dom.addEventListener("focusout", handleFocusOut);
    return () => {
      dom!.removeEventListener("mouseover", handleMouseOver);
      dom!.removeEventListener("mouseout", handleMouseOut);
      dom!.removeEventListener("focusin", handleFocusIn);
      dom!.removeEventListener("focusout", handleFocusOut);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [
    editor,
    containerEl,
    handleMouseOver,
    handleMouseOut,
    handleFocusIn,
    handleFocusOut,
  ]);

  // キャレット経路（selectionUpdate）はキーボード操作者向けのオプトイン
  // （settings の editor.codexPopoverOnCaret、既定OFF）。マウスホバー経路は
  // 設定に関わらず常に有効。
  const caretPopoverEnabled = useSettingsStore((s) =>
    s.getBoolean("editor.codexPopoverOnCaret", false),
  );

  useEffect(() => {
    if (!caretPopoverEnabled) return;
    if (!editor || editor.isDestroyed) return;
    // テスト用モック editor など emitter を持たない実装では購読しない
    if (typeof editor.on !== "function" || typeof editor.off !== "function") {
      return;
    }
    editor.on("selectionUpdate", handleSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
    };
  }, [editor, handleSelectionUpdate, caretPopoverEnabled]);

  // Escape で閉じる（caret が同じ entry 上にある間は再表示しない）
  useEffect(() => {
    if (!popover.visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      // 最上層のこのポップオーバーだけを閉じ、下層の Escape 動作へ波及させない
      e.stopPropagation();
      suppressedEntryRef.current = popoverStateRef.current.entryId;
      setPopover((s) => ({ ...s, visible: false }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [popover.visible]);

  // 共有フックで phase 解決と未開示伏線を取得（フック呼び出しは early return より前に配置必須）
  const { t } = useTranslation();
  const fullEntry = entries.find((entry) => entry.id === popover.entryId);
  const completionTarget = completionTargets.find(
    (entry) => entry.id === popover.entryId,
  );
  const activeIds =
    popover.entryId && (fullEntry || completionTarget) ? [popover.entryId] : [];
  const resolved = useResolvedCodexStates(activeIds);
  const spoilers = useUnrevealedSecretForeshadows(activeIds);

  if (!popover.visible || !popover.entryId) return null;

  if (!fullEntry && !completionTarget) {
    const fallbackLabel =
      popover.entryLabel?.trim() ||
      t("editor.semanticLink.deletedEntry", "削除済みのCodexエントリ");
    return createPortal(
      <div
        role="dialog"
        aria-label={fallbackLabel}
        className="codex-popover fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
        style={{ left: popover.x, top: popover.y }}
        data-testid="codex-popover"
        onMouseEnter={() => {
          if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
          }
        }}
        onMouseLeave={() => {
          setPopover((state) => ({ ...state, visible: false }));
        }}
      >
        <p className="text-sm font-semibold text-foreground">{fallbackLabel}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "editor.semanticLink.danglingHelp",
            "リンク先は削除されています。文字列を選択して再割り当てするか、リンクを解除してください。",
          )}
        </p>
      </div>,
      document.body,
    );
  }

  const entry = fullEntry ?? {
    name: completionTarget!.name,
    summary: null,
  };
  const entryType = fullEntry?.type ?? completionTarget!.type;
  const entryId = popover.entryId;

  const dotColor =
    typeColorMap[entryType]?.fg ?? FALLBACK_TYPE_COLORS[entryType] ?? "#888888";
  function handleOpenInCodex() {
    setPopover((s) => ({ ...s, visible: false }));
    void requestOpenInCodex(entryId);
  }

  return createPortal(
    <div
      role="dialog"
      aria-label={entry.name}
      className="codex-popover fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
      style={{ left: popover.x, top: popover.y }}
      data-testid="codex-popover"
      onMouseEnter={() => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }}
      onMouseLeave={() => {
        setPopover((s) => ({ ...s, visible: false }));
      }}
    >
      <CodexEntryPopoverContent
        entry={entry}
        dotColor={dotColor}
        typeLabel={getTypeLabel(entryType)}
        onOpenInCodex={handleOpenInCodex}
        phaseLabel={resolved.get(entryId)?.phaseLabel}
        resolvedSummary={resolved.get(entryId)?.resolvedSummary}
        spoilerNote={
          (spoilers.get(entryId)?.length ?? 0) > 0
            ? t("codex.spoiler.unrevealedTooltip", {
                titles: spoilers
                  .get(entryId)!
                  .map((f) => f.title)
                  .join(", "),
              })
            : undefined
        }
      />
    </div>,
    document.body,
  );
}
