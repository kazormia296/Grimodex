import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface NodeContextMenuProps {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  focusedNodeId: string | null;
  onClose: () => void;
  onOpen: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onRemoveFromBoard: () => void;
  onFocus: () => void;
  onExitFocus: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
}

const MENU_WIDTH = 200;

export function NodeContextMenu({
  nodeId: _nodeId,
  screenPosition,
  isPinned,
  isScene,
  focusedNodeId,
  onClose,
  onOpen,
  onPin,
  onUnpin,
  onRemoveFromBoard,
  onFocus,
  onExitFocus,
  onBringToFront,
  onSendToBack,
}: NodeContextMenuProps) {
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
    document.addEventListener("contextmenu", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("contextmenu", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close]);

  const x = Math.min(screenPosition.x, window.innerWidth - MENU_WIDTH - 8);
  const y = Math.min(screenPosition.y, window.innerHeight - 280);

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
          className="px-3 py-1.5 text-sm text-left hover:bg-accent"
          onClick={() => {
            close();
            onBringToFront();
          }}
        >
          前面へ移動
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent"
          onClick={() => {
            close();
            onSendToBack();
          }}
        >
          背面へ移動
        </button>

        <div className="my-1 border-t border-border" />

        {focusedNodeId ? (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => {
              close();
              onExitFocus();
            }}
          >
            フォーカスを解除
          </button>
        ) : (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => {
              close();
              onFocus();
            }}
          >
            フォーカス
          </button>
        )}

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive"
          onClick={() => {
            close();
            onRemoveFromBoard();
          }}
        >
          このボードから削除
        </button>
      </div>
    </div>,
    document.body,
  );
}
