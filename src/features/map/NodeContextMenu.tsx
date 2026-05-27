import type { PromoteTargetType } from "./mapApi";
import { getPalette, DEFAULT_PALETTE_ID } from "@/lib/stickyPalettes";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";

const CODEX_TYPES = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・用語" },
] as const;

const PROMOTE_FLAT_ITEMS = [
  { type: "scene" as PromoteTargetType, label: "シーン" },
  { type: "note" as PromoteTargetType, label: "ノート" },
  { type: "snippet" as PromoteTargetType, label: "スニペット" },
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
  onOpenAiBranch?: () => void;
  onPinToChatContext?: () => void;
  isStickyPinnedToChat?: boolean;
  onChangeColor?: (paletteId: string, colorSlot: number) => void;
  /** Palette of the right-clicked sticky; defaults to the default palette. */
  stickyPaletteId?: string;
}

const DESTRUCTIVE_CLASS =
  "text-[color:var(--destructive)] focus:text-[color:var(--destructive)]";

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
  onOpenAiBranch,
  onPinToChatContext,
  isStickyPinnedToChat = false,
  onChangeColor,
  stickyPaletteId,
}: NodeContextMenuProps) {
  const palette = getPalette(stickyPaletteId ?? DEFAULT_PALETTE_ID);

  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: screenPosition.x,
            top: screenPosition.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[200px]">
        {isFrame ? (
          <>
            {onPromoteFrame && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Codex に昇格…</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {CODEX_TYPES.map(({ value, label }) => (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() => onPromoteFrame(value)}
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {onPromoteFrame && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={onRemoveFromBoard}
              className={DESTRUCTIVE_CLASS}
            >
              削除
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {isScene && (
              <>
                <DropdownMenuItem onSelect={onOpen}>開く</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}

            <DropdownMenuItem onSelect={isPinned ? onUnpin : onPin}>
              {isPinned ? "固定解除" : "位置を固定"}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={onBringToFront}>
              前面へ移動
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSendToBack}>
              背面へ移動
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={focusedNodeId ? onExitFocus : onFocus}>
              {focusedNodeId ? "フォーカスを解除" : "フォーカス"}
            </DropdownMenuItem>

            {isSticky && onPinToChatContext && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onPinToChatContext}>
                  {isStickyPinnedToChat
                    ? "チャットコンテキストのピン解除"
                    : "チャットコンテキストにピン"}
                </DropdownMenuItem>
              </>
            )}

            {isSticky && onChangeColor && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>色を変更…</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[160px]">
                    {palette.colors.map((c, slot) => (
                      <DropdownMenuItem
                        key={slot}
                        onSelect={() => onChangeColor(palette.id, slot)}
                      >
                        <span
                          aria-hidden
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: "50%",
                            border: "1.5px solid rgba(0,0,0,0.2)",
                            background: c.hex,
                            flexShrink: 0,
                            marginRight: 8,
                          }}
                        />
                        <span>{c.label}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}

            {isSticky && onBranchFrom && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onBranchFrom}>
                  ここから分岐
                </DropdownMenuItem>
              </>
            )}

            {onOpenAiBranch && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenAiBranch}>
                  ✦ AI Branch を生成…
                </DropdownMenuItem>
              </>
            )}

            {isSticky && onPromote && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>昇格…</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[140px]">
                    {PROMOTE_FLAT_ITEMS.map(({ type, label }) => (
                      <DropdownMenuItem
                        key={type}
                        onSelect={() => onPromote(type)}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Codex</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-[130px]">
                        {CODEX_TYPES.map(({ value, label }) => (
                          <DropdownMenuItem
                            key={value}
                            onSelect={() => onPromote("codex", value)}
                          >
                            {label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              onSelect={onRemoveFromBoard}
              className={DESTRUCTIVE_CLASS}
            >
              {isSticky ? "削除" : "このボードから削除"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
