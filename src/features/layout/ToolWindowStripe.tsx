import { cn } from "@/lib/utils";
import { ToolWindowIcon, TOOL_WINDOW_REASSIGN_TYPE } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import type { StripeRegion, ToolWindowSlot } from "./toolWindowDefaults";
import type { StripePanel } from "./useStripePanelsByRegion";

/** slot が "top" 位置 (LT / RT / BL) かどうか */
const isTopSlot = (slot: ToolWindowSlot): boolean =>
  slot === "LT" || slot === "RT" || slot === "BL";

interface StripeGroupProps {
  targetSlot: ToolWindowSlot;
  panels: ReadonlyArray<StripePanel>;
  orientation: "vertical" | "horizontal";
}

function StripeGroup({ targetSlot, panels, orientation }: StripeGroupProps) {
  const moveToSlot = useLayoutStore((s) => s.moveToSlot);

  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(TOOL_WINDOW_REASSIGN_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const panelId = e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE);
    if (panelId) moveToSlot(panelId as never, targetSlot);
  };

  return (
    <div
      data-drop-slot={targetSlot}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "flex",
        orientation === "vertical"
          ? "flex-col items-center gap-1"
          : "flex-row items-center gap-1",
      )}
    >
      {panels.map((panel) => (
        <ToolWindowIcon
          key={panel.id}
          panelId={panel.id}
          slot={panel.slot}
          visible={panel.visible}
          active={panel.active}
        />
      ))}
    </div>
  );
}

interface ToolWindowStripeProps {
  region: StripeRegion;
  /** "vertical" = 左/右 (アイコンを縦に並べる), "horizontal" = 下 (横並び) */
  orientation: "vertical" | "horizontal";
  /** 表示する panel のリスト。Shell が `useStripePanelsByRegion` から渡す */
  panels: ReadonlyArray<StripePanel>;
}

/**
 * 1 stripe (region + orientation) を描画。
 * Phase 2: slot に応じて top/bottom (left/right) の 2 グループに分割し、
 * 両方に panel があるときだけ divider を表示する。
 * 各グループは DnD ドロップ受け入れゾーン。
 */
export function ToolWindowStripe({
  region,
  orientation,
  panels,
}: ToolWindowStripeProps) {
  if (panels.length === 0) return null;

  const topPanels = panels.filter((p) => isTopSlot(p.slot));
  const bottomPanels = panels.filter((p) => !isTopSlot(p.slot));
  const showDivider = topPanels.length > 0 && bottomPanels.length > 0;

  // region ごとの slot ペア: top と bottom の slot ID を決定
  const topSlot: ToolWindowSlot =
    region === "left" ? "LT" : region === "right" ? "RT" : "BL";
  const bottomSlot: ToolWindowSlot =
    region === "left" ? "LB" : region === "right" ? "RB" : "BR";

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
      <StripeGroup
        targetSlot={topSlot}
        panels={topPanels}
        orientation={orientation}
      />

      {showDivider && (
        <div
          data-stripe-divider
          aria-hidden
          className={cn(
            "shrink-0 rounded-full bg-border/60",
            orientation === "vertical"
              ? "h-[1px] w-4 my-0.5"
              : "w-[1px] h-4 mx-0.5",
          )}
        />
      )}

      <StripeGroup
        targetSlot={bottomSlot}
        panels={bottomPanels}
        orientation={orientation}
      />
    </div>
  );
}
