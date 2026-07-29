import { describe, expect, it } from "vitest";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";

describe("ZenUiSurfaceUniformBuffer", () => {
  it("reuses packed typed arrays while clearing removed surfaces", () => {
    const buffer = new ZenUiSurfaceUniformBuffer(4);
    const first = buffer.update([
      { rect: [0.1, 0.2, 0.3, 0.4], feather: [0, 0, 0, 0], cornerRadius: 12 },
      { rect: [0.5, 0.6, 0.7, 0.8], feather: [0, 0, 0, 0], cornerRadius: 8 },
    ]);
    const second = buffer.update([
      { rect: [0.2, 0.3, 0.4, 0.5], feather: [0, 0, 0, 0], cornerRadius: 10 },
    ]);

    expect(second.rects).toBe(first.rects);
    expect(second.params).toBe(first.params);
    expect([...second.rects.slice(0, 8)]).toEqual([
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
      Math.fround(0.5),
      0,
      0,
      0,
      0,
    ]);
    expect([...second.params.slice(0, 8)]).toEqual([10, 0, 0, 0, 0, 0, 0, 0]);
  });
});
