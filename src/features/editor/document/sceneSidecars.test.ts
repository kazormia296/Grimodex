import { describe, expect, it, vi } from "vitest";
import {
  applySceneSidecars,
  loadSceneSidecars,
  SceneForeshadowAnchorsUnavailableError,
} from "./sceneSidecars";

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

  it("retains a D2a foreshadow denial for the caller to handle", async () => {
    const result = await loadSceneSidecars("scene-1", "project-1", {
      loadAuthorshipSpans: vi.fn().mockResolvedValue([]),
      loadForeshadowAnchors: vi
        .fn()
        .mockRejectedValue(new Error("D2A_EGRESS_DENIED: plaintext-publication")),
      listAnnotationsForScene: vi.fn().mockResolvedValue({ annotations: [] }),
    });

    expect(result.errors).toEqual([
      {
        label: "foreshadowAnchors",
        reason: expect.any(Error),
      },
    ]);
    expect((result.errors[0]?.reason as Error).message).toContain(
      "D2A_EGRESS_DENIED:",
    );
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

  it("does not apply a denied foreshadow read as an empty mark projection", () => {
    const editor = {
      schema: { marks: {} },
      chain: vi.fn(),
    };

    expect(() =>
      applySceneSidecars(
        editor as never,
        "scene-1",
        {
          spans: [],
          foreshadowMarks: [],
          annotations: { annotations: [] } as never,
          errors: [
            {
              label: "foreshadowAnchors",
              reason: new Error("D2A_EGRESS_DENIED: plaintext-publication"),
            },
          ],
        },
        () => false,
      ),
    ).toThrow(SceneForeshadowAnchorsUnavailableError);
    expect(editor.chain).not.toHaveBeenCalled();
  });
});
