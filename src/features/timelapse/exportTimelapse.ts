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

import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { ChangeEvent } from "@/db/schema";
import { loadSceneChangeEvents, loadProjectChangeEvents } from "./queryEvents";
import {
  createReplayCursor,
  type ReplayEvent,
  type ReplayCursor,
} from "./replayEngine";
import { buildFrameSchedule, makeDrawFrame } from "./frameProducer";
import { captureCanvasToWebm } from "./videoExport";
import { loadLatestSnapshot, type DecodedSnapshot } from "./snapshots";
import { resolveEditorTheme } from "./resolveEditorTheme";
import {
  renderDocToCanvas,
  type EditorRenderTheme,
} from "./renderers/editorRenderer";

export interface SceneTimelapseOptions {
  projectId: string;
  sceneId: string;
  width?: number;
  height?: number;
  fps?: number;
  targetDurationSec?: number;
  /** Override the WebM mime (A6 feature-detect supplies a supported one). */
  mimeType?: string;
  /** Render theme. Default: resolveEditorTheme() from the live editor (P1). */
  theme?: EditorRenderTheme;
}

export interface SceneTimelapseResult {
  blob: Blob;
  frameCount: number;
  eventCount: number;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export interface ReplayStart<E extends ReplayEvent = ReplayEvent> {
  initialDoc: ProseMirrorNode;
  replayEvents: E[];
}

/**
 * Decide the replay starting point (P7.7 / §4.5).
 *
 * With a baseline snapshot, seed the doc from it and replay only the events
 * after its anchor sequence. Without one, start from an empty doc and replay
 * everything — correct only for scenes that were empty when recording began.
 * Throws if a snapshot payload can't be deserialised (caller falls back to
 * the empty-doc path).
 */
export function buildReplayStart<E extends ReplayEvent>(
  schema: Schema,
  events: E[],
  snapshot: Pick<DecodedSnapshot, "payload" | "anchorSequence"> | null,
): ReplayStart<E> {
  if (snapshot) {
    const initialDoc = ProseMirrorNode.fromJSON(
      schema,
      snapshot.payload as never,
    );
    const replayEvents = events.filter(
      (e) => e.sequence > snapshot.anchorSequence,
    );
    return { initialDoc, replayEvents };
  }
  const empty = schema.topNodeType.createAndFill();
  if (!empty) {
    throw new Error("timelapse: could not build an initial document");
  }
  return { initialDoc: empty, replayEvents: events };
}

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

  // Seed from the baseline snapshot if one was stamped (recording enable),
  // else from an empty doc. Fall back to empty if the snapshot is unusable.
  const snapshot = await loadLatestSnapshot({
    projectId: opts.projectId,
    domain: "editor",
    entityId: opts.sceneId,
  });
  const start = (() => {
    try {
      return buildReplayStart(schema, events, snapshot);
    } catch (err) {
      console.warn(
        "[timelapse] baseline snapshot unusable; replaying from empty doc",
        err,
      );
      return buildReplayStart(schema, events, null);
    }
  })();

  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const fps = opts.fps ?? 30;

  const cursor = createReplayCursor(
    schema,
    start.initialDoc,
    start.replayEvents,
  );
  const schedule = buildFrameSchedule(start.replayEvents, {
    fps,
    targetDurationSec: opts.targetDurationSec,
  });

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("timelapse: 2D canvas context unavailable");

  // 実エディタのテーマ・フォント・帰属表示を解決して描画に反映 (P1)。
  const theme = opts.theme ?? resolveEditorTheme();
  const drawFrame = makeDrawFrame({
    cursor,
    ctx,
    width,
    height,
    schedule,
    theme,
  });
  const blob = await captureCanvasToWebm(canvas, {
    fps,
    drawFrame,
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
  });

  return { blob, frameCount: schedule.length, eventCount: events.length };
}

// ────────────────────────────────────────────────────────────────────
// プロジェクト全体タイムラプス (#9)。全シーンの本文編集(doc.step, sceneId 付き)を
// timestamp 順に再生し、各フレームで「その時アクティブなシーン」(=直近 doc.step の
// sceneId)の doc を描画する。シーンごとに baseline seed した cursor を持ち、全体で
// 1 本の frame schedule を引く。chat/layout/クロームの合流は P5。
// ────────────────────────────────────────────────────────────────────

export interface ProjectTimelapseOptions {
  projectId: string;
  width?: number;
  height?: number;
  fps?: number;
  targetDurationSec?: number;
  maxIdleMs?: number;
  /** Override the WebM mime (A6 feature-detect supplies a supported one). */
  mimeType?: string;
  /** Render theme. Default: resolveEditorTheme() from the live editor (P1). */
  theme?: EditorRenderTheme;
}

