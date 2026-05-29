// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.hoisted(() => ({
  loadSceneChangeEvents: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
}));
vi.mock("./queryEvents", () => queryMock);

import { produceSceneTimelapseWebm, saveWebmBlob } from "./exportTimelapse";

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.loadSceneChangeEvents.mockResolvedValue([]);
});

describe("produceSceneTimelapseWebm", () => {
  it("throws when the scene has no recorded steps", async () => {
    queryMock.loadSceneChangeEvents.mockResolvedValue([]);
    await expect(
      produceSceneTimelapseWebm({ projectId: "p", sceneId: "s" }),
    ).rejects.toThrow(/no recorded editor steps/);
  });

  it("ignores non-doc.step events when deciding emptiness", async () => {
    queryMock.loadSceneChangeEvents.mockResolvedValue([
      { opType: "scene.create" },
      { opType: "snippet.update" },
    ]);
    await expect(
      produceSceneTimelapseWebm({ projectId: "p", sceneId: "s" }),
    ).rejects.toThrow(/no recorded editor steps/);
  });
});

describe("saveWebmBlob", () => {
  it("browser fallback creates an object URL and triggers a download", async () => {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.fn();
    const realCreateEl = document.createElement.bind(document);
    const createElSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = realCreateEl(tag);
        if (tag === "a") el.click = clickSpy;
        return el;
      });

    try {
      const blob = new Blob(["x"], { type: "video/webm" });
      const ok = await saveWebmBlob(blob, "scene.webm");
      expect(ok).toBe(true);
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(clickSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
    } finally {
      createElSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
