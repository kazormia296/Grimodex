import type { MapMode } from "../types";
import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";
import { layoutFree } from "./free";

function applyPinnedOverrides(
  computed: LayoutOutput,
  input: LayoutInput,
): LayoutOutput {
  const result = new Map(computed);
  for (const pos of input.positions) {
    if (pos.pinned !== 1) continue;
    const key = pos.treeNodeId
      ? `scene:${pos.treeNodeId}`
      : pos.codexEntryId
        ? `codex:${pos.codexEntryId}`
        : null;
    if (key && result.has(key)) result.set(key, { x: pos.x, y: pos.y });
  }
  return result;
}

export { applyPinnedOverrides };

/** Synchronous layout dispatcher for free mode. */
export function layoutFor(_mode: MapMode, input: LayoutInput): LayoutOutput {
  return layoutFree(input);
}

/** Async layout for theme mode (uses d3-force engine). */
export async function layoutForAsync(
  _mode: "theme",
  input: LayoutInput,
  engine: ForceLayoutEngine,
  onProgress?: (alpha: number) => void,
): Promise<LayoutOutput> {
  const { layoutTheme } = await import("./theme");
  const computed = await layoutTheme(input, engine, onProgress);
  return applyPinnedOverrides(computed, input);
}

export { layoutFree } from "./free";
export type { LayoutInput, LayoutOutput } from "./types";
