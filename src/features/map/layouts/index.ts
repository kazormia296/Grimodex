import type { MapMode } from "../types";
import type { LayoutInput, LayoutOutput } from "./types";
import { layoutFree } from "./free";
import { layoutTime } from "./time";

export function layoutFor(mode: MapMode, input: LayoutInput): LayoutOutput {
  // C2-T (theme) / C2-P (pov) / C2-L (place) will add branches here
  const computed = mode === "time" ? layoutTime(input) : layoutFree(input);

  // Hybrid: in non-free modes, pinned nodes override with their saved coordinates
  if (mode !== "free") {
    for (const pos of input.positions) {
      if (pos.pinned !== 1) continue;
      const key = pos.treeNodeId
        ? `scene:${pos.treeNodeId}`
        : pos.codexEntryId
          ? `codex:${pos.codexEntryId}`
          : null;
      if (key && computed.has(key)) computed.set(key, { x: pos.x, y: pos.y });
    }
  }

  return computed;
}

export { layoutFree } from "./free";
export type { LayoutInput, LayoutOutput } from "./types";
