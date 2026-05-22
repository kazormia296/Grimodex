import { PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getBottomCorners } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";
import { useMochiLayout } from "./mochiLayout";

interface BottomCornerToggleProps {
  side: "left" | "right";
}

/**
 * トグルボタンがコーナーで占める領域（px）。ボタン自体は inset 6px・
 * サイズ 18px。stripe がこの角を取るときは、その端にこの幅の余白を
 * 確保してアイコンと重ならないようにする。
 */
export const BOTTOM_CORNER_TOGGLE_CLEARANCE_PX = 28;

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
  const mochi = useMochiLayout();

  const SideIcon = side === "left" ? PanelLeft : PanelRight;
  const Icon = ownedByBottom ? PanelBottom : SideIcon;
  const offset = mochi ? "calc(var(--gx-outer-pad) + 6px)" : "6px";
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
        "absolute z-20 flex h-[18px] w-[18px] items-center justify-center",
        "rounded-md border border-border bg-background text-muted-foreground",
        "transition-colors hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
      style={{ bottom: offset, [side]: offset }}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
