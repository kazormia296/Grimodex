import { useEffect, useState, type RefObject } from "react";
import {
  calculateZenContrastGuardLayout,
  EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
  type ZenContrastGuardLayout,
} from "./zenContrastGuard";

export interface ZenShaderLayouts {
  /** Shader surface dimensions in CSS pixels. */
  surfaceSize: {
    width: number;
    height: number;
  };
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
  /** False for Editor chrome that needs UI contrast without another Glass edge. */
  refracts?: boolean;
}

const EMPTY_LAYOUTS: ZenShaderLayouts = {
  surfaceSize: {
    width: 0,
    height: 0,
  },
  contrast: EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
  glass: {
    ...EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
    cornerRadius: 0,
  },
  uiSurfaces: [],
};

const LAYOUT_TARGET_SELECTOR =
  ".zen-editor-paper, [data-editor-area], [data-workspace-glass-root], [data-ambient-glass-surface], [data-editor-tool-surface]";
const UI_SURFACE_SELECTOR = [
  '[data-workspace-glass-root][data-workspace-fluid-glass="true"] [data-ambient-glass-surface]',
  '[data-editor-fluid-glass="true"] [data-editor-tool-surface]',
].join(", ");
const FULLY_VISIBLE_OPACITY = 0.999;

function nodeContainsLayoutTarget(node: Node) {
  return (
    node instanceof Element &&
    (node.matches(LAYOUT_TARGET_SELECTOR) ||
      node.querySelector(LAYOUT_TARGET_SELECTOR) !== null)
  );
}

function nodeHasLayoutTargetDescendant(node: Node) {
  return (
    node instanceof Element &&
    node.querySelector(LAYOUT_TARGET_SELECTOR) !== null
  );
}

export function mutationAffectsZenShaderLayout(
  records: readonly MutationRecord[],
) {
  return records.some(
    (record) =>
      record.type === "attributes" ||
      Array.from(record.addedNodes).some(nodeContainsLayoutTarget) ||
      Array.from(record.removedNodes).some(nodeContainsLayoutTarget) ||
      // Removing an unrelated animated sibling can move a surviving Stripe
      // without resizing it. The removed node no longer identifies the
      // affected surface, but the mutation target still contains that surface.
      (record.type === "childList" &&
        nodeHasLayoutTargetDescendant(record.target)),
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
    current.surfaceSize.width === next.surfaceSize.width &&
    current.surfaceSize.height === next.surfaceSize.height &&
    sameRegion(current.contrast, next.contrast) &&
    sameRegion(current.glass, next.glass) &&
    current.glass.cornerRadius === next.glass.cornerRadius &&
    current.uiSurfaces.length === next.uiSurfaces.length &&
    current.uiSurfaces.every(
      (surface, index) =>
        sameRegion(surface, next.uiSurfaces[index]) &&
        surface.cornerRadius === next.uiSurfaces[index].cornerRadius &&
        (surface.refracts ?? true) ===
          (next.uiSurfaces[index].refracts ?? true),
    )
  );
}

interface VisibleElement {
  element: HTMLElement;
  rect: DOMRect;
}

