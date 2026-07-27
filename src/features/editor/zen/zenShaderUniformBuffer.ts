import type { ZenGlassLayout } from "./useZenShaderLayouts";

export interface ZenUiSurfaceUniforms {
  rects: Float32Array;
  params: Float32Array;
  count: number;
}

/** Stable storage for vec4-array uniforms; avoids nested arrays and `.flat()`. */
export class ZenUiSurfaceUniformBuffer {
  private readonly rects: Float32Array;
  private readonly params: Float32Array;

  constructor(private readonly capacity: number) {
    this.rects = new Float32Array(capacity * 4);
    this.params = new Float32Array(capacity * 4);
  }

  update(surfaces: readonly ZenGlassLayout[]): ZenUiSurfaceUniforms {
    this.rects.fill(0);
    this.params.fill(0);
    const count = Math.min(surfaces.length, this.capacity);
    for (let index = 0; index < count; index += 1) {
      const surface = surfaces[index];
      if (!surface) continue;
      this.rects.set(surface.rect, index * 4);
      this.params[index * 4] = surface.cornerRadius;
    }
    return { rects: this.rects, params: this.params, count };
  }
}
