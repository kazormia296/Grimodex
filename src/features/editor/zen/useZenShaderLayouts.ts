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
  glass: ZenContrastGuardLayout;
}

const EMPTY_LAYOUTS: ZenShaderLayouts = {
  contrast: EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
  glass: EMPTY_ZEN_CONTRAST_GUARD_LAYOUT,
};

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
    sameRegion(current.glass, next.glass)
  );
}

function visibleElement(selector: string): HTMLElement | null {
  const elements = document.querySelectorAll<HTMLElement>(selector);
  return (
    Array.from(elements).find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) ?? null
  );
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

    const layoutFor = (element: HTMLElement | null) =>
      element
        ? calculateZenContrastGuardLayout(
            surface.getBoundingClientRect(),
            element.getBoundingClientRect(),
          )
        : EMPTY_ZEN_CONTRAST_GUARD_LAYOUT;

    const update = () => {
      frame = 0;
      paper = observeTarget(paper, visibleElement(".zen-editor-paper"));
      editor = observeTarget(editor, visibleElement("[data-editor-area]"));
      const next = {
        contrast: layoutFor(paper),
        glass: layoutFor(editor),
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
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(schedule);
    mutationObserver?.observe(mutationRoot, { childList: true, subtree: true });
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    update();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [surfaceRef]);

  return layouts;
}
