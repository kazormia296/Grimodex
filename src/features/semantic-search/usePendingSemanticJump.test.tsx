// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSemanticNavStore } from "./semanticNavStore";
import { usePendingSemanticJump } from "./usePendingSemanticJump";

function Harness({
  sceneId,
  ready,
  applyJump,
}: {
  sceneId: string | null;
  ready: boolean;
  applyJump: (jump: { sceneId: string; chunkText: string }) => void;
}) {
  usePendingSemanticJump({ sceneId, ready, applyJump });
  return null;
}

describe("usePendingSemanticJump", () => {
  beforeEach(() => {
    useSemanticNavStore.setState({ pendingJump: null });
  });

  it("consumes a jump queued while a preloaded pane was hidden", () => {
    const applyJump = vi.fn();
    const { rerender } = render(
      <Harness sceneId={null} ready applyJump={applyJump} />,
    );
    useSemanticNavStore
      .getState()
      .requestJump({ sceneId: "scene-b", chunkText: "target" });
    expect(applyJump).not.toHaveBeenCalled();

    rerender(<Harness sceneId="scene-b" ready applyJump={applyJump} />);

    expect(applyJump).toHaveBeenCalledWith({
      sceneId: "scene-b",
      chunkText: "target",
    });
    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
  });

  it("waits until a newly projected document has loaded", () => {
    const applyJump = vi.fn();
    useSemanticNavStore
      .getState()
      .requestJump({ sceneId: "scene-b", chunkText: "target" });
    const { rerender } = render(
      <Harness sceneId="scene-b" ready={false} applyJump={applyJump} />,
    );
    expect(useSemanticNavStore.getState().pendingJump).not.toBeNull();

    rerender(<Harness sceneId="scene-b" ready applyJump={applyJump} />);
    expect(applyJump).toHaveBeenCalledOnce();
    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
  });
});
