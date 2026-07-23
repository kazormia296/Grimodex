import { useEffect, useState, type RefObject } from "react";
import {
  calculateZenContrastGuardLayout,
  EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
  type ZenContrastGuardLayout,
} from "./zenContrastGuard";

export interface ZenShaderLayouts {
  /** Text readability remains scoped to the actual writing column. */
  contrast: ZenContrastGuardLayout;
  /** Glass refraction follows the complete Editor panel boundary. */
  glass: ZenGlassLayout;
  /** Disjoint non-Editor panels and Stripes share Glass without covering gaps. */
  uiSurfaces: readonly ZenGlassLayout[];
}

export interface ZenGlassLayout extends ZenContrastGuardLayout {
  /** CSS pixels; converted to the shader's framebuffer scale on the GPU. */
  cornerRadius: number;
}

const EMPTY_LAYOUTS: ZenShaderLayouts = {
  contrast: EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
  glass: {
    ...EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
    cornerRadius: 0,
  },
  uiSurfaces: [],
};

const LAYOUT_TARGET_SELECTOR =
  ".zen-editor-paper, [data-editor-area], [data-workspace-glass-root], [data-ambient-glass-surface]";
const UI_SURFACE_SELECTOR =
  '[data-workspace-glass-root][data-workspace-fluid-glass="true"] [data-ambient-glass-surface]';
const FULLY_VISIBLE_OPACITY = 0.999;

function nodeContainsLayoutTarget(node: Node) {
  return (
    node instanceof Element &&
    (node.matches(LAYOUT_TARGET_SELECTOR) ||
      node.querySelector(LAYOUT_TARGET_SELECTOR) !== null)
  );
}

export function mutationAffectsZenShaderLayout(
  records: readonly MutationRecord[],
) {
  return records.some(
    (record) =>
      record.type === "attributes" ||
      Array.from(record.addedNodes).some(nodeContainsLayoutTarget) ||
      Array.from(record.removedNodes).some(nodeContainsLayoutTarget),
  );
}

function sameRegion(
  current: ZenContrastGuardLayout,
  next: ZenContrastGuardLayout,
) {
  return (
    current.rect.every((value, index) => value === next.rect[index]) &&
    current.feather.every((value, index) => value === next.feather[index])
  );
}

function sameLayouts(current: ZenShaderLayouts, next: ZenShaderLayouts) {
  return (
    sameRegion(current.contrast, next.contrast) &&
    sameRegion(current.glass, next.glass) &&
    current.glass.cornerRadius === next.glass.cornerRadius &&
    current.uiSurfaces.length === next.uiSurfaces.length &&
    current.uiSurfaces.every(
      (surface, index) =>
        sameRegion(surface, next.uiSurfaces[index]) &&
        surface.cornerRadius === next.uiSurfaces[index].cornerRadius,
    )
  );
}

interface VisibleElement {
  element: HTMLElement;
  rect: DOMRect;
}

