import { cn } from "@/lib/utils";
import { ToolWindowIcon } from "./ToolWindowIcon";
import type { StripeRegion } from "./toolWindowDefaults";
import type { StripePanel } from "./useStripePanelsByRegion";

interface ToolWindowStripeProps {
  region: StripeRegion;
  /** "vertical" = 左/右 (アイコンを縦に並べる), "horizontal" = 下 (横並び) */
  orientation: "vertical" | "horizontal";
  /** 表示する panel のリスト。Shell が `useStripePanelsByRegion` から渡す */
  panels: ReadonlyArray<StripePanel>;
}

/**
 * 1 stripe (region + orientation) を描画。
 * panels prop で受け取った各 panel に対して icon を出す (open / closed どちらも)。
 * 0 件なら防衛的に null。
 */
export function ToolWindowStripe({
  region,
  orientation,
  panels,
}: ToolWindowStripeProps) {
  if (panels.length === 0) return null;

  return (
    <div
      data-stripe-root
      data-stripe-region={region}
      className={cn(
        "flex h-full w-full bg-background/40",
        orientation === "vertical"
          ? "flex-col items-center gap-1 py-1"
          : "flex-row items-center gap-1 px-1",
        region === "left" && "border-r border-border",
        region === "right" && "border-l border-border",
        region === "bottom" && "border-t border-border",
      )}
    >
      {panels.map((panel) => (
        <ToolWindowIcon
          key={panel.id}
          panelId={panel.id}
          visible={panel.visible}
          active={panel.active}
        />
      ))}
    </div>
  );
}
