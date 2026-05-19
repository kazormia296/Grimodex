import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutStore, type PanelId } from "./layoutStore";
import { PANEL_ICON_MAP } from "./panelIcons";
import { KEYBOARD_SHORTCUT_MAP } from "./panelRegions";
import type { ToolWindowSlot } from "./toolWindowDefaults";

/** MIME type for stripe icon DnD slot reassignment */
export const TOOL_WINDOW_REASSIGN_TYPE =
  "application/grimodex-toolwindow-reassign";

const ALL_SLOTS: ToolWindowSlot[] = ["LT", "LB", "RT", "RB", "BL", "BR"];

interface ToolWindowIconProps {
  panelId: Exclude<PanelId, "editor">;
  /** 現在の有効 slot (divider 位置とコンテキストメニューの現 slot 表示に利用) */
  slot: ToolWindowSlot;
  /** Dockview に mount されている (同 group の裏 tab 含む) */
  visible: boolean;
  /** 画面に実際に出ている (active tab or undock overlay) */
  active: boolean;
}

/**
 * Stripe 上のアイコン 1 個。3 状態を視覚化する。
 * Phase 2 で draggable + 右クリックコンテキストメニューを追加。
 */
export function ToolWindowIcon({
  panelId,
  slot,
  visible,
  active,
}: ToolWindowIconProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const moveToSlot = useLayoutStore((s) => s.moveToSlot);
  const removePanelFromStripe = useLayoutStore((s) => s.removePanelFromStripe);

  const label = t(`layout.panel.${panelId}`);
  const shortcut = KEYBOARD_SHORTCUT_MAP[panelId];
  const tooltip = shortcut ? `${label} (${shortcut})` : label;

  const variant: "shown" | "background" | "closed" = active
    ? "shown"
    : visible
      ? "background"
      : "closed";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-stripe-icon={panelId}
          data-state={variant}
          title={tooltip}
          aria-label={label}
          aria-pressed={active}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TOOL_WINDOW_REASSIGN_TYPE, panelId);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => togglePanel(panelId)}
          className={cn(
            "relative flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
            "active:scale-[0.94] transition-transform duration-75",
            variant === "shown" && "bg-accent text-foreground",
            variant === "background" &&
              "bg-accent/30 text-foreground/80 hover:bg-accent/50 hover:text-foreground",
            variant === "closed" &&
              "text-muted-foreground/60 hover:bg-accent/30 hover:text-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
          {variant === "shown" && (
            <span
              aria-hidden
              className="pointer-events-none absolute left-0 top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-full bg-primary"
            />
          )}
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid={`ctx-move-to-${panelId}`}>
            {t("layout.stripe.moveTo")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {ALL_SLOTS.map((s) => (
              <ContextMenuItem
                key={s}
                disabled={s === slot}
                onClick={() => moveToSlot(panelId, s)}
              >
                {t(`layout.stripe.slot.${s}`)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid={`ctx-remove-from-stripe-${panelId}`}
          onClick={() => removePanelFromStripe(panelId)}
        >
          {t("layout.stripe.removeFromSidebar")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
