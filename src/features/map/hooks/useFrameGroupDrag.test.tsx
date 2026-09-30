// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import type { Node, OnNodeDrag } from "@xyflow/react";
import { expect, it, vi } from "vitest";
import { useFrameGroupDrag } from "./useFrameGroupDrag";

it("moves contained nodes with native drag events and retains marks until persistence completes", async () => {
  const frame: Node = {
    id: "frame:1",
    position: { x: 0, y: 0 },
    data: {},
    style: { width: 400, height: 300 },
  };
  let nodes: Node[] = [
    frame,
    { id: "scene:1", type: "scene", position: { x: 10, y: 20 }, data: {} },
    { id: "scene:2", type: "scene", position: { x: 500, y: 500 }, data: {} },
  ];
  let completePersist!: () => void;
  const persistPosition = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        completePersist = resolve;
      }),
  );
  const groupDraggingRef = { current: new Set<string>() };
  const { result } = renderHook(() =>
    useFrameGroupDrag({
      getNodes: () => nodes,
      setNodes: (update) => {
        nodes = typeof update === "function" ? update(nodes) : update;
      },
      persistPosition,
      groupDraggingRef,
    }),
  );
  // React Flow supplies native events; the callbacks must accept its complete contract.
  const start: OnNodeDrag = result.current.onNodeDragStart;
  const drag: OnNodeDrag = result.current.onNodeDrag;
  const stop: OnNodeDrag = result.current.onNodeDragStop;
  act(() => start(new MouseEvent("mousedown"), frame, nodes));
  expect([...groupDraggingRef.current]).toEqual(["scene:1"]);
  const movedFrame = { ...frame, position: { x: 50, y: 80 } };
  act(() => drag(new MouseEvent("mousemove"), movedFrame, nodes));
  expect(nodes[1].position).toEqual({ x: 60, y: 100 });
  expect(nodes[2].position).toEqual({ x: 500, y: 500 });
  act(() => stop(new MouseEvent("mouseup"), movedFrame, nodes));
  expect(persistPosition).toHaveBeenCalledExactlyOnceWith("scene:1", 60, 100);
  expect(groupDraggingRef.current.has("scene:1")).toBe(true);
  await act(async () => completePersist());
  expect(groupDraggingRef.current.size).toBe(0);
});
