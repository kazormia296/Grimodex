import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface NodeContextMenuProps {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  isHidden: boolean;
  focusedNodeId: string | null;
  onClose: () => void;
  onOpen: () => void;
  onPin: () => void;
  onUnpin: () => void;
  onHide: () => void;
  onShowHidden: () => void;
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
  isHidden,
  focusedNodeId,
  onClose,
  onOpen,
  onPin,
  onUnpin,
  onHide,
  onShowHidden,
  onFocus,
  onExitFocus,
  onBringToFront,
  onSendToBack,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => onClose(), [onClose]);

  // Close on outside click or Escape.
  // Use capture phase so React Flow's internal stopPropagation on pointer/mouse
  // events cannot swallow the dismissal (React Flow captures pointerdown for
  // drag/selection and can prevent our bubble-phase listener from firing).
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

        {isHidden ? (
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-left hover:bg-accent"
            onClick={() => {
              close();
              onShowHidden();
            }}
          >
            このボードで再表示
          </button>
        ) : (
          <button
            type="button"
            className="flex items-center justify-between px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive"
            onClick={() => {
              close();
              onHide();
            }}
          >
            <span>このボードで非表示</span>
            <span className="ml-4 text-xs text-muted-foreground">Del</span>
          </button>
        )}

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

        {(["サイドグループで開く", "接続..."] as const).map((label) => (
          <div
            key={label}
            className="px-3 py-1.5 text-sm text-muted-foreground cursor-not-allowed"
            title="未実装"
          >
            {label}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
