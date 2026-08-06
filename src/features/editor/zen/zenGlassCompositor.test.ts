import { describe, expect, it } from "vitest";
import { buildZenGlassMask, hasZenGlassRegion } from "./zenGlassCompositor";
import type { ZenGlassLayout } from "./useZenShaderLayouts";

function decodeMask(mask: string) {
  const prefix = 'url("data:image/svg+xml,';
  return decodeURIComponent(mask.slice(prefix.length, -2));
}

describe("buildZenGlassMask", () => {
  it("keeps CSS-pixel corner radii on a non-square shader surface", () => {
    const mask = buildZenGlassMask(
      { width: 1_920, height: 1_080 },
      {
        rect: [0.125, 0.125, 0.875, 0.875],
        feather: [0, 0, 0, 0],
        cornerRadius: 18,
      },
      [],
    );
    const svg = decodeMask(mask);

    expect(svg).toContain('viewBox="0 0 1920 1080"');
    expect(svg).toContain(
      '<rect x="240" y="135" width="1440" height="810" rx="18" ry="18"',
    );
  });

  it("returns no mask until the shader surface has measurable dimensions", () => {
    expect(
      buildZenGlassMask(
        { width: 0, height: 1_080 },
        {
          rect: [0, 0, 1, 1],
          feather: [0, 0, 0, 0],
          cornerRadius: 18,
        },
        [],
      ),
    ).toBe("none");
  });

  it("does not add contrast-only Editor chrome as another Glass edge", () => {
    const svg = decodeMask(
      buildZenGlassMask(
        { width: 1_000, height: 600 },
        {
          rect: [0.2, 0.1, 0.8, 0.9],
          feather: [0, 0, 0, 0],
          cornerRadius: 18,
        },
        [
          {
            rect: [0.2, 0.8, 0.8, 0.9],
            feather: [0, 0, 0, 0],
            cornerRadius: 0,
            refracts: false,
          },
        ],
      ),
    );

    expect(svg.match(/<rect /g)).toHaveLength(1);
  });

  it("subtracts the feathered paper guard from shared Glass filtering", () => {
    const svg = decodeMask(
      buildZenGlassMask(
        { width: 1_000, height: 600 },
        {
          rect: [0.1, 0.1, 0.9, 0.9],
          feather: [0, 0, 0, 0],
          cornerRadius: 18,
        },
        [
          {
            rect: [0.4, 0.4, 0.6, 0.6],
            feather: [0, 0, 0, 0],
            cornerRadius: 12,
          },
        ],
        {
          rect: [0.3, 0.2, 0.7, 0.8],
          feather: [0.05, 0.1, 0.05, 0.1],
        },
      ),
    );

    expect(svg).toContain('id="zen-glass-mask"');
    expect(svg).toContain(
      'id="zen-contrast-x" gradientUnits="userSpaceOnUse" x1="250" y1="0" x2="750" y2="0"',
    );
    expect(svg).toContain(
      'id="zen-contrast-y" gradientUnits="userSpaceOnUse" x1="0" y1="60" x2="0" y2="540"',
    );
    expect(svg).toContain(
      'x="250" y="60" width="500" height="480" fill="black"',
    );
    expect(
      svg.indexOf('fill="black" mask="url(#zen-contrast-x-mask)"'),
    ).toBeLessThan(svg.lastIndexOf('rx="12" ry="12" fill="white"'));
    expect(svg).toContain(
      '<stop offset="0.1" stop-color="white" stop-opacity="1"/>',
    );
    expect(svg).toContain(
      '<stop offset="0.875" stop-color="white" stop-opacity="1"/>',
    );
  });
});

describe("hasZenGlassRegion", () => {
  const emptyEditor: ZenGlassLayout = {
    rect: [0, 0, 0, 0],
    feather: [0, 0, 0, 0],
    cornerRadius: 0,
  };

  it("keeps the shared compositor for an editor-only Glass surface", () => {
    expect(
      hasZenGlassRegion(
        {
          ...emptyEditor,
          rect: [0.1, 0.1, 0.9, 0.9],
        },
        [],
      ),
    ).toBe(true);
  });

  it("ignores contrast-only UI surfaces when deciding whether to composite", () => {
    expect(
      hasZenGlassRegion(emptyEditor, [
        {
          ...emptyEditor,
          rect: [0.1, 0.1, 0.9, 0.2],
          refracts: false,
        },
      ]),
    ).toBe(false);
  });
});
