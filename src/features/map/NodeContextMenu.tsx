import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface NodeContextMenuProps {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  onClose: () => void;
  onOpen: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
}

const MENU_WIDTH = 200;

const DISABLED_ITEMS = [
  "サイドグループで開く",
  "接続...",
  "前面へ移動",
  "背面へ移動",
  "フォーカス",
];

export function NodeContextMenu({
  nodeId: _nodeId,
  screenPosition,
  isPinned,
  isScene,
  onClose,
  onOpen,
  onPin,
  onUnpin,
  onHide,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => onClose(), [onClose]);

  // Close on outside click or Escape
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  const x = Math.min(screenPosition.x, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(screenPosition.y, window.innerHeight - 240);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: MENU_WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col py-1">
        {isScene && (
          <>
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-accent"
              onClick={() => {
                close();
                onOpen();
              }}
            >
              開く
            </button>
            <div className="my-1 border-t border-border" />
          </>
        )}

        {isPinned ? (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => {
              close();
              onUnpin();
            }}
          >
            固定解除
          </button>
        ) : (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => {
              close();
              onPin();
            }}
          >
            位置を固定
          </button>
        )}

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive"
          onClick={() => {
            close();
            onHide();
          }}
        >
          このボードで非表示
        </button>

        <div className="my-1 border-t border-border" />

        {DISABLED_ITEMS.map((label) => (
          <div
            key={label}
            className="px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
            title="Phase D で対応予定"
          >
            {label}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
