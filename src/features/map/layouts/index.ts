import type { MapMode } from "../types";
import type { LayoutInput, LayoutOutput } from "./types";
import type { ForceLayoutEngine } from "./forceEngine";
import { layoutFree } from "./free";
import { layoutTime } from "./time";
import { layoutPOV } from "./pov";
import { layoutPlace } from "./place";

function applyPinnedOverrides(
  computed: LayoutOutput,
  input: LayoutInput,
): LayoutOutput {
  for (const pos of input.positions) {
    if (pos.pinned !== 1) continue;
    const key = pos.treeNodeId
      ? `scene:${pos.treeNodeId}`
      : pos.codexEntryId
        ? `codex:${pos.codexEntryId}`
        : null;
    if (key && computed.has(key)) computed.set(key, { x: pos.x, y: pos.y });
  }
  return computed;
}

/** Synchronous layout dispatcher for free / time / pov / place modes. */
export function layoutFor(mode: MapMode, input: LayoutInput): LayoutOutput {
  let computed: LayoutOutput;

  switch (mode) {
    case "time":
      computed = layoutTime(input);
      break;
    case "pov":
      computed = layoutPOV(input);
      break;
    case "place":
      computed = layoutPlace(input);
      break;
    default:
      computed = layoutFree(input);
  }

  if (mode !== "free") applyPinnedOverrides(computed, input);
  return computed;
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
  applyPinnedOverrides(computed, input);
  return computed;
}

export { layoutFree } from "./free";
export type { LayoutInput, LayoutOutput } from "./types";
