import { describe, expect, it, vi } from "vitest";

// DA-2b (Negative (11); DR-DA2B-R5): the lens list is an own-data-read. A D2a
// refusal (activation stages 2-7, unavailable) keeps the previous badges
// instead of clearing them as if no lens existed.

const { listSceneLensForProject } = vi.hoisted(() => ({
  listSceneLensForProject: vi.fn(),
}));
vi.mock("./api", () => ({ listSceneLensForProject }));

import { useLensStore } from "./lensStore";

describe("lens store and a D2a refusal", () => {
  it("keeps the previous lens records", async () => {
    listSceneLensForProject.mockResolvedValueOnce([
      { targetId: "scene-1", id: "lens-1" },
    ]);
    await useLensStore.getState().load("p1");
    const before = useLensStore.getState().bySceneId;
    expect(before.get("scene-1")).toHaveLength(1);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    listSceneLensForProject.mockRejectedValueOnce(
      new Error(
        "D2A_EGRESS_DENIED: plaintext-publication: route list_scene_lens_for_project",
      ),
    );
    await useLensStore.getState().load("p1");
    expect(useLensStore.getState().bySceneId).toBe(before);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
