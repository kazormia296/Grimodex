import { useTranslation } from "react-i18next";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";

interface SideDockToggleProps {
  region: "left" | "right";
}

/**
 * Center Stripe の左右端セル（サイドストライプの真上）に置く、サイド
 * ドック開閉トグル。クリックでその領域のツールパネルを一括開閉する。
 *
 * `EditorToggleIcon` と同じ「固定・移動不可」アイコンとして見た目を揃え、
 * Center Stripe の帯を左右で挟む。
 */
export function SideDockToggle({ region }: SideDockToggleProps) {
  const { t } = useTranslation();
  const collapseLayoutRegion = useLayoutStore((s) => s.collapseLayoutRegion);
  const expandLayoutRegion = useLayoutStore((s) => s.expandLayoutRegion);
  const open = useLayoutStore((s) =>
    s.layout.regions[region].slots.some((slot) => slot.activePanel !== null),
  );

  const Side = region === "left" ? "Left" : "Right";
  const label = t(`layout.dockToggle.${open ? "collapse" : "expand"}${Side}`);
  const Icon =
    region === "left"
      ? open
        ? PanelLeftClose
        : PanelLeftOpen
      : open
        ? PanelRightClose
        : PanelRightOpen;

  return (
    <button
      type="button"
      data-side-dock-toggle={region}
      data-state={open ? "shown" : "hidden"}
      title={label}
      aria-label={label}
      aria-pressed={open}
      onClick={() =>
        open ? collapseLayoutRegion(region) : expandLayoutRegion(region)
      }
      className={cn(
        "relative z-30 flex h-[27px] w-[27px] shrink-0 cursor-default items-center justify-center rounded-full transition-colors",
        "ring-1 ring-inset transition-transform duration-75 active:scale-[0.94]",
        open
          ? "bg-accent text-foreground ring-primary/45"
          : "text-muted-foreground ring-border/70 hover:bg-accent/30 hover:text-foreground hover:ring-primary/30",
      )}
    >
      <Icon className="h-4 w-4" strokeWidth={2.25} />
    </button>
  );
}
