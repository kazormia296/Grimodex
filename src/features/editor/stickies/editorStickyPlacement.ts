export interface StickyLogicalPosition {
  inlineOffset: number;
  blockOffset: number;
}

export interface StickyPhysicalPosition {
  left: number;
  top: number;
}

export interface StickyProjectionOptions {
  verticalMode: boolean;
  surfaceWidth: number;
  stickyWidth: number;
}

export interface StickySurfaceBounds {
  surfaceWidth: number;
  surfaceHeight: number;
  stickyWidth: number;
  stickyHeight: number;
  minVisibleSize?: number;
}

/** Convert persisted inline/block offsets into the current writing-mode view. */
export function logicalToPhysicalPosition(
  logical: StickyLogicalPosition,
  options: StickyProjectionOptions,
): StickyPhysicalPosition {
  if (!options.verticalMode) {
    return { left: logical.inlineOffset, top: logical.blockOffset };
  }

  return {
    left: options.surfaceWidth - logical.blockOffset - options.stickyWidth,
    top: logical.inlineOffset,
  };
}

/** Convert a rendered position back to the stable logical coordinate pair. */
export function physicalToLogicalPosition(
  physical: StickyPhysicalPosition,
  options: StickyProjectionOptions,
): StickyLogicalPosition {
  if (!options.verticalMode) {
    return { inlineOffset: physical.left, blockOffset: physical.top };
  }

  return {
    inlineOffset: physical.top,
    blockOffset: options.surfaceWidth - physical.left - options.stickyWidth,
  };
}

/** Apply a pointer delta without changing its interpretation when writing mode flips. */
export function applyStickyPhysicalDelta(
  logical: StickyLogicalPosition,
  delta: { deltaX: number; deltaY: number },
  verticalMode: boolean,
): StickyLogicalPosition {
  if (!verticalMode) {
    return {
      inlineOffset: logical.inlineOffset + delta.deltaX,
      blockOffset: logical.blockOffset + delta.deltaY,
    };
  }

  return {
    inlineOffset: logical.inlineOffset + delta.deltaY,
    blockOffset: logical.blockOffset - delta.deltaX,
  };
}

/** Clamp only the rendered view so a drag handle remains reachable. */
export function clampStickyPosition(
  physical: StickyPhysicalPosition,
  bounds: StickySurfaceBounds,
): StickyPhysicalPosition {
  const minVisible = Math.max(1, bounds.minVisibleSize ?? 24);
  const minLeft = -bounds.stickyWidth + minVisible;
  const maxLeft = Math.max(minLeft, bounds.surfaceWidth - minVisible);
  const minTop = -bounds.stickyHeight + minVisible;
  const maxTop = Math.max(minTop, bounds.surfaceHeight - minVisible);

  return {
    left: Math.min(maxLeft, Math.max(minLeft, physical.left)),
    top: Math.min(maxTop, Math.max(minTop, physical.top)),
  };
}
