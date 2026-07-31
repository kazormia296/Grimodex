import { describe, expect, it, vi } from "vitest";
import { backfillPlacedBeatPreview } from "./placedBeatPreviewBackfill";

describe("backfillPlacedBeatPreview", () => {
  it("loaded tree binding の project/version を OCC write に渡して新 version を返す", async () => {
    const savePlacedBeatPreviewOnly = vi.fn().mockResolvedValue({
      contentVersion: 8,
      contentUpdatedAt: "2100-01-01T00:00:00.000Z",
    });
    const binding = {
      kind: "tree" as const,
      id: "scene-1",
      nodeType: "scene" as const,
      storage: "database" as const,
      loadedVersion: 7,
    };

    await expect(
      backfillPlacedBeatPreview(binding, "project-1", '[{"id":"beat-1"}]', {
        savePlacedBeatPreviewOnly,
      }),
    ).resolves.toEqual({ ...binding, loadedVersion: 8 });
    expect(savePlacedBeatPreviewOnly).toHaveBeenCalledWith("scene-1", {
      placedBeatPreview: '[{"id":"beat-1"}]',
      projectId: "project-1",
      baseVersion: 7,
    });
  });

  it("OCC conflict を握り潰さず、stale binding を公開しない", async () => {
    const savePlacedBeatPreviewOnly = vi
      .fn()
      .mockRejectedValue(new Error("Scene content conflict"));
    const binding = {
      kind: "tree" as const,
      id: "scene-1",
      nodeType: "scene" as const,
      storage: "database" as const,
      loadedVersion: 7,
    };

    await expect(
      backfillPlacedBeatPreview(binding, "project-1", '[{"id":"beat-1"}]', {
        savePlacedBeatPreviewOnly,
      }),
    ).rejects.toThrow(/conflict/i);
  });
});
