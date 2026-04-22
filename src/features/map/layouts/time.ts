import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { LayoutInput, LayoutOutput } from "./types";

const X_STEP = 280;
const Y_BASE = 200;
const UNSCHEDULED_OFFSET_X = 200;
const UNSCHEDULED_Y = Y_BASE + 240;
const CODEX_Y_OFFSET = -160;

export function layoutTime(input: LayoutInput): LayoutOutput {
  const result: LayoutOutput = new Map();

  // Sort scenes by storyTimeOrder; null = unscheduled
  const scheduled = input.scenes
    .filter((n) => n.storyTimeOrder != null)
    .sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
  const unscheduled = input.scenes.filter((n) => n.storyTimeOrder == null);

  scheduled.forEach((scene, idx) => {
    result.set(`scene:${scene.id}`, {
      x: idx * X_STEP + 40,
      y: Y_BASE,
    });
  });

  const maxX = scheduled.length > 0 ? (scheduled.length - 1) * X_STEP + 40 : 0;
  const unscheduledStartX = maxX + UNSCHEDULED_OFFSET_X + X_STEP;

  unscheduled.forEach((scene, idx) => {
    result.set(`scene:${scene.id}`, {
      x: unscheduledStartX + idx * X_STEP,
      y: UNSCHEDULED_Y,
    });
  });

  // Codex nodes: centered above the timeline
  const timelineWidth =
    scheduled.length > 0
      ? (scheduled.length - 1) * X_STEP + unscheduledStartX
      : 0;
  const codexCenterX = timelineWidth > 0 ? timelineWidth / 2 : 400;
  const CODEX_STEP_X = 200;
  const codexStartX =
    codexCenterX - ((input.codexEntries.length - 1) * CODEX_STEP_X) / 2;

  input.codexEntries.forEach((entry, idx) => {
    result.set(`codex:${entry.id}`, {
      x: codexStartX + idx * CODEX_STEP_X,
      y: Y_BASE + CODEX_Y_OFFSET,
    });
  });

  return result;
}
