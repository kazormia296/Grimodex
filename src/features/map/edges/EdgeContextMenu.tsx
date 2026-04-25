import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

export interface EdgeContextMenuState {
  edgeId: string;
  screenPosition: { x: number; y: number };
  style: "solid" | "dashed" | "dotted";
  color: string;
  direction: "none" | "forward" | "bidirectional";
}

interface EdgeContextMenuProps extends EdgeContextMenuState {
  onClose: () => void;
  onStyleChange: (style: "solid" | "dashed" | "dotted") => void;
  onDirectionChange: (dir: "none" | "forward" | "bidirectional") => void;
  onDelete: () => void;
}

const MENU_WIDTH = 180;

export function EdgeContextMenu({
  screenPosition,
  style,
  direction,
  onClose,
  onStyleChange,
  onDirectionChange,
  onDelete,
}: EdgeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent | MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  const x = Math.min(screenPosition.x, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(screenPosition.y, window.innerHeight - 220);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: MENU_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col py-1">
        <div className="px-3 py-1 text-xs text-muted-foreground font-medium">
          線種
        </div>
        {(["solid", "dashed", "dotted"] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center gap-2 ${style === s ? "font-semibold" : ""}`}
            onClick={() => {
              onStyleChange(s);
              close();
            }}
          >
            <span className="w-8 inline-block">
              {s === "solid" ? "──" : s === "dashed" ? "╌╌" : "···"}
            </span>
            {s === "solid" ? "実線" : s === "dashed" ? "破線" : "点線"}
          </button>
        ))}

        <div className="my-1 border-t border-border" />
        <div className="px-3 py-1 text-xs text-muted-foreground font-medium">
          方向
        </div>
        {(
          [
            ["none", "なし"],
            ["forward", "→"],
            ["bidirectional", "↔"],
          ] as const
        ).map(([d, label]) => (
          <button
            key={d}
            type="button"
            className={`px-3 py-1.5 text-sm text-left hover:bg-accent ${direction === d ? "font-semibold" : ""}`}
            onClick={() => {
              onDirectionChange(d);
              close();
            }}
          >
            {label}
          </button>
        ))}

        <div className="my-1 border-t border-border" />
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive"
          onClick={() => {
            onDelete();
            close();
          }}
        >
          削除
        </button>
      </div>
    </div>,
    document.body,
  );
}
