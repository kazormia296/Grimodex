import { memo, Suspense, useRef } from "react";
import { useZenGlassConfig } from "@/features/editor/zen/useZenBackgroundAppearance";
import { useReducedMotion } from "@/lib/animation";
import {
  OVERLAY_CONTENT_TOP_CSS,
  OVERLAY_RAIL_SIZE,
  OVERLAY_WIDTH,
  getOverlayLayerId,
} from "./layoutConstants";
import { overlaySlideTransitions } from "./layoutAnimation";
import { getOverlays } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";
import type { OverlayId, ToolWindowPanelId } from "./layoutTypes";
import { PANEL_COMPONENT_MAP } from "./panelComponents";
import { useOverlayDismiss } from "./useOverlayDismiss";

/** パネルの内側の端に取る、影のための余白 (px)。root の overflow clip で切れないようにする。 */
const SHADOW_ROOM_PX = 24;

interface OverlayLayerProps {
  side: OverlayId;
  /** Zen 中は rail を出さないので、画面の端から出す。 */
  zenMode?: boolean;
}

/**
 * オーバーレイの本体の層。grid と Stripe より上（DnD のハイライトとドラッグゴーストの
 * 層より下）に置き、rail の内側の端から平らにスライドして出る。
 *
 * - 閉じている間も unmount しない（スクロール位置や入力途中の文字を残す）。
 *   visibility:hidden + inert で paint とフォーカスを止める。ただし最初に開くまでは
 *   mount せず、起動時に重いパネルを描かない。
 * - 開閉は layout を変えない。PanelChromeMenu（最大化・折りたたみ）は付けない。
 * - 閉じる条件（外の pointerdown／Tab で外へ／Esc）と focus の出し入れは
 *   useOverlayDismiss。
 * - 層自身も Fluid Glass の root（data-workspace-glass-root）にする。層は grid の
 *   glass root の外（兄弟）にあるので、そうしないと背景を有効にしたときに
 *   overlay のパネルだけ Glass の規則（index.css）が効かない。
 * - slide は root（overflow clip の窓）の中でパネルを translateX する。
 *   clip-path ではなく overflow を使うのは、clip-path が Backdrop Root になって
 *   中の Glass を背景から切り離すため（layoutAnimation.ts の REGION_OPEN_CLIP と同じ理由）。
 */
export const OverlayLayer = memo(function OverlayLayer({
  side,
  zenMode = false,
}: OverlayLayerProps) {
  const panel = useLayoutStore((s) => getOverlays(s.layout)[side].panel);
  const open = useLayoutStore((s) => s.openOverlay === side);
  const reduced = useReducedMotion();
  const glass = useZenGlassConfig();
  const layerRef = useRef<HTMLDivElement>(null);
  const dismissHandlers = useOverlayDismiss(side, layerRef);

  // 一度でも開いたパネルだけ保持する。パネルが変わる・空になったら捨てる。
  const seenRef = useRef<ToolWindowPanelId | null>(null);
  if (panel === null || seenRef.current !== panel) seenRef.current = null;
  if (open && panel !== null) seenRef.current = panel;

  if (panel === null) return null;

  const Component = PANEL_COMPONENT_MAP[panel];
  const transitions = overlaySlideTransitions(reduced, open);
  const railOffset = zenMode ? 0 : OVERLAY_RAIL_SIZE;
  const hiddenX = side === "left" ? "-100%" : "100%";

  return (
    <div
      ref={layerRef}
      id={getOverlayLayerId(side)}
      data-overlay-layer={side}
      data-state={open ? "open" : "closed"}
      aria-hidden={!open}
      inert={!open}
      data-workspace-glass-root
      data-workspace-fluid-glass={glass.enabled ? "true" : "false"}
      data-workspace-fluid-glass-refraction={glass.refraction}
      {...dismissHandlers}
      className="pointer-events-none absolute z-40 overflow-clip"
      style={
        {
          "--workspace-fluid-glass-blur": `${glass.blur}px`,
          "--workspace-fluid-glass-saturate": glass.saturation,
          "--workspace-fluid-glass-shine": glass.shine,
          top: 0,
          bottom: 0,
          [side]: railOffset,
          // パネルの幅は OVERLAY_WIDTH（画面幅の半分で頭打ち）。影の余白を内側に足す。
          width: `calc(min(${OVERLAY_WIDTH}px, 50%) + ${SHADOW_ROOM_PX}px)`,
          paddingTop: zenMode ? "var(--gx-outer-pad)" : OVERLAY_CONTENT_TOP_CSS,
          paddingBottom: "var(--gx-outer-pad)",
          visibility: open ? "visible" : "hidden",
          transition: transitions.layer,
        } as React.CSSProperties
      }
    >
      <div
        data-overlay-panel={side}
        // 操作できる要素がまだ無い（lazy パネルの読込中）間の focus の置き場。
        tabIndex={-1}
        data-slot-panel={open ? panel : undefined}
        data-ambient-glass-surface="panel"
        className="gx-panel pointer-events-auto flex outline-none h-full min-h-0 min-w-0 flex-col overflow-hidden"
        style={{
          width: `calc(100% - ${SHADOW_ROOM_PX}px)`,
          // 右のオーバーレイは影の余白が左側に来る。
          marginLeft: side === "right" ? SHADOW_ROOM_PX : 0,
          transform: open ? "translateX(0)" : `translateX(${hiddenX})`,
          transition: transitions.panel,
        }}
      >
        {seenRef.current === panel && Component && (
          // lazy パネル (chronicle 等) の初回 import 中はパネル背景だけ見せる。
          <Suspense fallback={<div className="min-h-0 flex-1" aria-hidden />}>
            <Component key={panel} isActive={open} />
          </Suspense>
        )}
      </div>
    </div>
  );
});
