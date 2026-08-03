import { MeasuringStrategy } from "@dnd-kit/core";

/**
 * Grid rows are virtualized and new droppables can mount after drag start.
 * WhileDragging remeasures that live registry, including after scroll.
 */
export const GRID_DND_MEASURING = {
  droppable: { strategy: MeasuringStrategy.WhileDragging },
} as const;
