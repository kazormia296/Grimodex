import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatShortcut } from "@/lib/platform";
import { CSS_DURATIONS } from "@/lib/animation";
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
import { useLayoutStore } from "./layoutStore";
import { useStripeIconPointerDrag } from "./useStripeIconPointerDrag";
import { stripeAxisForRegion } from "./layoutStripeSwap";
import type { PanelId } from "./panelIds";
import { PANEL_ICON_MAP } from "./panelIcons";
import { KEYBOARD_SHORTCUT_MAP } from "./panelRegions";
import type { LayoutRegionId, RegionId } from "./layoutTypes";

interface ToolWindowIconProps {
  panelId: Exclude<PanelId, "editor">;
  region: LayoutRegionId;
  slotId: string;
  /** panel === slot.activePanel */
  active: boolean;
  /** その slot が展開中か。false（折りたたみ）のときアイコンを更に dim 表示 */
  slotOpen: boolean;
}

const ALL_REGIONS: RegionId[] = ["left", "right", "bottom"];

/**
 * Stripe icon — 3 states:
 * active（展開 slot の表示中 panel）/ open-inactive（展開 slot の裏 tab）/
 * collapsed（折りたたみ slot：更に dim）。
 */
export function ToolWindowIcon({
  panelId,
  region,
  slotId,
  active,
  slotOpen,
}: ToolWindowIconProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const movePanelToRegion = useLayoutStore((s) => s.movePanelToRegion);
  const removePanelFromStripe = useLayoutStore((s) => s.removePanelFromStripe);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const stripeSwapMode = useLayoutStore((s) => s.stripeSwapMode);
  const stripeSwapSlotId = useLayoutStore((s) => s.stripeSwapSlotId);
  const stripeSwapOffsets = useLayoutStore((s) => s.stripeSwapOffsets);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const passThroughDrop =
    draggingPanel != null && draggingPanel !== panelId && !layoutLocked;

  const { handlePointerDown } = useStripeIconPointerDrag({
    panelId,
    region,
    slotId,
    layoutLocked,
  });

  const label = t(`layout.panel.${panelId}`);
  const shortcut = KEYBOARD_SHORTCUT_MAP[panelId];
  const tooltip = shortcut ? `${label} (${formatShortcut(shortcut)})` : label;

  const axisLockedSwap =
    stripeSwapMode === "axis-locked" && stripeSwapSlotId === slotId;
  const swapOffset = axisLockedSwap ? stripeSwapOffsets[panelId] : undefined;
  const swapAxis = stripeAxisForRegion(region);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-stripe-icon={panelId}
          data-state={active ? "shown" : "hidden"}
          title={tooltip}
          aria-label={label}
          aria-pressed={active}
          onPointerDown={handlePointerDown}
          style={
            swapOffset != null
              ? {
                  transform:
                    swapAxis === "horizontal"
                      ? `translateX(${swapOffset}px)`
                      : `translateY(${swapOffset}px)`,
                  transition: `transform ${CSS_DURATIONS.fast} ease-out`,
                }
              : undefined
          }
          className={cn(
            "relative z-30 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
            "transition-transform duration-75 active:scale-[0.94]",
            "touch-none select-none",
            passThroughDrop && "pointer-events-none",
            draggingPanel === panelId &&
              stripeSwapMode !== "axis-locked" &&
              "opacity-40",
            active
              ? "bg-accent text-foreground"
              : "hover:bg-accent/30 hover:text-foreground",
            !active &&
              (slotOpen
                ? "text-muted-foreground/60"
                : "text-muted-foreground/35"),
          )}
        >
          <Icon className="h-4 w-4" />
          {active && (
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
                onSelect={() => movePanelToRegion(panelId, r)}
              >
                {t(`layout.stripe.region.${r}`)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid={`ctx-remove-from-stripe-${panelId}`}
          disabled={layoutLocked}
          onSelect={() => removePanelFromStripe(panelId)}
        >
          {t("layout.stripe.removeFromSidebar")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
