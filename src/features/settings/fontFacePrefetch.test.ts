import { describe, expect, it, vi } from "vitest";
import { prefetchFontFaces, shouldPrefetchFontFaces } from "./fontFacePrefetch";

function fakeFace(
  family: string,
  status: string,
  load = vi.fn(async () => {}),
) {
  return { family, status, load } as unknown as FontFace;
}

function fakeFonts(faces: FontFace[]) {
  return {
    forEach: (callback: (face: FontFace) => void) => faces.forEach(callback),
  } as Pick<FontFaceSet, "forEach">;
}

describe("prefetchFontFaces", () => {
  it("loads every unloaded slice of the family, quoted or not, and nothing else", async () => {
    const slice0 = fakeFace('"Noto Serif JP"', "unloaded");
    const slice1 = fakeFace("Noto Serif JP", "unloaded");
    const loaded = fakeFace("Noto Serif JP", "loaded");
    const other = fakeFace('"Literata"', "unloaded");

    const count = await prefetchFontFaces(
      "Noto Serif JP",
      fakeFonts([slice0, slice1, loaded, other]),
    );

    expect(count).toBe(2);
    expect(slice0.load).toHaveBeenCalledTimes(1);
    expect(slice1.load).toHaveBeenCalledTimes(1);
    expect(loaded.load).not.toHaveBeenCalled();
    expect(other.load).not.toHaveBeenCalled();
  });

  it("ignores a slice that fails to load", async () => {
    const failing = fakeFace(
      "M PLUS 1",
      "unloaded",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    await expect(
      prefetchFontFaces("M PLUS 1", fakeFonts([failing])),
    ).resolves.toBe(1);
  });

  it("only prefetches the sliced Japanese families", async () => {
    expect(shouldPrefetchFontFaces("Noto Serif JP")).toBe(true);
    expect(shouldPrefetchFontFaces("M PLUS 1")).toBe(true);
    expect(shouldPrefetchFontFaces("LINE Seed JP")).toBe(false);
    const face = fakeFace("LINE Seed JP", "unloaded");
    await expect(
      prefetchFontFaces("LINE Seed JP", fakeFonts([face])),
    ).resolves.toBe(0);
    expect(face.load).not.toHaveBeenCalled();
  });

  it("does nothing without a FontFaceSet", async () => {
    await expect(prefetchFontFaces("Noto Serif JP", null)).resolves.toBe(0);
  });
});
