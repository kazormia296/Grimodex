import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useLayoutStore } from "./layoutStore";
import type { PanelId } from "./panelIds";
import { PANEL_ICON_MAP } from "./panelIcons";
import { KEYBOARD_SHORTCUT_MAP } from "./panelRegions";
import type { RegionId } from "./layoutTypes";

/** MIME type for stripe icon DnD slot reassignment */
export const TOOL_WINDOW_REASSIGN_TYPE =
  "application/grimodex-toolwindow-reassign";

const ALL_REGIONS: RegionId[] = ["left", "right", "bottom"];

interface ToolWindowIconProps {
  panelId: Exclude<PanelId, "editor">;
  region: RegionId;
  /** panel === slot.activePanel */
  active: boolean;
}

/** Stripe icon — 2 states: shown (active) / hidden (registered but inactive). */
export function ToolWindowIcon({
  panelId,
  region,
  active,
}: ToolWindowIconProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const moveToRegion = useLayoutStore((s) => s.moveToRegion);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const label = t(`layout.panel.${panelId}`);
  const shortcut = KEYBOARD_SHORTCUT_MAP[panelId];
  const tooltip = shortcut ? `${label} (${shortcut})` : label;

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
          draggable={!layoutLocked}
          onDragStart={(e) => {
            setDraggingPanel(panelId);
            e.dataTransfer.setData(TOOL_WINDOW_REASSIGN_TYPE, panelId);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDraggingPanel(null)}
          onClick={() => togglePanel(panelId)}
          className={cn(
            "relative flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
            "transition-transform duration-75 active:scale-[0.94]",
            active
              ? "bg-accent text-foreground"
              : "text-muted-foreground/60 hover:bg-accent/30 hover:text-foreground",
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
                onClick={() => moveToRegion(panelId, r)}
              >
                {t(`layout.stripe.region.${r}`)}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
