import { describe, expect, it } from "vitest";
import { buildZenGlassMask } from "./zenGlassCompositor";

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
});
