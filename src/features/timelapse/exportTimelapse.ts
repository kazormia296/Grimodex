/**
 * 執筆タイムラプス 動画エクスポート orchestrator (P7.3 + P5 compositor).
 */

import type { EditorRenderTheme } from "./renderers/editorRenderer";
import {
  buildCompositeTimelapsePlan,
  advanceCursorForTarget,
  pickRenderTarget,
  type CompositeTimelapsePlan,
  type RenderTargetKey,
} from "./compositeTimelapse";
import { captureCanvasToWebm } from "./videoExport";
import { resolveEditorTheme } from "./resolveEditorTheme";
import { renderDocToCanvas } from "./renderers/editorRenderer";
import { renderChromeOverlay, renderEmptyFrame } from "./chromeRenderer";

export type { RenderTargetKey, CompositeTimelapsePlan };
export { pickRenderTarget, buildCompositeTimelapsePlan } from "./compositeTimelapse";
export { buildReplayStart } from "./replayStart";

/** @deprecated Use CompositeTimelapsePlan */
export type ProjectTimelapsePlan = CompositeTimelapsePlan;

export interface SceneTimelapseOptions {
  projectId: string;
  sceneId: string;
  width?: number;
  height?: number;
  fps?: number;
  targetDurationSec?: number;
  maxIdleMs?: number;
  mimeType?: string;
  theme?: EditorRenderTheme;
}

export interface SceneTimelapseResult {
  blob: Blob;
  frameCount: number;
  eventCount: number;
}

export interface ProjectTimelapseOptions {
  projectId: string;
  width?: number;
  height?: number;
  fps?: number;
  targetDurationSec?: number;
  maxIdleMs?: number;
  mimeType?: string;
  theme?: EditorRenderTheme;
}

export interface ProjectTimelapseResult {
  blob: Blob;
  frameCount: number;
  eventCount: number;
  sceneCount: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export function makeCompositeDrawFrame(opts: {
  plan: CompositeTimelapsePlan;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  theme?: EditorRenderTheme;
}): (frameIndex: number) => boolean {
  const { plan, ctx, width, height } = opts;
  const theme = opts.theme ?? resolveEditorTheme();
  let prevRenderKey: RenderTargetKey | null = null;
  const warnedKeys = new Set<string>();

  return (frameIndex: number) => {
    if (frameIndex >= plan.schedule.length) return true;
    const target = plan.schedule[frameIndex];
    const renderKey = pickRenderTarget(
      plan.events,
      target,
      plan.cursors,
      prevRenderKey,
    );
    if (renderKey) prevRenderKey = renderKey;

    const cursor = advanceCursorForTarget(
      plan.cursors,
      renderKey,
      target,
    );

    if (cursor && renderKey && !cursor.failure) {
      renderDocToCanvas(
        ctx,
        cursor.doc,
        width,
        height,
        theme,
        cursor.focusPos,
      );
    } else {
      if (cursor?.failure && renderKey && !warnedKeys.has(renderKey)) {
        warnedKeys.add(renderKey);
        console.warn(
          `[timelapse] ${renderKey} replay halted at seq ${cursor.failure.failedAt}`,
        );
      }
      renderEmptyFrame(ctx, width, height, theme);
    }

    const captions = plan.frameCaptions[frameIndex] ?? [];
    renderChromeOverlay(ctx, captions, width, height, theme);
    return false;
  };
}

/** @deprecated Use makeCompositeDrawFrame */
export const makeProjectDrawFrame = makeCompositeDrawFrame;

/** @deprecated Use buildCompositeTimelapsePlan */
export const buildProjectTimelapsePlan = buildCompositeTimelapsePlan;

async function produceTimelapseWebm(opts: {
  plan: CompositeTimelapsePlan;
  width?: number;
  height?: number;
  fps?: number;
  mimeType?: string;
  theme?: EditorRenderTheme;
}): Promise<Blob> {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const fps = opts.fps ?? 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("timelapse: 2D canvas context unavailable");

  const theme = opts.theme ?? resolveEditorTheme();
  const drawFrame = makeCompositeDrawFrame({
    plan: opts.plan,
    ctx,
    width,
    height,
    theme,
  });

  return captureCanvasToWebm(canvas, {
    fps,
    drawFrame,
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
  });
}

export async function produceSceneTimelapseWebm(
  opts: SceneTimelapseOptions,
): Promise<SceneTimelapseResult> {
  const plan = await buildCompositeTimelapsePlan({
    projectId: opts.projectId,
    sceneId: opts.sceneId,
    fps: opts.fps,
    targetDurationSec: opts.targetDurationSec,
    maxIdleMs: opts.maxIdleMs,
  });

  const blob = await produceTimelapseWebm({
    plan,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    mimeType: opts.mimeType,
    theme: opts.theme,
  });

  return {
    blob,
    frameCount: plan.schedule.length,
    eventCount: plan.eventCount,
  };
}

export async function produceProjectTimelapseWebm(
  opts: ProjectTimelapseOptions,
): Promise<ProjectTimelapseResult> {
  const plan = await buildCompositeTimelapsePlan({
    projectId: opts.projectId,
    fps: opts.fps,
    targetDurationSec: opts.targetDurationSec,
    maxIdleMs: opts.maxIdleMs,
  });

  const blob = await produceTimelapseWebm({
    plan,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    mimeType: opts.mimeType,
    theme: opts.theme,
  });

  return {
    blob,
    frameCount: plan.schedule.length,
    eventCount: plan.eventCount,
    sceneCount: plan.sceneCount,
  };
}

export async function saveWebmBlob(
  blob: Blob,
  filename: string,
): Promise<boolean> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "WebM", extensions: ["webm"] }],
    });
    if (!path) return false;
    const buf = await blob.arrayBuffer();
    await writeFile(path, new Uint8Array(buf));
    return true;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
