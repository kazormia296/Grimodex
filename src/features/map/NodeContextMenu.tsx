import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  { value: "character", labelKey: "map.codexType.character" },
  { value: "location", labelKey: "map.codexType.location" },
  { value: "item", labelKey: "map.codexType.item" },
  { value: "lore", labelKey: "map.codexType.lore" },
] as const;

const PROMOTE_FLAT_ITEMS = [
  { type: "scene" as PromoteTargetType, labelKey: "map.nodeType.scene" },
  { type: "note" as PromoteTargetType, labelKey: "map.nodeType.note" },
  { type: "snippet" as PromoteTargetType, labelKey: "map.nodeType.snippet" },
] as const;

interface NodeContextMenuProps {
  nodeId: string;
  screenPosition: { x: number; y: number };
  isPinned: boolean;
  isScene: boolean;
  isSticky?: boolean;
  isFrame?: boolean;
  isAiBranch?: boolean;
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
  /** AI Branch 専用: 派生 Sticky ごと一括削除。confirm は呼び出し側で。 */
  onDeleteWithDerivedStickies?: () => void;
  /** AI Branch 専用: 派生 Sticky を全て採用 (branch から切り離す)。 */
  onAdoptAllDerived?: () => void;
  derivedStickyCount?: number;
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
  isAiBranch = false,
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
  onDeleteWithDerivedStickies,
  onAdoptAllDerived,
  derivedStickyCount = 0,
}: NodeContextMenuProps) {
  const { t } = useTranslation();
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
                <DropdownMenuSubTrigger>
                  {t("map.menu.promoteToCodex")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {CODEX_TYPES.map(({ value, labelKey }) => (
                    <DropdownMenuItem
                      key={value}
                      onSelect={() => onPromoteFrame(value)}
                    >
                      {t(labelKey)}
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
              {t("common.delete")}
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {isScene && (
              <>
                <DropdownMenuItem onSelect={onOpen}>
                  {t("map.menu.open")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}

            <DropdownMenuItem onSelect={isPinned ? onUnpin : onPin}>
              {isPinned
                ? t("map.menu.unpinPosition")
                : t("map.menu.pinPosition")}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={onBringToFront}>
              {t("map.menu.bringToFront")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSendToBack}>
              {t("map.menu.sendToBack")}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem onSelect={focusedNodeId ? onExitFocus : onFocus}>
              {focusedNodeId ? t("map.menu.exitFocus") : t("map.menu.focus")}
            </DropdownMenuItem>

            {isSticky && onPinToChatContext && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onPinToChatContext}>
                  {isStickyPinnedToChat
                    ? t("map.menu.removeChatSpotlight")
                    : t("map.menu.addChatSpotlight")}
                </DropdownMenuItem>
              </>
            )}

            {isSticky && onChangeColor && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("map.menu.changeColor")}
                  </DropdownMenuSubTrigger>
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

            {onBranchFrom && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onBranchFrom}>
                  {t("map.menu.branchFromHere")}
                </DropdownMenuItem>
              </>
            )}

            {onOpenAiBranch && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenAiBranch}>
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {t("map.menu.generateAiBranch")}
                </DropdownMenuItem>
              </>
            )}

            {isSticky && onPromote && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("map.menu.promote")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[140px]">
                    {PROMOTE_FLAT_ITEMS.map(({ type, labelKey }) => (
                      <DropdownMenuItem
                        key={type}
                        onSelect={() => onPromote(type)}
                      >
                        {t(labelKey)}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Codex</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-[130px]">
                        {CODEX_TYPES.map(({ value, labelKey }) => (
                          <DropdownMenuItem
                            key={value}
                            onSelect={() => onPromote("codex", value)}
                          >
                            {t(labelKey)}
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
              {isSticky || isAiBranch
                ? t("common.delete")
                : t("map.menu.deleteFromBoard")}
            </DropdownMenuItem>

            {isAiBranch && onAdoptAllDerived && derivedStickyCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onAdoptAllDerived}>
                  {t("map.menu.adoptAllDerived")}
                  <span className="ml-2 opacity-70">
                    {t("map.menu.derivedStickyCount", {
                      count: derivedStickyCount,
                    })}
                  </span>
                </DropdownMenuItem>
              </>
            )}

            {isAiBranch && onDeleteWithDerivedStickies && (
              <DropdownMenuItem
                onSelect={onDeleteWithDerivedStickies}
                className={DESTRUCTIVE_CLASS}
              >
                {t("map.menu.deleteWithDerived")}
                {derivedStickyCount > 0 && (
                  <span className="ml-2 opacity-70">
                    {t("map.menu.derivedStickyCount", {
                      count: derivedStickyCount,
                    })}
                  </span>
                )}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
