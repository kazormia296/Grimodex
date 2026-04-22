import { useRef, useCallback } from "react";
import type { Node } from "@xyflow/react";

// Fallback sizes for containment detection when React Flow hasn't measured yet
const DEFAULT_NODE_SIZE: Record<string, { w: number; h: number }> = {
  scene: { w: 180, h: 72 },
  codex: { w: 200, h: 90 },
  note: { w: 180, h: 72 },
  ai: { w: 160, h: 96 },
};

interface FrameDragState {
  frameId: string;
  startFramePos: { x: number; y: number };
  contained: { id: string; startPos: { x: number; y: number } }[];
}

interface UseFrameGroupDragInput {
  getNodes: () => Node[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  persistPosition: (nodeId: string, x: number, y: number) => void;
}

export function useFrameGroupDrag({
  getNodes,
  setNodes,
  persistPosition,
}: UseFrameGroupDragInput) {
  const stateRef = useRef<FrameDragState | null>(null);

  const onNodeDragStart = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!node.id.startsWith("frame:")) return;

      const fw = (node.style?.width as number) ?? 400;
      const fh = (node.style?.height as number) ?? 300;
      const fx = node.position.x;
      const fy = node.position.y;

      const contained = getNodes()
        .filter((n) => !n.id.startsWith("frame:"))
        .filter((n) => {
          const type = n.type ?? "scene";
          const nw = n.measured?.width ?? DEFAULT_NODE_SIZE[type]?.w ?? 180;
          const nh = n.measured?.height ?? DEFAULT_NODE_SIZE[type]?.h ?? 72;
          const cx = n.position.x + nw / 2;
          const cy = n.position.y + nh / 2;
          return cx >= fx && cx <= fx + fw && cy >= fy && cy <= fy + fh;
        })
        .map((n) => ({
          id: n.id,
          startPos: { x: n.position.x, y: n.position.y },
        }));

      stateRef.current = {
        frameId: node.id,
        startFramePos: { x: fx, y: fy },
        contained,
      };
    },
    [getNodes],
  );

  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const state = stateRef.current;
      if (!state || node.id !== state.frameId || state.contained.length === 0)
        return;

      const dx = node.position.x - state.startFramePos.x;
      const dy = node.position.y - state.startFramePos.y;

      setNodes((prev) =>
        prev.map((n) => {
          const c = state.contained.find((c) => c.id === n.id);
          if (!c) return n;
          return {
            ...n,
            position: { x: c.startPos.x + dx, y: c.startPos.y + dy },
          };
        }),
      );
    },
    [setNodes],
  );

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const state = stateRef.current;
      stateRef.current = null;
      if (!state || node.id !== state.frameId || state.contained.length === 0)
        return;

      const currentNodes = getNodes();
      for (const c of state.contained) {
        const n = currentNodes.find((n) => n.id === c.id);
        if (n) persistPosition(n.id, n.position.x, n.position.y);
      }
    },
    [getNodes, persistPosition],
  );

  return { onNodeDragStart, onNodeDrag, onNodeDragStop };
}
