import type { ReactNode } from "react";
import { useLayoutStore } from "./layoutStore";
import { ToolWindowStripe } from "./ToolWindowStripe";
import { useStripeSegmentsByRegion } from "./useStripeSegmentsByRegion";

interface ToolWindowShellProps {
  /** Dockview area (中央) */
  children: ReactNode;
  /** screenshot mode 等で stripe を hidden にする */
  hidden?: boolean;
}

/**
 * IntelliJ 式 3 方向ツールウィンドウ shell。
 * Y モデル: stripe は Dockview group ごとの N segment で構成される。
 * 0 segment の region は grid セル幅 0 で完全に潰す。
 * Phase 3 で undock overlay 層を兄弟要素として追加する想定。
 */
export function ToolWindowShell({
  children,
  hidden = false,
}: ToolWindowShellProps) {
  const stripeSizes = useLayoutStore((s) => s.stripeSizes);
  const stripeVisibility = useLayoutStore((s) => s.stripeVisibility);
  const segments = useStripeSegmentsByRegion();

  if (hidden) {
    return <>{children}</>;
  }

  // segment が 1 つ以上 (内容の有無にかかわらず) あれば stripe を出す
  const hasContent = (segs: ReadonlyArray<{ panels: unknown[] }>) =>
    segs.some((s) => s.panels.length > 0);
  const showLeft = stripeVisibility.left && hasContent(segments.left);
  const showRight = stripeVisibility.right && hasContent(segments.right);
  const showBottom = stripeVisibility.bottom && hasContent(segments.bottom);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `${showLeft ? stripeSizes.left : 0}px 1fr ${showRight ? stripeSizes.right : 0}px`,
        gridTemplateRows: `1fr ${showBottom ? stripeSizes.bottom : 0}px`,
        // left/right を両行 span させ、bottom stripe の有無で stripe の高さが変わらないようにする。
        // これで Phase 2 で LT/LB を sub-divide した時にも LB アイコンが上下に動かない。
        gridTemplateAreas: '"left content right" "left bottom right"',
        width: "100%",
        height: "100%",
      }}
    >
      <div style={{ gridArea: "left" }} className="min-h-0 overflow-hidden">
        {showLeft && (
          <ToolWindowStripe
            region="left"
            orientation="vertical"
            segments={segments.left}
          />
        )}
      </div>
      <div
        style={{ gridArea: "content" }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        {children}
      </div>
      <div style={{ gridArea: "right" }} className="min-h-0 overflow-hidden">
        {showRight && (
          <ToolWindowStripe
            region="right"
            orientation="vertical"
            segments={segments.right}
          />
        )}
      </div>
      <div style={{ gridArea: "bottom" }} className="min-w-0 overflow-hidden">
        {showBottom && (
          <ToolWindowStripe
            region="bottom"
            orientation="horizontal"
            segments={segments.bottom}
          />
        )}
      </div>
    </div>
  );
}
