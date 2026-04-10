import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

const FALLBACK_TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定・世界観",
};

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
}

export function CodexPopover({ editor }: { editor: Editor | null }) {
  const entries = useCodexStore((s) => s.entries);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const [popover, setPopover] = useState<PopoverState>({
    visible: false,
    x: 0,
    y: 0,
    entryId: null,
  });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseOver = useCallback((e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.(".codex-highlight");
    if (!target) return;

    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    const entryId = target.getAttribute("data-codex-entry-id");
    if (!entryId) return;

    const rect = target.getBoundingClientRect();
    setPopover({
      visible: true,
      x: rect.left,
      y: rect.bottom + 4,
      entryId,
    });
  }, []);

  const handleMouseOut = useCallback((e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.(".codex-highlight");
    const relatedTarget = (e.relatedTarget as HTMLElement)?.closest?.(
      ".codex-popover",
    );
    if (target && !relatedTarget) {
      hideTimerRef.current = setTimeout(() => {
        setPopover((s) => ({ ...s, visible: false }));
      }, 200);
    }
  }, []);

  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    dom.addEventListener("mouseover", handleMouseOver);
    dom.addEventListener("mouseout", handleMouseOut);
    return () => {
      dom.removeEventListener("mouseover", handleMouseOver);
      dom.removeEventListener("mouseout", handleMouseOut);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [editor, handleMouseOver, handleMouseOut]);

  if (!popover.visible || !popover.entryId) return null;

  const entry = entries.find((e) => e.id === popover.entryId);
  if (!entry) return null;

  const dotColor =
    typeColorMap[entry.type]?.fg ??
    FALLBACK_TYPE_COLORS[entry.type] ??
    "#888888";
  const summaryText = entry.summary
    ? entry.summary.length > 100
      ? entry.summary.slice(0, 100) + "…"
      : entry.summary
    : null;

  function handleOpenInCodex() {
    setPopover((s) => ({ ...s, visible: false }));
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entry!.id);
  }

  return createPortal(
    <div
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
      <div className="mb-1.5 flex items-center gap-2">
        {entry.icon ? (
          <img
            src={entry.icon}
            alt=""
            className="h-6 w-6 flex-shrink-0 rounded-sm object-cover"
          />
        ) : (
          <span
            className="h-6 w-6 flex-shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        )}
        <span className="flex-1 truncate text-sm font-semibold">
          {entry.name}
        </span>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
          {FALLBACK_TYPE_LABELS[entry.type] ?? entry.type}
        </span>
      </div>
      {summaryText && (
        <p className="mb-2 text-xs text-muted-foreground">{summaryText}</p>
      )}
      <button
        type="button"
        className="text-xs text-primary hover:underline"
        onClick={handleOpenInCodex}
      >
        Open in Codex →
      </button>
    </div>,
    document.body,
  );
}
