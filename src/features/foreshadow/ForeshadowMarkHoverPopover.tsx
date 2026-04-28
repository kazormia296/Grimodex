import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "@/features/editor/cursorSettingsStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useForeshadowStore } from "./foreshadowStore";
import { useForeshadowNavStore } from "./foreshadowNavStore";

const POPOVER_SELECTOR = "[data-foreshadow-hover-popover]";

type MarkKind = "setup" | "payoff";

interface MarkTarget {
  kind: MarkKind;
  foreshadowId: string;
  setupId?: string;
  title: string;
  x: number;
  y: number;
}

interface Props {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

export function ForeshadowMarkHoverPopover({ editor, containerRef }: Props) {
  const { t } = useTranslation();
  const showForeshadowMarks = useCursorSettingsStore(
    (s) => s.showForeshadowMarks,
  );
  const [target, setTarget] = useState<MarkTarget | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    hideTimer.current = setTimeout(() => setTarget(null), 200);
  }, []);

  useEffect(() => {
    if (!showForeshadowMarks) {
      clearHideTimer();
      setTarget(null);
    }
  }, [showForeshadowMarks, clearHideTimer]);

  const handleMouseOver = useCallback(
    (e: MouseEvent) => {
      const el = e.target as Element;
      const setup = el.closest("[data-foreshadow-setup]") as HTMLElement | null;
      const payoff = el.closest(
        "[data-foreshadow-payoff]",
      ) as HTMLElement | null;
      if (!setup && !payoff) return;

      clearHideTimer();

      const kind: MarkKind = setup ? "setup" : "payoff";
      const span = (setup ?? payoff)!;
      const foreshadowId =
        kind === "setup"
          ? (span.getAttribute("data-fs-id") ?? "")
          : (span.getAttribute("data-fp-id") ?? "");
      const setupId =
        kind === "setup"
          ? (span.getAttribute("data-fs-setup-id") ?? undefined)
          : undefined;

      const storeItems = useForeshadowStore.getState().items;
      const title =
        storeItems.find((i) => i.id === foreshadowId)?.title ?? foreshadowId;

      const rect = span.getBoundingClientRect();
      setTarget({
        kind,
        foreshadowId,
        setupId,
        title,
        x: rect.left,
        y: rect.bottom + 4,
      });
    },
    [clearHideTimer],
  );

  // mouseout + relatedTarget でマーク→ポップオーバー移動時の誤隠しを防ぐ（Codex と同パターン）
  const handleMouseOut = useCallback(
    (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const fromMark =
        el.closest("[data-foreshadow-setup]") ||
        el.closest("[data-foreshadow-payoff]");
      if (!fromMark) return;

      const relatedTarget = e.relatedTarget as HTMLElement | null;
      if (relatedTarget?.closest?.(POPOVER_SELECTOR)) return;

      scheduleHide();
    },
    [scheduleHide],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showForeshadowMarks) return;

    container.addEventListener("mouseover", handleMouseOver);
    container.addEventListener("mouseout", handleMouseOut);
    return () => {
      container.removeEventListener("mouseover", handleMouseOver);
      container.removeEventListener("mouseout", handleMouseOut);
      clearHideTimer();
    };
  }, [
    containerRef,
    handleMouseOver,
    handleMouseOut,
    clearHideTimer,
    showForeshadowMarks,
  ]);

  const handleRemove = useCallback(() => {
    if (!editor || !target) return;
    const markName =
      target.kind === "setup" ? "foreshadowSetup" : "foreshadowPayoff";
    const markType = editor.schema.marks[markName];
    if (!markType) return;
    const { tr } = editor.state;
    let removed = false;
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const hasMark = node.marks.some((m) => {
        if (target.kind === "setup") {
          return (
            m.type.name === "foreshadowSetup" &&
            m.attrs.foreshadowId === target.foreshadowId &&
            (!target.setupId || m.attrs.setupId === target.setupId)
          );
        }
        return (
          m.type.name === "foreshadowPayoff" &&
          m.attrs.foreshadowId === target.foreshadowId
        );
      });
      if (hasMark) {
        tr.removeMark(pos, pos + node.nodeSize, markType);
        removed = true;
      }
    });
    if (removed) editor.view.dispatch(tr);
    setTarget(null);
  }, [editor, target]);

  const handleJumpToPanel = useCallback(() => {
    if (!target) return;
    useForeshadowNavStore.getState().requestPanelHighlight(target.foreshadowId);
    useLayoutStore.getState().showPanel("foreshadow");
    setTarget(null);
  }, [target]);

  if (!target) return null;

  const popoverWidth = 200;
  const x = Math.min(target.x, window.innerWidth - popoverWidth - 8);
  const y = Math.min(target.y, window.innerHeight - 80);

  return createPortal(
    <div
      data-foreshadow-hover-popover=""
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, width: popoverWidth }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      <div className="px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
              target.kind === "setup"
                ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                : "bg-green-500/15 text-green-600 dark:text-green-400"
            }`}
          >
            {target.kind === "setup"
              ? t("foreshadow.popover.setupHeading", "Setup")
              : t("foreshadow.popover.payoffHeading", "Payoff")}
          </span>
          <span className="truncate text-xs font-medium text-foreground">
            {target.title}
          </span>
        </div>
        <button
          type="button"
          onClick={handleJumpToPanel}
          className="mb-1.5 flex w-full items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          {t("foreshadow.hoverPopover.jumpToPanel", "パネルで表示")}
        </button>
        <button
          type="button"
          onClick={handleRemove}
          className="w-full rounded border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          {t("foreshadow.hoverPopover.removeMark", "マークを外す")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
