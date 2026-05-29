/**
 * 執筆タイムラプス 動画エクスポート orchestrator (P7.3)。
 *
 * 既存ピースを繋ぐ: loadSceneChangeEvents → createReplayCursor →
 * buildFrameSchedule/makeDrawFrame → captureCanvasToWebm → saveWebmBlob。
 *
 * v1 の射程: 起点 doc は空 doc 固定。記録稼働後に空から書いたシーンのみ正しく
 * 復元される (baseline snapshot seek は C1/§4.5 で配線)。対象は editor 本文
 * (doc.step) のみ。
 */

import { loadSceneChangeEvents } from "./queryEvents";
import { createReplayCursor } from "./replayEngine";
import { buildFrameSchedule, makeDrawFrame } from "./frameProducer";
import { captureCanvasToWebm } from "./videoExport";

export interface SceneTimelapseOptions {
  projectId: string;
  sceneId: string;
  width?: number;
  height?: number;
  fps?: number;
  targetDurationSec?: number;
  /** Override the WebM mime (A6 feature-detect supplies a supported one). */
  mimeType?: string;
}

export interface SceneTimelapseResult {
  blob: Blob;
  frameCount: number;
  eventCount: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

/**
 * Render a scene's recorded writing into a WebM Blob. Throws if the scene has
 * no recorded editor steps, or if the runtime can't provide a 2D canvas.
 */
export async function produceSceneTimelapseWebm(
  opts: SceneTimelapseOptions,
): Promise<SceneTimelapseResult> {
  const rows = await loadSceneChangeEvents(opts.projectId, opts.sceneId);
  const events = rows.filter((e) => e.opType === "doc.step");
  if (events.length === 0) {
    throw new Error("timelapse: no recorded editor steps for this scene");
  }

  // Live editor schema so Step.fromJSON resolves marks (e.g. authorship).
  const { getEditorExtensions } = await import("@/features/editor/extensions");
  const { getSchema } = await import("@tiptap/core");
  const schema = getSchema(getEditorExtensions());
  const initialDoc = schema.topNodeType.createAndFill();
  if (!initialDoc) {
    throw new Error("timelapse: could not build an initial document");
  }

  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const fps = opts.fps ?? 30;

  const cursor = createReplayCursor(schema, initialDoc, events);
  const schedule = buildFrameSchedule(events, {
    fps,
    targetDurationSec: opts.targetDurationSec,
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("timelapse: 2D canvas context unavailable");

  const drawFrame = makeDrawFrame({ cursor, ctx, width, height, schedule });
  const blob = await captureCanvasToWebm(canvas, {
    fps,
    drawFrame,
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
  });

  return { blob, frameCount: schedule.length, eventCount: events.length };
}

/**
 * Save a produced WebM Blob to disk. Mirrors the canonical save pattern
 * (saveZipBlob / useMapExport PNG): Tauri save dialog + binary writeFile,
 * with a browser download fallback. Returns false if the user cancels.
 */
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
