import type { Node } from "@xyflow/react";

type RuntimeMapDragIdentityPayload =
  | { action: "prepare"; nodeId: string }
  | { action: "finish"; nodeId: string }
  | { action: "cleanup"; nodeId: string };

interface RuntimeMapDragIdentityState {
  owner: symbol;
  targetNodeId: string;
  targetNode: Node;
  unrelatedNodes: Map<string, Node>;
  renderCountByNodeId: Map<string, number>;
}

let activeDragIdentityState: RuntimeMapDragIdentityState | null = null;

function parseRuntimeMapDragIdentityPayload(
  payload: unknown,
): RuntimeMapDragIdentityPayload {
  if (!payload || typeof payload !== "object") {
    throw new Error("runtime Map drag identity payload is invalid");
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.nodeId !== "string" ||
    value.nodeId.length === 0 ||
    !["prepare", "finish", "cleanup"].includes(String(value.action))
  ) {
    throw new Error("runtime Map drag identity payload is invalid");
  }
  return {
    action: value.action as RuntimeMapDragIdentityPayload["action"],
    nodeId: value.nodeId,
  };
}

/**
 * Count custom-node component evaluation only while the benchmark owns an
 * active drag measurement. Normal production uses the unwrapped nodeTypes map,
 * so this function is never entered on its render path.
 */
export function recordRuntimeMapNodeRender(nodeId: string): void {
  const state = activeDragIdentityState;
  if (!state) return;
  state.renderCountByNodeId.set(
    nodeId,
    (state.renderCountByNodeId.get(nodeId) ?? 0) + 1,
  );
}

export function createRuntimeMapDragIdentityControl(
  getNodes: () => readonly Node[],
) {
  const owner = Symbol("runtime-map-drag-identity-owner");

  const release = () => {
    if (activeDragIdentityState?.owner === owner) {
      activeDragIdentityState = null;
    }
  };

  return {
    invoke(payload: unknown) {
      const control = parseRuntimeMapDragIdentityPayload(payload);

      if (control.action === "prepare") {
        if (activeDragIdentityState) {
          throw new Error("runtime Map drag identity is already owned");
        }
        const nodes = getNodes();
        const targetNode = nodes.find((node) => node.id === control.nodeId);
        if (!targetNode) {
          throw new Error("runtime Map drag identity target is missing");
        }
        activeDragIdentityState = {
          owner,
          targetNodeId: control.nodeId,
          targetNode,
          unrelatedNodes: new Map(
            nodes
              .filter((node) => node.id !== control.nodeId)
              .map((node) => [node.id, node]),
          ),
          renderCountByNodeId: new Map(),
        };
        return {
          unrelatedNodeCount: activeDragIdentityState.unrelatedNodes.size,
        };
      }

      const state = activeDragIdentityState;
      if (
        !state ||
        state.owner !== owner ||
        state.targetNodeId !== control.nodeId
      ) {
        throw new Error("runtime Map drag identity is not prepared");
      }
      if (control.action === "cleanup") {
        release();
        return null;
      }

      const currentNodes = new Map(getNodes().map((node) => [node.id, node]));
      let unrelatedNodeObjectIdentityChanges = 0;
      let unrelatedNodeRenderCount = 0;
      let unrelatedRenderedNodeCount = 0;
      for (const [nodeId, originalNode] of state.unrelatedNodes) {
        if (currentNodes.get(nodeId) !== originalNode) {
          unrelatedNodeObjectIdentityChanges += 1;
        }
        const renderCount = state.renderCountByNodeId.get(nodeId) ?? 0;
        unrelatedNodeRenderCount += renderCount;
        if (renderCount > 0) {
          unrelatedRenderedNodeCount += 1;
        }
      }

      return {
        targetNodeObjectIdentityChanged:
          currentNodes.get(state.targetNodeId) !== state.targetNode,
        targetNodeRenderCount:
          state.renderCountByNodeId.get(state.targetNodeId) ?? 0,
        unrelatedNodeCount: state.unrelatedNodes.size,
        unrelatedNodeObjectIdentityChanges,
        unrelatedNodeRenderCount,
        unrelatedRenderedNodeCount,
      };
    },
    dispose: release,
  };
}

export function resetRuntimeMapPerformanceForTests(): void {
  activeDragIdentityState = null;
}