export interface ProjectTimelapseResult {
  blob: Blob;
  frameCount: number;
  eventCount: number;
  sceneCount: number;
}

type ProjectStepEvent = ChangeEvent & { sceneId: string };

export interface ProjectTimelapsePlan {
  events: ProjectStepEvent[];
  cursors: Map<string, ReplayCursor>;
  schedule: number[];
  sceneCount: number;
  eventCount: number;
}

/**
 * Active scene at `targetSequence` = the sceneId of the last doc.step with
 * `sequence <= target`. `events` must be sequence-ascending (binary search).
 */
export function pickActiveScene(
  events: readonly Pick<ProjectStepEvent, "sequence" | "sceneId">[],
  targetSequence: number,
): string | null {
  if (events.length === 0) return null;
  let lo = 0;
  let hi = events.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].sequence <= targetSequence) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? events[ans].sceneId : events[0].sceneId;
}

/**
 * Build the whole-project replay plan: all body doc.step events (those with a
 * sceneId) sequence-ordered, one baseline-seeded cursor per scene, and a single
 * frame schedule over the merged timeline. No MediaRecorder dependency, so this
 * is unit-testable. Throws if the project has no recorded body steps.
 */
export async function buildProjectTimelapsePlan(opts: {
  projectId: string;
  fps?: number;
  targetDurationSec?: number;
  maxIdleMs?: number;
}): Promise<ProjectTimelapsePlan> {
  const rows = await loadProjectChangeEvents(opts.projectId);
  const events = rows.filter(
    (e): e is ProjectStepEvent => e.opType === "doc.step" && e.sceneId !== null,
  );
  if (events.length === 0) {
    throw new Error("timelapse: no recorded editor steps in this project");
  }

  // Live editor schema so Step.fromJSON resolves marks (e.g. authorship).
  const { getEditorExtensions } = await import("@/features/editor/extensions");
  const { getSchema } = await import("@tiptap/core");
  const schema = getSchema(getEditorExtensions());

  const sceneIds = [...new Set(events.map((e) => e.sceneId))];
  const cursors = new Map<string, ReplayCursor>();
  for (const sceneId of sceneIds) {
    const sceneEvents = events.filter((e) => e.sceneId === sceneId);
    const snapshot = await loadLatestSnapshot({
      projectId: opts.projectId,
      domain: "editor",
      entityId: sceneId,
    });
    const start = (() => {
      try {
        return buildReplayStart(schema, sceneEvents, snapshot);
      } catch (err) {
        console.warn("[timelapse] baseline unusable for scene", sceneId, err);
        return buildReplayStart(schema, sceneEvents, null);
      }
    })();
    cursors.set(
      sceneId,
      createReplayCursor(schema, start.initialDoc, start.replayEvents),
    );
  }

  const schedule = buildFrameSchedule(events, {
    fps: opts.fps,
    targetDurationSec: opts.targetDurationSec,
    ...(opts.maxIdleMs !== undefined ? { maxIdleMs: opts.maxIdleMs } : {}),
  });

  return {
    events,
    cursors,
    schedule,
    sceneCount: sceneIds.length,
    eventCount: events.length,
  };
}

/**
 * drawFrame for the whole-project video: pick the active scene for the frame's
 * target sequence, advance that scene's cursor (delta only), repaint.
 */
export function makeProjectDrawFrame(opts: {
  plan: ProjectTimelapsePlan;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  theme?: EditorRenderTheme;
}): (frameIndex: number) => boolean {
  const { plan, ctx, width, height, theme } = opts;
  return (frameIndex: number) => {
    if (frameIndex >= plan.schedule.length) return true;
    const target = plan.schedule[frameIndex];
    const sceneId = pickActiveScene(plan.events, target);
    const cursor = sceneId ? plan.cursors.get(sceneId) : undefined;
    if (cursor) {
      cursor.applyUntil(target);
      renderDocToCanvas(ctx, cursor.doc, width, height, theme);
    }
    return false;
  };
}

/**
 * Render the whole project's recorded writing into a single WebM Blob (#9).
 * Throws if the project has no recorded editor steps, or if the runtime can't
 * provide a 2D canvas.
 */
export async function produceProjectTimelapseWebm(
  opts: ProjectTimelapseOptions,
): Promise<ProjectTimelapseResult> {
  const plan = await buildProjectTimelapsePlan(opts);

  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const fps = opts.fps ?? 30;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("timelapse: 2D canvas context unavailable");

  const theme = opts.theme ?? resolveEditorTheme();
  const drawFrame = makeProjectDrawFrame({ plan, ctx, width, height, theme });
  const blob = await captureCanvasToWebm(canvas, {
    fps,
    drawFrame,
    ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
  });

  return {
    blob,
    frameCount: plan.schedule.length,
    eventCount: plan.eventCount,
    sceneCount: plan.sceneCount,
  };
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
