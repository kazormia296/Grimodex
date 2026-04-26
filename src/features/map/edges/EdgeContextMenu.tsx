import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

export interface EdgeContextMenuState {
  edgeId: string;
  screenPosition: { x: number; y: number };
  style: "solid" | "dashed" | "dotted";
  color: string;
}

interface EdgeContextMenuProps extends EdgeContextMenuState {
  onClose: () => void;
  onStyleChange: (style: "solid" | "dashed" | "dotted") => void;
  onColorChange: (color: string) => void;
  onDelete: () => void;
}

const MENU_WIDTH = 200;
// 3 line-style items + 2 section headers + color row + 2 dividers + delete
const MENU_HEIGHT = 260;

const COLOR_PRESETS = [
  { value: "#555555", label: "グレー" },
  { value: "#ef4444", label: "赤" },
  { value: "#f97316", label: "オレンジ" },
  { value: "#eab308", label: "黄" },
  { value: "#22c55e", label: "緑" },
  { value: "#3b82f6", label: "青" },
  { value: "#a855f7", label: "紫" },
] as const;

export function EdgeContextMenu({
  screenPosition,
  style,
  color,
  onClose,
  onStyleChange,
  onColorChange,
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
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  const x = Math.max(
    8,
    Math.min(screenPosition.x, window.innerWidth - MENU_WIDTH - 8),
  );
  const y = Math.max(
    8,
    Math.min(screenPosition.y, window.innerHeight - MENU_HEIGHT - 8),
  );

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
          色変更
        </div>
        <div className="px-3 py-2 flex gap-2 flex-wrap">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.label}
              className="rounded-full border-2 transition-transform hover:scale-110"
              style={{
                width: 20,
                height: 20,
                background: c.value,
                borderColor:
                  color === c.value ? "var(--foreground)" : "transparent",
              }}
              onClick={() => {
                onColorChange(c.value);
                close();
              }}
            />
          ))}
        </div>

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
