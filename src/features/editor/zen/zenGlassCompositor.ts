import type { ZenContrastGuardLayout } from "./zenContrastGuard";
import type { ZenGlassLayout } from "./useZenShaderLayouts";

interface ZenGlassMaskSurfaceSize {
  width: number;
  height: number;
}

interface ZenSvgRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ZenContrastKnockout {
  definitions: string;
  element: string;
}

function svgNumber(value: number) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function svgRectGeometry(
  layout: ZenContrastGuardLayout,
  surfaceSize: ZenGlassMaskSurfaceSize,
): ZenSvgRect {
  const [left, bottom, right, top] = layout.rect;
  return {
    x: left * surfaceSize.width,
    y: (1 - top) * surfaceSize.height,
    width: Math.max(0, (right - left) * surfaceSize.width),
    height: Math.max(0, (top - bottom) * surfaceSize.height),
  };
}

function svgRect(layout: ZenGlassLayout, surfaceSize: ZenGlassMaskSurfaceSize) {
  const rect = svgRectGeometry(layout, surfaceSize);
  const radius = Math.min(
    layout.cornerRadius,
    rect.width / 2,
    rect.height / 2,
  );
  return `<rect x="${svgNumber(rect.x)}" y="${svgNumber(rect.y)}" width="${svgNumber(rect.width)}" height="${svgNumber(rect.height)}" rx="${svgNumber(radius)}" ry="${svgNumber(radius)}" fill="white"/>`;
}

function gradientStops(
  startFeather: number,
  span: number,
  endFeather: number,
) {
  const total = startFeather + span + endFeather;
  if (total <= 0) return "";

  const stops: string[] = [];
  if (startFeather > 0) {
    stops.push(
      '<stop offset="0" stop-color="white" stop-opacity="0"/>',
      `<stop offset="${svgNumber(startFeather / total)}" stop-color="white" stop-opacity="1"/>`,
    );
  } else {
    stops.push('<stop offset="0" stop-color="white" stop-opacity="1"/>');
  }
  if (endFeather > 0) {
    stops.push(
      `<stop offset="${svgNumber((startFeather + span) / total)}" stop-color="white" stop-opacity="1"/>`,
      '<stop offset="1" stop-color="white" stop-opacity="0"/>',
    );
  } else {
    stops.push('<stop offset="1" stop-color="white" stop-opacity="1"/>');
  }
  return stops.join("");
}

function buildContrastKnockout(
  layout: ZenContrastGuardLayout | undefined,
  surfaceSize: ZenGlassMaskSurfaceSize,
): ZenContrastKnockout | null {
  if (!layout) return null;
  const rect = svgRectGeometry(layout, surfaceSize);
  if (rect.width <= 0 || rect.height <= 0) return null;

  const leftFeather = Math.min(
    Math.max(0, layout.feather[0] * surfaceSize.width),
    rect.x,
  );
  const bottomFeather = Math.min(
    Math.max(0, layout.feather[1] * surfaceSize.height),
    Math.max(0, surfaceSize.height - rect.y - rect.height),
  );
  const rightFeather = Math.min(
    Math.max(0, layout.feather[2] * surfaceSize.width),
    Math.max(0, surfaceSize.width - rect.x - rect.width),
  );
  const topFeather = Math.min(
    Math.max(0, layout.feather[3] * surfaceSize.height),
    rect.y,
  );
  const outer = {
    x: rect.x - leftFeather,
    y: rect.y - topFeather,
    width: leftFeather + rect.width + rightFeather,
    height: topFeather + rect.height + bottomFeather,
  };
  const xGradient = gradientStops(leftFeather, rect.width, rightFeather);
  const yGradient = gradientStops(topFeather, rect.height, bottomFeather);
  const bounds = `x="${svgNumber(outer.x)}" y="${svgNumber(outer.y)}" width="${svgNumber(outer.width)}" height="${svgNumber(outer.height)}"`;

  return {
    definitions: `<linearGradient id="zen-contrast-x" gradientUnits="userSpaceOnUse" x1="${svgNumber(outer.x)}" y1="0" x2="${svgNumber(outer.x + outer.width)}" y2="0">${xGradient}</linearGradient><linearGradient id="zen-contrast-y" gradientUnits="userSpaceOnUse" x1="0" y1="${svgNumber(outer.y)}" x2="0" y2="${svgNumber(outer.y + outer.height)}">${yGradient}</linearGradient><mask id="zen-contrast-x-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${bounds}><rect ${bounds} fill="url(#zen-contrast-x)"/></mask><mask id="zen-contrast-y-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" ${bounds}><rect ${bounds} fill="url(#zen-contrast-y)"/></mask>`,
    element: `<g mask="url(#zen-contrast-y-mask)"><rect ${bounds} fill="black" mask="url(#zen-contrast-x-mask)"/></g>`,
  };
}

function rectHasArea(layout: ZenContrastGuardLayout) {
  return layout.rect[2] > layout.rect[0] && layout.rect[3] > layout.rect[1];
}

export function hasZenGlassRegion(
  editor: ZenGlassLayout,
  uiSurfaces: readonly ZenGlassLayout[],
) {
  return (
    rectHasArea(editor) ||
    uiSurfaces.some(
      (surface) => surface.refracts !== false && rectHasArea(surface),
    )
  );
}

/** One mask lets Chromium blur every visible Glass region in one compositor layer. */
export function buildZenGlassMask(
  surfaceSize: ZenGlassMaskSurfaceSize,
  editor: ZenGlassLayout,
  uiSurfaces: readonly ZenGlassLayout[],
  contrast?: ZenContrastGuardLayout,
) {
  if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return "none";
  const editorRect = rectHasArea(editor) ? svgRect(editor, surfaceSize) : "";
  const uiRects = uiSurfaces
    .filter(({ refracts }) => refracts !== false)
    .filter(rectHasArea)
    .map((region) => svgRect(region, surfaceSize))
    .join("");
  const contrastKnockout = editorRect
    ? buildContrastKnockout(contrast, surfaceSize)
    : null;
  // The writing-column correction is the final readability pass. Remove only
  // the Editor's Glass filter there, then draw independent UI Glass regions
  // back on top so a floating surface can still refract across the column.
  const maskedRects = contrastKnockout
    ? `${editorRect}${contrastKnockout.element}${uiRects}`
    : `${editorRect}${uiRects}`;
  const body = contrastKnockout
    ? `<defs>${contrastKnockout.definitions}<mask id="zen-glass-mask" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${svgNumber(surfaceSize.width)}" height="${svgNumber(surfaceSize.height)}"><rect x="0" y="0" width="${svgNumber(surfaceSize.width)}" height="${svgNumber(surfaceSize.height)}" fill="black"/>${maskedRects}</mask></defs><rect x="0" y="0" width="${svgNumber(surfaceSize.width)}" height="${svgNumber(surfaceSize.height)}" fill="white" mask="url(#zen-glass-mask)"/>`
    : maskedRects;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNumber(surfaceSize.width)} ${svgNumber(surfaceSize.height)}" preserveAspectRatio="none">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
