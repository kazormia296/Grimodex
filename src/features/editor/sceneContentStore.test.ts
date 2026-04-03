import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSceneContentStore } from "./sceneContentStore";

function resetStore() {
  useSceneContentStore.setState({ liveContent: {} });
}

describe("sceneContentStore", () => {
  beforeEach(() => {
    resetStore();
  });

  it("stores content for a scene", () => {
    const content = { type: "doc", content: [] };
    useSceneContentStore.getState().setLiveContent("scene-1", content, 0);
    expect(useSceneContentStore.getState().liveContent["scene-1"]).toEqual(
      content,
    );
  });

  it("notifies subscribers when content is set", () => {
    const cb = vi.fn();
    useSceneContentStore.getState().subscribe("scene-1", cb);
    const content = { type: "doc", content: [{ type: "paragraph" }] };
    useSceneContentStore.getState().setLiveContent("scene-1", content, 0);
    expect(cb).toHaveBeenCalledWith(content, 0);
  });

  it("does not notify subscribers for different scene IDs", () => {
    const cb = vi.fn();
    useSceneContentStore.getState().subscribe("scene-1", cb);
    useSceneContentStore
      .getState()
      .setLiveContent("scene-2", { type: "doc", content: [] }, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers for the same scene", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    useSceneContentStore.getState().subscribe("scene-1", cb1);
    useSceneContentStore.getState().subscribe("scene-1", cb2);
    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc", content: [] }, 1);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing prevents future notifications", () => {
    const cb = vi.fn();
    const unsubscribe = useSceneContentStore
      .getState()
      .subscribe("scene-1", cb);
    unsubscribe();
    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc", content: [] }, 0);
    expect(cb).not.toHaveBeenCalled();
  });

  it("clears content for a scene", () => {
    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc", content: [] }, 0);
    useSceneContentStore.getState().clearContent("scene-1");
    expect(
      useSceneContentStore.getState().liveContent["scene-1"],
    ).toBeUndefined();
  });

  it("passes sourceGroupIndex to subscribers so they can skip their own updates", () => {
    const cb = vi.fn();
    useSceneContentStore.getState().subscribe("scene-1", cb);
    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc" }, 1);
    expect(cb).toHaveBeenCalledWith(expect.anything(), 1);
  });
});
