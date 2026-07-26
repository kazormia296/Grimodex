// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ZenShaderImageCache } from "./zenShaderImageUniforms";

function fakeImage() {
  return {
    crossOrigin: "",
    decode: vi.fn().mockResolvedValue(undefined),
    onerror: null,
    onload: null,
    src: "",
  } as unknown as HTMLImageElement;
}

function finishLoading(image: HTMLImageElement) {
  const onload = image.onload as ((event: Event) => void) | null;
  onload?.(new Event("load"));
}

describe("Zen shader image uniforms", () => {
  it("loads and decodes each source once across repeated uniform objects", async () => {
    const images: HTMLImageElement[] = [];
    const createImage = vi.fn(() => {
      const image = fakeImage();
      images.push(image);
      return image;
    });
    const cache = new ZenShaderImageCache(createImage);
    const source = "data:image/svg+xml,stable-palette";

    const first = cache.prepare({
      u_image: source,
      u_zenGlassRect: [0, 0, 1, 1],
    });
    const second = cache.prepare({
      u_image: source,
      u_zenGlassRect: [0.1, 0.1, 0.9, 0.9],
    });

    expect(createImage).toHaveBeenCalledTimes(1);
    finishLoading(images[0]!);
    const [firstUniforms, secondUniforms] = await Promise.all([first, second]);

    expect(firstUniforms.u_image).toBe(images[0]);
    expect(secondUniforms.u_image).toBe(images[0]);
    expect(images[0]!.decode).toHaveBeenCalledTimes(1);

    const thirdUniforms = cache.prepareSync({
      u_image: source,
      u_zenGlassRect: [0.2, 0.2, 0.8, 0.8],
    });
    expect(thirdUniforms?.u_image).toBe(images[0]);
    expect(createImage).toHaveBeenCalledTimes(1);
  });
});
