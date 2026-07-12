import { describe, expect, it, vi } from "vitest";
import { applySceneSidecars, loadSceneSidecars } from "./sceneSidecars";

describe("loadSceneSidecars", () => {
  it("keeps successful sidecars when one parallel load fails", async () => {
    const loadAuthorshipSpans = vi
      .fn()
      .mockRejectedValue(new Error("authorship unavailable"));
    const loadForeshadowAnchors = vi.fn().mockResolvedValue([]);
    const listAnnotationsForScene = vi
      .fn()
      .mockResolvedValue({ annotations: [] });

    const result = await loadSceneSidecars("scene-1", "project-1", {
      loadAuthorshipSpans,
      loadForeshadowAnchors,
      listAnnotationsForScene,
    });

    expect(result.spans).toEqual([]);
    expect(result.foreshadowMarks).toEqual([]);
    expect(result.annotations).toEqual({ annotations: [] });
    expect(result.errors).toEqual([
      { label: "authorshipSpans", reason: expect.any(Error) },
    ]);
    expect(listAnnotationsForScene).toHaveBeenCalledWith({
      projectId: "project-1",
      sceneId: "scene-1",
    });
  });
});

describe("applySceneSidecars", () => {
  it("does not dispatch editor marks after cancellation", () => {
    const editor = {
      schema: { marks: {} },
      chain: vi.fn(),
    };

    applySceneSidecars(
      editor as never,
      "scene-1",
      {
        spans: [],
        foreshadowMarks: [],
        annotations: null,
        errors: [],
      },
      () => true,
    );

    expect(editor.chain).not.toHaveBeenCalled();
  });
});
