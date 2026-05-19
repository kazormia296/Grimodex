import { describe, it, expect, beforeEach } from "vitest";
import { useSemanticNavStore } from "./semanticNavStore";

describe("semanticNavStore", () => {
  beforeEach(() => {
    useSemanticNavStore.setState({ pendingJump: null });
  });

  it("starts with no pending jump", () => {
    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
  });

  it("requestJump stores the payload", () => {
    useSemanticNavStore
      .getState()
      .requestJump({ sceneId: "s1", chunkText: "雨が窓を叩いていた。" });
    expect(useSemanticNavStore.getState().pendingJump).toEqual({
      sceneId: "s1",
      chunkText: "雨が窓を叩いていた。",
    });
  });

  it("consumeJump returns the jump and clears it when sceneId matches", () => {
    useSemanticNavStore
      .getState()
      .requestJump({ sceneId: "s1", chunkText: "雨が窓を叩いていた。" });
    const got = useSemanticNavStore.getState().consumeJump("s1");
    expect(got).toEqual({
      sceneId: "s1",
      chunkText: "雨が窓を叩いていた。",
    });
    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
  });

  it("consumeJump returns null and keeps the jump when sceneId differs", () => {
    useSemanticNavStore
      .getState()
      .requestJump({ sceneId: "s1", chunkText: "嵐の場面。" });
    const got = useSemanticNavStore.getState().consumeJump("s2");
    expect(got).toBeNull();
    // 他シーンの consume では消えない。次に s1 に switch したときに拾える。
    expect(useSemanticNavStore.getState().pendingJump).toEqual({
      sceneId: "s1",
      chunkText: "嵐の場面。",
    });
  });

  it("consumeJump on empty store returns null without throwing", () => {
    expect(useSemanticNavStore.getState().consumeJump("s1")).toBeNull();
    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
  });

  it("requestJump overwrites the previous pending jump", () => {
    const store = useSemanticNavStore.getState();
    store.requestJump({ sceneId: "s1", chunkText: "古い。" });
    store.requestJump({ sceneId: "s2", chunkText: "新しい。" });
    expect(useSemanticNavStore.getState().pendingJump).toEqual({
      sceneId: "s2",
      chunkText: "新しい。",
    });
    // s1 の consume は新しい store 状態を見るので拾えない。
    expect(useSemanticNavStore.getState().consumeJump("s1")).toBeNull();
  });
});
