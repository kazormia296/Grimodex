import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getPanelRect } from "@/features/layout/PanelHighlightOverlay";
import type { PanelId } from "@/features/layout/layoutStore";

export interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Build an SVG clip-path that cuts holes for each rect (even-odd fill). */
export function buildFocusClipPath(
  rects: FocusRect[],
  vw: number,
  vh: number,
): string {
  if (rects.length === 0) return "";
  const holes = rects
    .map(
      (r) =>
        `M ${r.left} ${r.top} H ${r.left + r.width} V ${r.top + r.height} H ${r.left} Z`,
    )
    .join(" ");
  return `path(evenodd, 'M 0 0 H ${vw} V ${vh} H 0 Z ${holes}')`;
}

/** Axis-aligned bounding box of a non-empty array of rects. */
export function boundingRect(rects: FocusRect[]): FocusRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.left + r.width));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  return { left, top, width: right - left, height: bottom - top };
}

function queryTargetRects(targets: string[]): FocusRect[] {
  const rects: FocusRect[] = [];
  for (const id of targets) {
    const el = document.querySelector(`[data-tour-target="${CSS.escape(id)}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      rects.push({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      });
    }
  }
  return rects;
}

function computeRects(
  panelId: PanelId | null,
  targets?: string[],
): FocusRect[] {
  // Element-level targets take priority; fall back to panel rect if nothing found.
  if (targets && targets.length > 0) {
    const rects = queryTargetRects(targets);
    if (rects.length > 0) return rects;
  }
  if (panelId) {
    const r = getPanelRect(panelId);
    if (r) return [r];
  }
  return [];
}

interface FocusRectsState {
  rects: FocusRect[];
  vw: number;
  vh: number;
}

/**
 * Returns the set of rects that the spotlight should cut holes for.
 *
 * Priority: `targets` (data-tour-target queries) > `panelId` rect > empty.
 * Remeasures on DOM resize.
 */
export function useFocusRects(
  panelId: PanelId | null,
  targets?: string[],
): FocusRectsState {
  const [state, setState] = useState<FocusRectsState>({
    rects: [],
    vw: 0,
    vh: 0,
  });

  useLayoutEffect(() => {
    function measure() {
      setState({
        rects: computeRects(panelId, targets),
        vw: window.innerWidth,
        vh: window.innerHeight,
      });
    }

    measure();

    const container = document.querySelector("[data-layout-shell]");
    const resizeObserver = new ResizeObserver(measure);
    if (container) resizeObserver.observe(container);
    window.addEventListener("resize", measure);

    // Re-measure when a slot panel enters/leaves the DOM, OR when the
    // active-panel marker moves between keepalive siblings (AnimatedSlotPanel
    // keeps inactive panels mounted and toggles `data-slot-panel` on the
    // visible one, so childList alone misses the swap).
    // showPanel() is called in a useEffect (after paint), so the target panel
    // may not exist yet when useFocusRects first measures on step entry, and
    // ResizeObserver won't re-fire when slot content swaps in place.
    function hasSlotPanel(nodes: NodeList): boolean {
      for (const node of nodes) {
        if (node instanceof Element && node.hasAttribute("data-slot-panel")) {
          return true;
        }
      }
      return false;
    }
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (
          mut.type === "attributes" &&
          mut.attributeName === "data-slot-panel"
        ) {
          measure();
          return;
        }
        if (
          mut.type === "childList" &&
          (hasSlotPanel(mut.addedNodes) || hasSlotPanel(mut.removedNodes))
        ) {
          measure();
          return;
        }
      }
    });
    if (container) {
      mutationObserver.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-slot-panel"],
      });
    }

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [panelId, targets]);

  return state;
}

interface SpotlightOverlayProps {
  panelId: PanelId | null;
  targets?: string[];
}

export function SpotlightOverlay({ panelId, targets }: SpotlightOverlayProps) {
  const { rects, vw, vh } = useFocusRects(panelId, targets);
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const clipPath =
    rects.length > 0 && vw && vh
      ? buildFocusClipPath(rects, vw, vh)
      : undefined;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        pointerEvents: "none",
        background: "oklch(0 0 0 / 0.4)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.35s ease, clip-path 0.25s ease",
        clipPath,
      }}
    />,
    document.body,
  );
}
