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
};

const LAYOUT_TARGET_SELECTOR = ".zen-editor-paper, [data-editor-area]";

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
    current.glass.cornerRadius === next.glass.cornerRadius
  );
}

interface VisibleElement {
  element: HTMLElement;
  rect: DOMRect;
}

function visibleElement(selector: string): VisibleElement | null {
  const elements = document.querySelectorAll<HTMLElement>(selector);
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { element, rect };
  }
  return null;
}

function editorCornerRadius(element: HTMLElement | null, rect: DOMRect | null) {
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
    let paper: HTMLElement | null = null;
    let editor: HTMLElement | null = null;
    let scrollTarget: HTMLElement | null = null;
    let mutationObserver: MutationObserver | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => schedule());

    const observeTarget = (
      current: HTMLElement | null,
      next: HTMLElement | null,
    ) => {
      if (current === next) return next;
      if (current) resizeObserver?.unobserve(current);
      if (next) resizeObserver?.observe(next);
      return next;
    };
    const observeScrollTarget = (
      current: HTMLElement | null,
      next: HTMLElement | null,
    ) => {
      if (current === next) return next;
      current?.removeEventListener("scroll", schedule);
      next?.addEventListener("scroll", schedule, { passive: true });
      return next;
    };

    const layoutFor = (surfaceRect: DOMRect, elementRect: DOMRect | null) =>
      elementRect
        ? calculateZenContrastGuardLayout(surfaceRect, elementRect)
        : EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;

    const update = () => {
      frame = 0;
      const visiblePaper = visibleElement(".zen-editor-paper");
      const visibleEditor = visibleElement("[data-editor-area]");
      paper = observeTarget(paper, visiblePaper?.element ?? null);
      editor = observeTarget(editor, visibleEditor?.element ?? null);
      scrollTarget = observeScrollTarget(
        scrollTarget,
        paper?.closest<HTMLElement>(".glass-editor-body") ?? null,
      );
      if (editor) {
        mutationObserver?.observe(editor, {
          attributes: true,
          attributeFilter: ["class", "style"],
        });
      }
      const surfaceRect = surface.getBoundingClientRect();
      const next = {
        contrast: layoutFor(surfaceRect, visiblePaper?.rect ?? null),
        glass: {
          ...layoutFor(surfaceRect, visibleEditor?.rect ?? null),
          cornerRadius: editorCornerRadius(
            visibleEditor?.element ?? null,
            visibleEditor?.rect ?? null,
          ),
        },
      };
      setLayouts((current) => (sameLayouts(current, next) ? current : next));
    };

    function schedule() {
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    }

    resizeObserver?.observe(surface);
    const mutationRoot =
      document.getElementById("main-content") ?? document.body;
    mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (mutationAffectsZenShaderLayout(records)) schedule();
          });
    mutationObserver?.observe(mutationRoot, { childList: true, subtree: true });
    // Card mode changes the Editor's computed radius without resizing it.
    // The app shell sits above #main-content, so observe it separately.
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    if (appShell && appShell !== mutationRoot) {
      mutationObserver?.observe(appShell, {
        attributes: true,
        attributeFilter: ["data-card"],
      });
    }
    window.addEventListener("resize", schedule);
    update();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      scrollTarget?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [surfaceRef]);

  return layouts;
}
