import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { LayoutInput, LayoutOutput } from "./types";

const X_STEP = 280;
const Y_BASE = 200;
const LANE_HEIGHT = 240;
const UNSCHEDULED_OFFSET_X = 200;
const UNSCHEDULED_Y_OFFSET = 240;
const CODEX_Y_OFFSET = -160;

export function layoutTime(input: LayoutInput): LayoutOutput {
  const hasPov = input.scenes.some((s) => s.povCharacterId != null);
  return hasPov ? layoutTimePOV(input) : layoutTimeFlat(input);
}

// Flat single-lane layout (used when no scenes have POV assigned)
function layoutTimeFlat(input: LayoutInput): LayoutOutput {
  const result: LayoutOutput = new Map();

  const scheduled = input.scenes
    .filter((n) => n.storyTimeOrder != null)
    .sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
  const unscheduled = input.scenes.filter((n) => n.storyTimeOrder == null);

  scheduled.forEach((scene, idx) => {
    result.set(`scene:${scene.id}`, { x: idx * X_STEP + 40, y: Y_BASE });
  });

  const maxX = scheduled.length > 0 ? (scheduled.length - 1) * X_STEP + 40 : 0;
  const unscheduledStartX = maxX + UNSCHEDULED_OFFSET_X + X_STEP;

  unscheduled.forEach((scene, idx) => {
    result.set(`scene:${scene.id}`, {
      x: unscheduledStartX + idx * X_STEP,
      y: Y_BASE + UNSCHEDULED_Y_OFFSET,
    });
  });

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

// POV-lane layout: each unique POV character gets its own Y lane
function layoutTimePOV(input: LayoutInput): LayoutOutput {
  const result: LayoutOutput = new Map();

  // Collect ordered POV IDs (preserving insertion order from scenes)
  const povOrder: (string | null)[] = [];
  const seen = new Set<string | null>();
  for (const scene of input.scenes) {
    const key = scene.povCharacterId ?? null;
    if (!seen.has(key)) {
      seen.add(key);
      povOrder.push(key);
    }
  }
  // null (unassigned) goes last if present
  const sorted = [
    ...povOrder.filter((p) => p !== null),
    ...(povOrder.includes(null) ? [null] : []),
  ];
  const laneY = (laneIdx: number) => Y_BASE + laneIdx * LANE_HEIGHT;

  let maxScheduledX = 0;

  for (const [laneIdx, povId] of sorted.entries()) {
    const laneScenes = input.scenes.filter(
      (s) => (s.povCharacterId ?? null) === povId,
    );
    const scheduled = laneScenes
      .filter((s) => s.storyTimeOrder != null)
      .sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
    const unscheduled = laneScenes.filter((s) => s.storyTimeOrder == null);

    scheduled.forEach((scene, idx) => {
      const x = idx * X_STEP + 40;
      result.set(`scene:${scene.id}`, { x, y: laneY(laneIdx) });
      maxScheduledX = Math.max(maxScheduledX, x);
    });

    const unscheduledStartX = maxScheduledX + UNSCHEDULED_OFFSET_X + X_STEP;
    unscheduled.forEach((scene, idx) => {
      result.set(`scene:${scene.id}`, {
        x: unscheduledStartX + idx * X_STEP,
        y: laneY(laneIdx) + UNSCHEDULED_Y_OFFSET,
      });
    });
  }

  // Codex: characters at their lane Y, others above
  const charEntries = input.codexEntries.filter((e) => e.type === "character");
  const otherEntries = input.codexEntries.filter((e) => e.type !== "character");

  const codexX = (idx: number) => 40 + idx * 200;

  charEntries.forEach((entry, idx) => {
    const laneIdx = sorted.indexOf(entry.id);
    const y =
      laneIdx >= 0 ? laneY(laneIdx) + CODEX_Y_OFFSET : Y_BASE + CODEX_Y_OFFSET;
    result.set(`codex:${entry.id}`, { x: codexX(idx), y });
  });

  otherEntries.forEach((entry, idx) => {
    result.set(`codex:${entry.id}`, {
      x: codexX(idx),
      y: Y_BASE + CODEX_Y_OFFSET,
    });
  });

  return result;
}
