import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getBottomCorners } from "./layoutStateUtils";
import { STRIPE_ICON_INSET_PX, STRIPE_ICON_SIZE } from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";

interface BottomCornerToggleProps {
  side: "left" | "right";
}

/**
 * トグルボタンがコーナーで占める領域（px）。RegionStripe 側が共通の
 * STRIPE_ICON_INSET_PX を加えるため、ここではアイコン実寸を渡す。
 */
export const BOTTOM_CORNER_TOGGLE_CLEARANCE_PX = STRIPE_ICON_SIZE;

/**
 * ボトム左右の角を、side stripe と bottom region のどちらが取るかを
 * 切り替える小さなコーナーボタン。現在のオーナーをアイコンで示す
 * （PanelBottom = bottom 所有 / PanelLeft·PanelRight = side 所有）。
 */
export function BottomCornerToggle({ side }: BottomCornerToggleProps) {
  const { t } = useTranslation();
  const ownedByBottom = useLayoutStore((s) => getBottomCorners(s.layout)[side]);
  const toggleBottomCorner = useLayoutStore((s) => s.toggleBottomCorner);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const SideIcon = side === "left" ? PanelLeft : PanelRight;
  const Icon = ownedByBottom ? PanelBottom : SideIcon;
  const offset = `calc(var(--gx-outer-pad) + ${STRIPE_ICON_INSET_PX}px)`;
  const label = t(
    ownedByBottom
      ? "layout.bottomCorner.giveToSide"
      : "layout.bottomCorner.giveToBottom",
  );

  return (
    <button
      type="button"
      disabled={layoutLocked}
      onClick={() => toggleBottomCorner(side)}
      title={label}
      aria-label={label}
      data-bottom-corner-toggle={side}
      className={cn(
        "absolute z-20 flex items-center justify-center",
        "rounded-full border border-border bg-background text-muted-foreground",
        "transition-colors hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
      style={{
        bottom: offset,
        [side]: offset,
        width: STRIPE_ICON_SIZE,
        height: STRIPE_ICON_SIZE,
      }}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
