import type { LayoutInput, LayoutOutput } from "./types";

const SCENE_COLS = 5;
const SCENE_STEP_X = 280;
const SCENE_STEP_Y = 220;
const SCENE_OFFSET = 40;

const CODEX_COLS = 4;
const CODEX_STEP_X = 240;
const CODEX_STEP_Y = 120;
const CODEX_OFFSET_X = 40;
const CODEX_OFFSET_Y = 600;

export function layoutFree(input: LayoutInput): LayoutOutput {
  const result: LayoutOutput = new Map();

  const posMap = new Map<string, { x: number; y: number }>();
  for (const p of input.positions) {
    if (p.treeNodeId) posMap.set(`scene:${p.treeNodeId}`, { x: p.x, y: p.y });
    if (p.codexEntryId)
      posMap.set(`codex:${p.codexEntryId}`, { x: p.x, y: p.y });
  }

  for (let i = 0; i < input.scenes.length; i++) {
    const key = `scene:${input.scenes[i].id}`;
    result.set(
      key,
      posMap.get(key) ?? {
        x: (i % SCENE_COLS) * SCENE_STEP_X + SCENE_OFFSET,
        y: Math.floor(i / SCENE_COLS) * SCENE_STEP_Y + SCENE_OFFSET,
      },
    );
  }

  for (let i = 0; i < input.codexEntries.length; i++) {
    const key = `codex:${input.codexEntries[i].id}`;
    result.set(
      key,
      posMap.get(key) ?? {
        x: (i % CODEX_COLS) * CODEX_STEP_X + CODEX_OFFSET_X,
        y: Math.floor(i / CODEX_COLS) * CODEX_STEP_Y + CODEX_OFFSET_Y,
      },
    );
  }

  return result;
}
