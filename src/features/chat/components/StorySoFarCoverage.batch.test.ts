// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { loadStorySoFarContents } from "./StorySoFarCoverage";

describe("loadStorySoFarContents", () => {
  it("loads every requested synopsis source in one batch", async () => {
    const contents = new Map([
      ["scene-a", "alpha"],
      ["scene-b", "bravo"],
    ]);
    const loadBatch = vi.fn(async (sceneIds: string[]) => {
      expect(sceneIds).toEqual(["scene-a", "scene-b"]);
      return contents;
    });

    await expect(
      loadStorySoFarContents(["scene-a", "scene-b"], loadBatch),
    ).resolves.toBe(contents);
    expect(loadBatch).toHaveBeenCalledOnce();
  });

  it("returns null so the existing per-item failure accounting can continue", async () => {
    const loadBatch = vi.fn(async (_sceneIds: string[]) => {
      throw new Error("database unavailable");
    });

    await expect(
      loadStorySoFarContents(["scene-a"], loadBatch),
    ).resolves.toBeNull();
  });
});
