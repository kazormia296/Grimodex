import type { ZenGlassLayout } from "./useZenShaderLayouts";

interface ZenGlassMaskSurfaceSize {
  width: number;
  height: number;
}

function svgRect(layout: ZenGlassLayout, surfaceSize: ZenGlassMaskSurfaceSize) {
  const [left, bottom, right, top] = layout.rect;
  const x = left * surfaceSize.width;
  const y = (1 - top) * surfaceSize.height;
  const width = Math.max(0, (right - left) * surfaceSize.width);
  const height = Math.max(0, (top - bottom) * surfaceSize.height);
  const radius = Math.min(layout.cornerRadius, width / 2, height / 2);
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/>`;
}

/** One mask lets Chromium blur every visible Glass region in one compositor layer. */
export function buildZenGlassMask(
  surfaceSize: ZenGlassMaskSurfaceSize,
  editor: ZenGlassLayout,
  uiSurfaces: readonly ZenGlassLayout[],
) {
  if (surfaceSize.width <= 0 || surfaceSize.height <= 0) return "none";
  const regions = [
    editor,
    ...uiSurfaces.filter(({ refracts }) => refracts !== false),
  ].filter(({ rect }) => rect[2] > rect[0] && rect[3] > rect[1]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${surfaceSize.width} ${surfaceSize.height}" preserveAspectRatio="none">${regions.map((region) => svgRect(region, surfaceSize)).join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
