import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useSceneContentStore,
  subscribeLiveContentRafCoalesced,
  hasLiveContentSubscriber,
} from "./sceneContentStore";

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

  it("hasLiveContentSubscriber は購読者が 1 人でもいれば true (headless writer の resync ゲート)", () => {
    expect(hasLiveContentSubscriber("scene-sub")).toBe(false);
    const unsub = useSceneContentStore
      .getState()
      .subscribe("scene-sub", () => {});
    expect(hasLiveContentSubscriber("scene-sub")).toBe(true);
    expect(hasLiveContentSubscriber("other")).toBe(false);
    unsub();
    expect(hasLiveContentSubscriber("scene-sub")).toBe(false);
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

describe("subscribeLiveContentRafCoalesced", () => {
  // Manual rAF queue — node env doesn't expose requestAnimationFrame,
  // and vitest's fake-timer toFake only mocks globals that already exist.
  const rafQueue = new Map<number, FrameRequestCallback>();
  let rafIdCounter = 0;
  const flushRaf = () => {
    const cbs = Array.from(rafQueue.values());
    rafQueue.clear();
    for (const cb of cbs) cb(performance.now());
  };

  beforeEach(() => {
    resetStore();
    rafQueue.clear();
    rafIdCounter = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = ++rafIdCounter;
      rafQueue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafQueue.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces a burst of N updates into 1 apply per frame (last-write-wins)", () => {
    const apply = vi.fn();
    const unsub = subscribeLiveContentRafCoalesced("scene-1", 0, apply);

    // 100 keystrokes broadcast within a single frame
    for (let i = 0; i < 100; i++) {
      useSceneContentStore
        .getState()
        .setLiveContent("scene-1", { type: "doc", n: i }, 1);
    }
    // Only one rAF should be queued, regardless of broadcast count
    expect(rafQueue.size).toBe(1);
    // Before the frame fires, no apply yet
    expect(apply).not.toHaveBeenCalled();

    flushRaf();

    expect(apply).toHaveBeenCalledTimes(1);
    // Last write wins
    expect(apply).toHaveBeenCalledWith({ type: "doc", n: 99 });

    unsub();
  });

  it("re-arms the rAF after each flush so subsequent bursts are also coalesced", () => {
    const apply = vi.fn();
    const unsub = subscribeLiveContentRafCoalesced("scene-1", 0, apply);

    for (let i = 0; i < 3; i++) {
      useSceneContentStore
        .getState()
        .setLiveContent("scene-1", { type: "doc", n: i }, 1);
    }
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(1);

    for (let i = 100; i < 105; i++) {
      useSceneContentStore
        .getState()
        .setLiveContent("scene-1", { type: "doc", n: i }, 1);
    }
    expect(rafQueue.size).toBe(1);
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith({ type: "doc", n: 104 });

    unsub();
  });

  it("skips updates whose sourceGroupIndex matches ownGroupIndex", () => {
    const apply = vi.fn();
    const unsub = subscribeLiveContentRafCoalesced("scene-1", 7, apply);

    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc", own: true }, 7);
    // Own broadcasts must not even arm a frame
    expect(rafQueue.size).toBe(0);
    flushRaf();
    expect(apply).not.toHaveBeenCalled();

    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc", own: false }, 1);
    flushRaf();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ type: "doc", own: false });

    unsub();
  });

  it("unsubscribe cancels a pending frame and prevents future applies", () => {
    const apply = vi.fn();
    const unsub = subscribeLiveContentRafCoalesced("scene-1", 0, apply);

    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc" }, 1);
    // Frame is pending here
    expect(rafQueue.size).toBe(1);
    unsub();
    expect(rafQueue.size).toBe(0); // cancelled
    flushRaf();
    expect(apply).not.toHaveBeenCalled();

    // Subsequent broadcasts must not invoke apply either
    useSceneContentStore
      .getState()
      .setLiveContent("scene-1", { type: "doc" }, 1);
    flushRaf();
    expect(apply).not.toHaveBeenCalled();
  });

  it("ignores broadcasts to other scene IDs", () => {
    const apply = vi.fn();
    const unsub = subscribeLiveContentRafCoalesced("scene-1", 0, apply);

    useSceneContentStore
      .getState()
      .setLiveContent("scene-2", { type: "doc" }, 1);
    flushRaf();
    expect(apply).not.toHaveBeenCalled();

    unsub();
  });
});
