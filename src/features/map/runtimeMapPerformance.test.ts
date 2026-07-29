import { afterEach, describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";

import {
  createRuntimeMapDragIdentityControl,
  recordRuntimeMapNodeRender,
  resetRuntimeMapPerformanceForTests,
} from "./runtimeMapPerformance";

function mapNode(id: string, x = 0, y = 0): Node {
  return {
    id,
    type: "scene",
    position: { x, y },
    data: {},
  };
}

afterEach(() => {
  resetRuntimeMapPerformanceForTests();
});

describe("runtime Map drag identity control", () => {
  it("proves the dragged React node changed while unrelated node objects and renders stayed stable", () => {
    const target = mapNode("scene:target");
    const unrelatedA = mapNode("scene:a");
    const unrelatedB = mapNode("scene:b");
    let nodes = [target, unrelatedA, unrelatedB];
    const control = createRuntimeMapDragIdentityControl(() => nodes);

    expect(control.invoke({ action: "prepare", nodeId: target.id })).toEqual({
      unrelatedNodeCount: 2,
    });

    nodes = [{ ...target, position: { x: 48, y: 32 } }, unrelatedA, unrelatedB];
    recordRuntimeMapNodeRender(target.id);

    expect(control.invoke({ action: "finish", nodeId: target.id })).toEqual({
      targetNodeObjectIdentityChanged: true,
      targetNodeRenderCount: 1,
      unrelatedNodeCount: 2,
      unrelatedNodeObjectIdentityChanges: 0,
      unrelatedNodeRenderCount: 0,
      unrelatedRenderedNodeCount: 0,
    });
    control.dispose();
  });

  it("reports unrelated object replacement and render churn even when DOM reuse could hide both", () => {
    const target = mapNode("scene:target");
    const unrelatedA = mapNode("scene:a");
    const unrelatedB = mapNode("scene:b");
    let nodes = [target, unrelatedA, unrelatedB];
    const control = createRuntimeMapDragIdentityControl(() => nodes);

    control.invoke({ action: "prepare", nodeId: target.id });
    nodes = [
      { ...target, position: { x: 48, y: 32 } },
      { ...unrelatedA },
      unrelatedB,
    ];
    recordRuntimeMapNodeRender(target.id);
    recordRuntimeMapNodeRender(unrelatedA.id);
    recordRuntimeMapNodeRender(unrelatedA.id);

    expect(
      control.invoke({ action: "finish", nodeId: target.id }),
    ).toMatchObject({
      unrelatedNodeObjectIdentityChanges: 1,
      unrelatedNodeRenderCount: 2,
      unrelatedRenderedNodeCount: 1,
    });
    control.dispose();
  });

  it("requires a prepared target and rejects a second owner", () => {
    const target = mapNode("scene:target");
    const first = createRuntimeMapDragIdentityControl(() => [target]);
    const second = createRuntimeMapDragIdentityControl(() => [target]);

    expect(() => first.invoke({ action: "finish", nodeId: target.id })).toThrow(
      /not prepared/,
    );
    first.invoke({ action: "prepare", nodeId: target.id });
    expect(() =>
      second.invoke({ action: "prepare", nodeId: target.id }),
    ).toThrow(/already owned/);
    first.dispose();
  });
});
