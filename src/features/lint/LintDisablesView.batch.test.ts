// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { collectStoredSceneDisables } from "./LintDisablesView";

function storedDisabledDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { lintDisabled: ["style/repetition"] },
        content: [{ type: "text", text }],
      },
    ],
  });
}

describe("collectStoredSceneDisables", () => {
  it("loads the scene set once and tolerates missing rows", async () => {
    const loadContents = vi.fn(async (sceneIds: string[]) => {
      expect(sceneIds).toEqual(["scene-a", "scene-b"]);
      return new Map([["scene-a", storedDisabledDoc("alpha")]]);
    });

    const result = await collectStoredSceneDisables(
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
        sceneTitle: "First",
        sceneText: "alpha",
        disables: [
          {
            rules: ["style/repetition"],
            range: { start: 0, end: 5 },
          },
        ],
      },
    ]);
  });

  it("preserves best-effort empty output when the batch read fails", async () => {
    const loadContents = vi.fn(async (_sceneIds: string[]) => {
      throw new Error("database unavailable");
    });

    await expect(
      collectStoredSceneDisables(
        [{ id: "scene-a", title: "First" }],
        loadContents,
      ),
    ).resolves.toEqual([]);
    expect(loadContents).toHaveBeenCalledOnce();
  });
});
