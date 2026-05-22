import { useTranslation } from "react-i18next";
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
import { PanelPickerMenuItems } from "./PanelPickerMenuItems";
import type { LayoutRegionId } from "./layoutTypes";
import type { ToolWindowPanelId } from "./layoutTypes";

interface StripeBandContextMenuProps {
  region: LayoutRegionId;
  slotId: string;
  bandKind: "tool" | "editor";
  children: React.ReactNode;
}

export function StripeBandContextMenu({
  region,
  slotId,
  bandKind,
  children,
}: StripeBandContextMenuProps) {
  const { t } = useTranslation();
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const isPanelActive = useLayoutStore((s) => s.isPanelActive);
  const collapseLayoutRegion = useLayoutStore((s) => s.collapseLayoutRegion);
  const removeAllPanelsFromStripeRegion = useLayoutStore(
    (s) => s.removeAllPanelsFromStripeRegion,
  );
  const addPanelToStripeSlot = useLayoutStore((s) => s.addPanelToStripeSlot);
  const addPanelToCenterStripe = useLayoutStore(
    (s) => s.addPanelToCenterStripe,
  );

  const showAddPanel =
    bandKind === "tool" || (bandKind === "editor" && region === "center");

  const handlePickPanel = (panelId: ToolWindowPanelId) => {
    if (bandKind === "editor" && region === "center") {
      addPanelToCenterStripe(panelId);
      return;
    }
    addPanelToStripeSlot(panelId, region, slotId);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {showAddPanel && (
          <>
            <ContextMenuSub>
              <ContextMenuSubTrigger
                data-testid="stripe-band-ctx-add-panel"
                disabled={layoutLocked}
              >
                {t("layout.stripe.bandMenu.addPanel")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-64 overflow-y-auto">
                <PanelPickerMenuItems
                  mode="pick"
                  layoutLocked={layoutLocked}
                  isPanelActive={isPanelActive}
                  onTogglePanel={() => {}}
                  onPickPanel={handlePickPanel}
                  showEditor={false}
                />
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSeparator />
          </>
        )}

        <ContextMenuItem
          data-testid="stripe-band-ctx-collapse"
          onSelect={() => collapseLayoutRegion(region)}
        >
          {t("layout.stripe.bandMenu.collapseRegion")}
        </ContextMenuItem>

        {bandKind === "tool" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="stripe-band-ctx-remove-all"
              disabled={layoutLocked}
              onSelect={() => removeAllPanelsFromStripeRegion(region)}
            >
              {t("layout.stripe.bandMenu.removeAllFromSidebar")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
