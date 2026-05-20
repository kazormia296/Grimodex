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
import type { StripeRegion } from "./toolWindowDefaults";

/** MIME type for stripe icon DnD slot reassignment */
export const TOOL_WINDOW_REASSIGN_TYPE =
  "application/grimodex-toolwindow-reassign";

const ALL_REGIONS: StripeRegion[] = ["left", "right", "bottom"];

interface ToolWindowIconProps {
  panelId: Exclude<PanelId, "editor">;
  /** 現在 icon が属する region (現 region 項目を disable にするのに使用) */
  region: StripeRegion;
  /** Dockview に mount されている (同 group の裏 tab 含む) */
  visible: boolean;
  /** 画面に実際に出ている (active tab or undock overlay) */
  active: boolean;
}

/**
 * Stripe 上のアイコン 1 個。3 状態を視覚化する。
 * Y モデル: コンテキストメニューは region 単位の Move To と Remove from sidebar の 2 項目のみ。
 * Group 内の精緻配置は Dockview overlay の DnD で行う (P-E)。
 */
export function ToolWindowIcon({
  panelId,
  region,
  visible,
  active,
}: ToolWindowIconProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const moveToRegion = useLayoutStore((s) => s.moveToRegion);
  const removePanelFromStripe = useLayoutStore((s) => s.removePanelFromStripe);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

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
          <ContextMenuSubTrigger
            data-testid={`ctx-move-to-${panelId}`}
            disabled={layoutLocked}
          >
            {t("layout.stripe.moveTo")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {ALL_REGIONS.map((r) => (
              <ContextMenuItem
                key={r}
                disabled={r === region}
                onClick={() => moveToRegion(panelId, r)}
              >
                {t(`layout.stripe.region.${r}`)}
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