function elementIsPaintVisible(element: HTMLElement) {
  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    const opacity = Number.parseFloat(style.opacity);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (Number.isFinite(opacity) && opacity < FULLY_VISIBLE_OPACITY)
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function candidateElements(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

function visibleCandidateElements(
  elements: readonly HTMLElement[],
): VisibleElement[] {
  const visible: VisibleElement[] = [];
  for (const element of elements) {
    if (!elementIsPaintVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      visible.push({ element, rect });
    }
  }
  return visible;
}

function intersectionRect(first: DOMRect, second: DOMRect): DOMRect | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function clipPapersToScrollports(
  papers: readonly VisibleElement[],
): VisibleElement[] {
  return papers.flatMap(({ element, rect }) => {
    const scrollport =
      element.closest<HTMLElement>(".glass-editor-body") ?? null;
    if (!scrollport) return [{ element, rect }];

    const clippedRect = intersectionRect(
      rect,
      scrollport.getBoundingClientRect(),
    );
    return clippedRect ? [{ element, rect: clippedRect }] : [];
  });
}

function unionPaperScrollportRect(
  papers: readonly VisibleElement[],
): DOMRect | null {
  if (papers.length === 0) return null;
  const scrollports = new Set<HTMLElement>();
  for (const { element } of papers) {
    const scrollport =
      element.closest<HTMLElement>(".glass-editor-body") ?? null;
    if (!scrollport) return null;
    scrollports.add(scrollport);
  }

  return unionRect(
    Array.from(scrollports, (element) => ({
      element,
      rect: element.getBoundingClientRect(),
    })),
  );
}

function unionRect(elements: readonly VisibleElement[]): DOMRect | null {
  if (elements.length === 0) return null;

  const left = Math.min(...elements.map(({ rect }) => rect.left));
  const top = Math.min(...elements.map(({ rect }) => rect.top));
  const right = Math.max(...elements.map(({ rect }) => rect.right));
  const bottom = Math.max(...elements.map(({ rect }) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function constrainFeatherToBounds(
  layout: ZenContrastGuardLayout,
  surface: DOMRect,
  target: DOMRect,
  bounds: DOMRect,
): ZenContrastGuardLayout {
  if (surface.width <= 0 || surface.height <= 0) return layout;

  return {
    ...layout,
    feather: [
      Math.min(
        layout.feather[0],
        Math.max(0, target.left - bounds.left) / surface.width,
      ),
      Math.min(
        layout.feather[1],
        Math.max(0, bounds.bottom - target.bottom) / surface.height,
      ),
      Math.min(
        layout.feather[2],
        Math.max(0, bounds.right - target.right) / surface.width,
      ),
      Math.min(
        layout.feather[3],
        Math.max(0, target.top - bounds.top) / surface.height,
      ),
    ],
  };
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
    let paperCandidates: HTMLElement[] = [];
    let editorCandidates: HTMLElement[] = [];
    let uiSurfaceCandidates: HTMLElement[] = [];
    let cachedUiLayouts: readonly ZenGlassLayout[] = [];
    let fullLayoutPending = true;
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
          target.removeEventListener("scroll", scheduleScroll);
        }
      }
      for (const target of next) {
        if (!scrollTargets.has(target)) {
          target.addEventListener("scroll", scheduleScroll, { passive: true });
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
            "class",
            "data-editor-fluid-glass",
            "data-editor-tool-surface",
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
      featherBounds?: DOMRect | null,
    ) => {
      if (!elementRect) return EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;
      const layout = calculateZenContrastGuardLayout(
        surfaceRect,
        elementRect,
        featherPx,
      );
      return featherBounds
        ? constrainFeatherToBounds(
            layout,
            surfaceRect,
            elementRect,
            featherBounds,
          )
        : layout;
    };

    const update = () => {
      frame = 0;
      const refreshTargets = fullLayoutPending;
      fullLayoutPending = false;
      if (refreshTargets) {
        uiSurfaceCandidates = Array.from(
          document.querySelectorAll<HTMLElement>(UI_SURFACE_SELECTOR),
        );
        paperCandidates = candidateElements(".zen-editor-paper");
        editorCandidates = candidateElements("[data-editor-area]");
      }
      const visiblePaperCandidates = visibleCandidateElements(paperCandidates);
      const visibleEditors = visibleCandidateElements(editorCandidates);
      const visiblePapers = clipPapersToScrollports(visiblePaperCandidates);
      const visibleUiSurfaces = refreshTargets
        ? visibleCandidateElements(uiSurfaceCandidates)
        : [];
      const glassRoots = refreshTargets
        ? Array.from(
            document.querySelectorAll<HTMLElement>(
              "[data-workspace-glass-root]",
            ),
          )
        : [];
      // Visibility-changing ancestors must remain observed even while their
      // Editor/Paper/UI descendants are currently transparent. Otherwise an
      // enter animation can exclude a target before it ever becomes an
      // observer candidate, leaving the shader mask empty after opacity=1.
      const visibilityTargets = new Set<HTMLElement>();
      for (const candidate of [
        ...paperCandidates,
        ...editorCandidates,
        ...uiSurfaceCandidates,
      ]) {
        let target: HTMLElement | null = candidate;
        while (target && target !== mutationRoot) {
          visibilityTargets.add(target);
          target = target.parentElement;
        }
      }
      const nextScrollTargets = new Set(
        paperCandidates.flatMap((element) => {
          const target = element.closest<HTMLElement>(".glass-editor-body");
          return target ? [target] : [];
        }),
      );
      if (refreshTargets)
        syncResizeTargets(
          new Set([
            surface,
            ...paperCandidates,
            ...editorCandidates,
            ...uiSurfaceCandidates,
            ...nextScrollTargets,
          ]),
        );
      if (refreshTargets) syncScrollTargets(nextScrollTargets);
      if (refreshTargets)
        syncMutationTargets([...glassRoots, ...visibilityTargets]);

      const surfaceRect = surface.getBoundingClientRect();
      const paperRect = unionRect(visiblePapers);
      const paperScrollportRect = unionPaperScrollportRect(
        visiblePaperCandidates,
      );
      const editorRect = unionRect(visibleEditors);
      if (refreshTargets) {
        cachedUiLayouts = visibleUiSurfaces.map(({ element, rect }) => ({
          ...layoutFor(surfaceRect, rect, 0),
          cornerRadius: surfaceCornerRadius(element, rect),
          refracts: element.hasAttribute("data-ambient-glass-surface"),
        }));
      }
      const next = {
        surfaceSize: {
          width: surfaceRect.width,
          height: surfaceRect.height,
        },
        contrast: layoutFor(surfaceRect, paperRect, 48, paperScrollportRect),
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
        uiSurfaces: cachedUiLayouts,
      };
      setLayouts((current) => (sameLayouts(current, next) ? current : next));
    };

    function schedule() {
      fullLayoutPending = true;
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    }

    function scheduleScroll() {
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
        target.removeEventListener("scroll", scheduleScroll);
      }
      window.removeEventListener("resize", schedule);
    };
  }, [surfaceRef]);

  return layouts;
}
