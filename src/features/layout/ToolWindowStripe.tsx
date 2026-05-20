import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { ToolWindowIcon, TOOL_WINDOW_REASSIGN_TYPE } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import type { StripeRegion } from "./toolWindowDefaults";
import type { StripeSegment } from "./useStripeSegmentsByRegion";

interface StripeGroupProps {
  segment: StripeSegment;
  orientation: "vertical" | "horizontal";
  region: StripeRegion;
}

function StripeGroup({ segment, orientation, region }: StripeGroupProps) {
  const moveToGroup = useLayoutStore((s) => s.moveToGroup);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const handleDragOver = (e: React.DragEvent) => {
    if (
      !layoutLocked &&
      e.dataTransfer.types.includes(TOOL_WINDOW_REASSIGN_TYPE)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId = e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE);
    if (!panelId) return;
    // ghost segment (group 無し) はドロップ先に出来ない。
    // band に複数 group があれば先頭 group に合流 (精密配置は Dockview overlay で)
    const targetGroupId = segment.groupIds[0];
    if (!targetGroupId) return;
    moveToGroup(panelId as never, targetGroupId);
  };

  return (
    <div
      data-drop-segment={segment.key}
      data-drop-group-id={segment.groupIds[0] ?? ""}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ flexGrow: segment.sizeRatio, flexBasis: 0 }}
      className={cn(
        "flex flex-1",
        orientation === "vertical"
          ? "w-full flex-col items-center gap-1"
          : "h-full flex-row items-center gap-1",
      )}
    >
      {segment.panels.map((panel) => (
        <ToolWindowIcon
          key={panel.id}
          panelId={panel.id}
          region={region}
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
  /** 表示する segment のリスト。Shell が `useStripeSegmentsByRegion` から渡す */
  segments: ReadonlyArray<StripeSegment>;
}

/**
 * 1 stripe (region + orientation) を描画。
 * Y モデル: segment 1 つにつき StripeGroup 1 つ。segment 間に divider を挟む。
 * 各 segment は対応する Dockview group の実寸に比例した flex-grow を持つ。
 */
export function ToolWindowStripe({
  region,
  orientation,
  segments,
}: ToolWindowStripeProps) {
  if (segments.length === 0) return null;

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
      {segments.map((segment, i) => (
        <Fragment key={segment.key}>
          <StripeGroup
            segment={segment}
            orientation={orientation}
            region={region}
          />
          {i < segments.length - 1 && (
            <div
              data-stripe-divider
              aria-hidden
              className={cn(
                "shrink-0 rounded-full bg-muted-foreground/50",
                orientation === "vertical"
                  ? "h-[3px] w-6 my-1"
                  : "w-[3px] h-6 mx-1",
              )}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