function elementIsFullyVisible(element: HTMLElement) {
  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    const opacity = Number.parseFloat(style.opacity);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      current.getAttribute("aria-hidden") === "true" ||
      (Number.isFinite(opacity) && opacity < FULLY_VISIBLE_OPACITY)
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function visibleElements(selector: string): VisibleElement[] {
  const elements = document.querySelectorAll<HTMLElement>(selector);
  const visible: VisibleElement[] = [];
  for (const element of elements) {
    if (!elementIsFullyVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      visible.push({ element, rect });
    }
  }
  return visible;
}

function unionRect(elements: readonly VisibleElement[]): DOMRect | null {
  if (elements.length === 0) return null;

  const left = Math.min(...elements.map(({ rect }) => rect.left));
  const top = Math.min(...elements.map(({ rect }) => rect.top));
  const right = Math.max(...elements.map(({ rect }) => rect.right));
  const bottom = Math.max(...elements.map(({ rect }) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function surfaceCornerRadius(
  element: HTMLElement | null,
  rect: DOMRect | null,
) {
  if (!element) return 0;
  if (!rect) return 0;
  const maximum = Math.min(rect.width, rect.height) * 0.5;
  if (maximum <= 0) return 0;

  const value = getComputedStyle(element).borderTopLeftRadius.trim();
  const match = /^(\d+(?:\.\d+)?)(px|%)\b/.exec(value);
  if (!match) return 0;

  const radius = Number(match[1]);
  if (!Number.isFinite(radius)) return 0;
  const pixels = match[2] === "%" ? (radius / 100) * maximum : radius;
  return Math.min(Math.max(pixels, 0), maximum);
}

/** Tracks geometry only; shader pixels never leave the GPU. */
export function useZenShaderLayouts(surfaceRef: RefObject<HTMLElement | null>) {
  const [layouts, setLayouts] = useState<ZenShaderLayouts>(EMPTY_LAYOUTS);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof document === "undefined") return undefined;

    let frame = 0;
    let resizeTargets = new Set<HTMLElement>();
    let scrollTargets = new Set<HTMLElement>();
    let mutationObserver: MutationObserver | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());
    const mutationRoot =
      document.getElementById("main-content") ?? document.body;

    const syncResizeTargets = (next: Set<HTMLElement>) => {
      for (const target of resizeTargets) {
        if (!next.has(target)) resizeObserver?.unobserve(target);
      }
      for (const target of next) {
        if (!resizeTargets.has(target)) resizeObserver?.observe(target);
      }
      resizeTargets = next;
    };

    const syncScrollTargets = (next: Set<HTMLElement>) => {
      for (const target of scrollTargets) {
        if (!next.has(target)) {
          target.removeEventListener("scroll", schedule);
        }
      }
      for (const target of next) {
        if (!scrollTargets.has(target)) {
          target.addEventListener("scroll", schedule, { passive: true });
        }
      }
      scrollTargets = next;
    };

    const syncMutationTargets = (targets: readonly HTMLElement[]) => {
      mutationObserver?.disconnect();
      mutationObserver?.observe(mutationRoot, {
        childList: true,
        subtree: true,
      });
      for (const target of targets) {
        mutationObserver?.observe(target, {
          attributes: true,
          attributeFilter: [
            "aria-hidden",
            "class",
            "data-workspace-fluid-glass",
            "style",
          ],
        });
      }
    };

    const layoutFor = (
      surfaceRect: DOMRect,
      elementRect: DOMRect | null,
      featherPx = 48,
    ) =>
      elementRect
        ? calculateZenContrastGuardLayout(surfaceRect, elementRect, featherPx)
        : EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;

    const update = () => {
      frame = 0;
      const uiSurfaceCandidates = Array.from(
        document.querySelectorAll<HTMLElement>(UI_SURFACE_SELECTOR),
      );
      const visiblePapers = visibleElements(".zen-editor-paper");
      const visibleEditors = visibleElements("[data-editor-area]");
      const visibleUiSurfaces = visibleElements(UI_SURFACE_SELECTOR);
      const glassRoots = Array.from(
        document.querySelectorAll<HTMLElement>("[data-workspace-glass-root]"),
      );
      const uiVisibilityTargets = new Set<HTMLElement>();
      for (const candidate of uiSurfaceCandidates) {
        let target: HTMLElement | null = candidate;
        while (target && target !== mutationRoot) {
          uiVisibilityTargets.add(target);
          target = target.parentElement;
        }
      }
      const nextScrollTargets = new Set(
        visiblePapers.flatMap(({ element }) => {
          const target = element.closest<HTMLElement>(".glass-editor-body");
          return target ? [target] : [];
        }),
      );
      syncResizeTargets(
        new Set([
          surface,
          ...visiblePapers.map(({ element }) => element),
          ...visibleEditors.map(({ element }) => element),
          ...uiSurfaceCandidates,
          ...nextScrollTargets,
        ]),
      );
      syncScrollTargets(nextScrollTargets);
      syncMutationTargets([
        ...glassRoots,
        ...visibleEditors.map(({ element }) => element),
        ...uiVisibilityTargets,
      ]);

      const surfaceRect = surface.getBoundingClientRect();
      const paperRect = unionRect(visiblePapers);
      const editorRect = unionRect(visibleEditors);
      const next = {
        contrast: layoutFor(surfaceRect, paperRect),
        glass: {
          ...layoutFor(surfaceRect, editorRect),
          cornerRadius:
            visibleEditors.length === 0
              ? 0
              : Math.min(
                  ...visibleEditors.map(({ element, rect }) =>
                    surfaceCornerRadius(element, rect),
                  ),
                ),
        },
        uiSurfaces: visibleUiSurfaces.map(({ element, rect }) => ({
          ...layoutFor(surfaceRect, rect, 0),
          cornerRadius: surfaceCornerRadius(element, rect),
        })),
      };
      setLayouts((current) => (sameLayouts(current, next) ? current : next));
    };

    function schedule() {
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    }

    mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (mutationAffectsZenShaderLayout(records)) schedule();
          });
    mutationObserver?.observe(mutationRoot, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    update();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      for (const target of scrollTargets) {
        target.removeEventListener("scroll", schedule);
      }
      window.removeEventListener("resize", schedule);
    };
  }, [surfaceRef]);

  return layouts;
}
