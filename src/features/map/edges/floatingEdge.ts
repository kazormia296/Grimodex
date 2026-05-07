import {
  Position,
  type InternalNode,
  type Node,
  type XYPosition,
} from "@xyflow/react";

/**
 * Returns the point where the line from `target`'s center to `intersectionNode`'s
 * center crosses the rectangle of `intersectionNode`. Used to anchor floating
 * edges at the node's border instead of at a fixed handle position.
 *
 * Adapted from React Flow's official Floating Edges example.
 */
function getNodeIntersection(
  intersectionNode: InternalNode<Node>,
  targetNode: InternalNode<Node>,
): XYPosition {
  const w = (intersectionNode.measured?.width ?? 0) / 2;
  const h = (intersectionNode.measured?.height ?? 0) / 2;
  const intersectionPos = intersectionNode.internals.positionAbsolute;
  const targetPos = targetNode.internals.positionAbsolute;

  const x2 = intersectionPos.x + w;
  const y2 = intersectionPos.y + h;
  const x1 = targetPos.x + (targetNode.measured?.width ?? 0) / 2;
  const y1 = targetPos.y + (targetNode.measured?.height ?? 0) / 2;

  if (w === 0 || h === 0) return { x: x2, y: y2 };

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const denom = Math.abs(xx1) + Math.abs(yy1);
  if (denom === 0) return { x: x2, y: y2 };
  const a = 1 / denom;
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  const x = w * (xx3 + yy3) + x2;
  const y = h * (-xx3 + yy3) + y2;
  return { x, y };
}

/** Which side of the node the intersection point falls on. */
function getEdgePosition(
  node: InternalNode<Node>,
  intersectionPoint: XYPosition,
): Position {
  const nx = Math.round(node.internals.positionAbsolute.x);
  const ny = Math.round(node.internals.positionAbsolute.y);
  const w = node.measured?.width ?? 0;
  const h = node.measured?.height ?? 0;
  const px = Math.round(intersectionPoint.x);
  const py = Math.round(intersectionPoint.y);

  if (px <= nx + 1) return Position.Left;
  if (px >= nx + w - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  if (py >= ny + h - 1) return Position.Bottom;
  return Position.Top;
}

/** Computes start/end points and side hints for a floating edge between two nodes. */
export function getFloatingEdgeParams(
  source: InternalNode<Node>,
  target: InternalNode<Node>,
) {
  const sourceIntersection = getNodeIntersection(source, target);
  const targetIntersection = getNodeIntersection(target, source);
  const sourcePos = getEdgePosition(source, sourceIntersection);
  const targetPos = getEdgePosition(target, targetIntersection);
  return {
    sx: sourceIntersection.x,
    sy: sourceIntersection.y,
    tx: targetIntersection.x,
    ty: targetIntersection.y,
    sourcePos,
    targetPos,
  };
}
