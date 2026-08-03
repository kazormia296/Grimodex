// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { loadChronicleExtractionScenes } from "./ChronicleExtractDialog";

function storedDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

describe("loadChronicleExtractionScenes", () => {
  it("uses one batch and preserves order plus missing-row behavior", async () => {
    const loadContents = vi.fn(async (sceneIds: string[]) => {
      expect(sceneIds).toEqual(["scene-a", "scene-b"]);
      return new Map([["scene-a", storedDoc("alpha")]]);
    });

    const result = await loadChronicleExtractionScenes(
      [
        { id: "scene-a", title: "First" },
        { id: "scene-b", title: "Missing" },
      ],
      loadContents,
    );

    expect(loadContents).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        sceneId: "scene-a",
        title: "First",
        bodyText: "alpha",
        orderIndex: 0,
      },
      {
        sceneId: "scene-b",
        title: "Missing",
        bodyText: "",
        orderIndex: 1,
      },
    ]);
  });

  it("rejects a batch failure so the dialog keeps its existing error flow", async () => {
    const loadContents = vi.fn(async (_sceneIds: string[]) => {
      throw new Error("database unavailable");
    });

    await expect(
      loadChronicleExtractionScenes(
        [{ id: "scene-a", title: "First" }],
        loadContents,
      ),
    ).rejects.toThrow("database unavailable");
  });
});
