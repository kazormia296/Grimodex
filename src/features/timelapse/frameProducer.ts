/**
 * 執筆タイムラプス frame producer (P7.2)。
 *
 * 既存ピースを繋ぐ glue: ReplayCursor (doc 再構成) → renderDocToCanvas
 * (doc → canvas) → videoExport.captureCanvasToWebm の drawFrame。
 *
 * フレーム毎にゼロから replay せず cursor を delta 前進させる (O(total steps))。
 * 全フレームを事前 raster 化してバッファに溜めることはしない — drawFrame 内で
 * cursor の現在 doc を都度描画する (保持は doc 1個 + canvas 1枚)。
 */

import type { ChangeEvent } from "@/db/schema";
import type { ReplayCursor } from "./replayEngine";
import {
  renderDocToCanvas,
  type EditorRenderTheme,
} from "./renderers/editorRenderer";

export interface FrameScheduleOptions {
  fps?: number;
  targetDurationSec?: number;
  /** Clamp long pauses so idle time doesn't dominate the video (§5.5). */
  maxIdleMs?: number;
}

const DEFAULT_FPS = 30;
const DEFAULT_DURATION_SEC = 30;
const DEFAULT_MAX_IDLE_MS = 2000;

/**
 * Map each output frame to a target event sequence.
 *
 * Builds a "compressed" timeline where inter-event gaps are clamped to
 * `maxIdleMs`, then samples it uniformly into `fps * targetDurationSec`
 * frames. Bursts of fast typing keep their relative rhythm; long pauses
 * collapse. Returns one target sequence per frame (length = total frames).
 *
 * `events` must be sequence-ascending and scoped to a single entity.
 */
export function buildFrameSchedule(
  events: readonly Pick<ChangeEvent, "sequence" | "timestamp">[],
  opts: FrameScheduleOptions = {},
): number[] {
  const fps = opts.fps ?? DEFAULT_FPS;
  const durationSec = opts.targetDurationSec ?? DEFAULT_DURATION_SEC;
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const totalFrames = Math.max(1, Math.round(fps * durationSec));

  if (events.length === 0) return [];

  // Compressed cumulative time, clamping long idle gaps.
  const compressed = new Array<number>(events.length);
  compressed[0] = 0;
  for (let i = 1; i < events.length; i += 1) {
    const gap = Math.max(0, events[i].timestamp - events[i - 1].timestamp);
    compressed[i] = compressed[i - 1] + Math.min(gap, maxIdleMs);
  }
  const total = compressed[compressed.length - 1];
  const denom = Math.max(1, totalFrames - 1);
  const schedule = new Array<number>(totalFrames);

  if (total === 0) {
    // All events share an instant (or a single event): sample by index.
    for (let f = 0; f < totalFrames; f += 1) {
      const idx = Math.floor((f / denom) * (events.length - 1));
      schedule[f] = events[idx].sequence;
    }
    return schedule;
  }

  let ev = 0;
  for (let f = 0; f < totalFrames; f += 1) {
    const targetT = (f / denom) * total;
    while (ev + 1 < events.length && compressed[ev + 1] <= targetT) ev += 1;
    schedule[f] = events[ev].sequence;
  }
  return schedule;
}

export interface MakeDrawFrameOptions {
  cursor: ReplayCursor;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  schedule: number[];
  theme?: EditorRenderTheme;
}

/**
 * Build a `drawFrame(frameIndex)` for videoExport.captureCanvasToWebm.
 *
 * Advances the cursor to the frame's target sequence (delta only) and repaints
 * the canvas. Returns false for every real frame and true once the index runs
 * past the schedule, so the final frame gets one more capture tick before the
 * recorder stops.
 */
export function makeDrawFrame(
  opts: MakeDrawFrameOptions,
): (frameIndex: number) => boolean {
  const { cursor, ctx, width, height, schedule, theme } = opts;
  return (frameIndex: number) => {
    if (frameIndex >= schedule.length) return true;
    cursor.applyUntil(schedule[frameIndex]);
    renderDocToCanvas(ctx, cursor.doc, width, height, theme);
    return false;
  };
}
