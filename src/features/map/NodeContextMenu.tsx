import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import type { PromoteTargetType } from "./mapApi";

const CODEX_TYPES = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・用語" },
] as const;

interface NodeContextMenuProps {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  isSticky?: boolean;
  isFrame?: boolean;
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
  onPromote?: (type: PromoteTargetType, codexType?: string) => void;
  onPromoteFrame?: (codexType: string) => void;
  onBranchFrom?: () => void;
}

const MENU_WIDTH = 200;

export function NodeContextMenu({
  nodeId: _nodeId,
  screenPosition,
  isPinned,
  isScene,
  isSticky = false,
  isFrame = false,
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
  onPromote,
  onPromoteFrame,
  onBranchFrom,
}: NodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showPromoteMenu, setShowPromoteMenu] = useState(false);
  const [showCodexTypes, setShowCodexTypes] = useState(false);
  const [showFrameCodexTypes, setShowFrameCodexTypes] = useState(false);

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
        {isFrame && (
          <>
            {onPromoteFrame && (
              <div
                className="relative"
                onMouseEnter={() => setShowFrameCodexTypes(true)}
                onMouseLeave={() => setShowFrameCodexTypes(false)}
              >
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center justify-between"
                >
                  <span>Codex に昇格…</span>
                  <span className="text-xs text-muted-foreground">▶</span>
                </button>
                {showFrameCodexTypes && (
                  <div
                    className="absolute left-full top-0 bg-popover border border-border rounded-md shadow-md py-1 z-50"
                    style={{ minWidth: 130 }}
                  >
                    {CODEX_TYPES.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent"
                        onClick={() => {
                          close();
                          onPromoteFrame(value);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
              削除
            </button>
          </>
        )}
        {!isFrame && isScene && (
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

        {!isFrame && (
          <>
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
          </>
        )}

        {!isFrame && isSticky && onBranchFrom && (
          <>
            <div className="my-1 border-t border-border" />
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-accent"
              onClick={() => {
                close();
                onBranchFrom();
              }}
            >
              ここから分岐
            </button>
          </>
        )}

        {!isFrame && isSticky && onPromote && (
          <>
            <div className="my-1 border-t border-border" />
            <div
              className="relative"
              onMouseEnter={() => setShowPromoteMenu(true)}
              onMouseLeave={() => {
                setShowPromoteMenu(false);
                setShowCodexTypes(false);
              }}
            >
              <button
                type="button"
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center justify-between"
              >
                <span>昇格…</span>
                <span className="text-xs text-muted-foreground">▶</span>
              </button>
              {showPromoteMenu && (
                <div
                  className="absolute left-full top-0 bg-popover border border-border rounded-md shadow-md py-1 z-50"
                  style={{ minWidth: 140 }}
                >
                  {(
                    [
                      { type: "scene" as PromoteTargetType, label: "シーン" },
                      { type: "note" as PromoteTargetType, label: "ノート" },
                      {
                        type: "snippet" as PromoteTargetType,
                        label: "スニペット",
                      },
                    ] as const
                  ).map(({ type, label }) => (
                    <button
                      key={type}
                      type="button"
                      className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent"
                      onClick={() => {
                        close();
                        onPromote(type);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                  <div
                    className="relative"
                    onMouseEnter={() => setShowCodexTypes(true)}
                    onMouseLeave={() => setShowCodexTypes(false)}
                  >
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent flex items-center justify-between"
                    >
                      <span>Codex</span>
                      <span className="text-xs text-muted-foreground">▶</span>
                    </button>
                    {showCodexTypes && (
                      <div
                        className="absolute left-full top-0 bg-popover border border-border rounded-md shadow-md py-1 z-50"
                        style={{ minWidth: 130 }}
                      >
                        {CODEX_TYPES.map(({ value, label }) => (
                          <button
                            key={value}
                            type="button"
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-accent"
                            onClick={() => {
                              close();
                              onPromote("codex", value);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {!isFrame && (
          <>
            <div className="my-1 border-t border-border" />

            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-accent text-destructive"
              onClick={() => {
                close();
                onRemoveFromBoard();
              }}
            >
              {isSticky ? "削除" : "このボードから削除"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
