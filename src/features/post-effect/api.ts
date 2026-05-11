/**
 * api.ts — PostEffects の Tauri コマンドラッパー。
 * 命名は設計書 §Tauri コマンド（想定）に合わせる。
 */

import { invoke, listen } from "@/lib/tauri";
import type {
  PostEffectRun,
  PostEffectAnnotation,
  PostEffectAnnotationRelation,
  PostEffectStatus,
  PostEffectType,
  StartPostEffectRunRequest,
  StartPostEffectRunMultiRequest,
  StartPostEffectRunResult,
  AnnotationsForSceneResponse,
  RunDetailResponse,
  PostEffectProgressEvent,
  PostEffectPartialEvent,
  PostEffectDoneEvent,
  PostEffectErrorEvent,
} from "./types";

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export async function startPostEffectRun(
  req: StartPostEffectRunRequest,
): Promise<StartPostEffectRunResult> {
  return invoke<StartPostEffectRunResult>(
    "start_post_effect_run",
    req as unknown as Record<string, unknown>,
  );
}

export async function startPostEffectRunMulti(
  req: StartPostEffectRunMultiRequest,
): Promise<StartPostEffectRunResult> {
  return invoke<StartPostEffectRunResult>(
    "start_post_effect_run_multi",
    req as unknown as Record<string, unknown>,
  );
}

export async function abortPostEffectRun(runId: string): Promise<void> {
  return invoke<void>("abort_post_effect_run", { run_id: runId });
}

// ---------------------------------------------------------------------------
// Query commands
// ---------------------------------------------------------------------------

export async function listPostEffectRuns(params: {
  projectId: string;
  effectType?: PostEffectType;
  limit?: number;
  offset?: number;
}): Promise<PostEffectRun[]> {
  return invoke<PostEffectRun[]>("list_post_effect_runs", {
    project_id: params.projectId,
    effect_type: params.effectType ?? null,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  });
}

export async function getPostEffectRun(
  runId: string,
): Promise<RunDetailResponse> {
  return invoke<RunDetailResponse>("get_post_effect_run", { run_id: runId });
}

export async function listAnnotationsForScene(params: {
  projectId: string;
  sceneId: string;
  status?: PostEffectStatus;
}): Promise<AnnotationsForSceneResponse> {
  return invoke<AnnotationsForSceneResponse>("list_annotations_for_scene", {
    project_id: params.projectId,
    scene_id: params.sceneId,
    status: params.status ?? null,
  });
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

export async function updateAnnotationStatus(
  annotationId: string,
  status: PostEffectStatus,
): Promise<PostEffectAnnotation> {
  return invoke<PostEffectAnnotation>("update_annotation_status", {
    annotation_id: annotationId,
    status,
  });
}

export async function updateRelationStatus(
  relationId: string,
  status: PostEffectStatus,
): Promise<PostEffectAnnotationRelation> {
  return invoke<PostEffectAnnotationRelation>("update_relation_status", {
    relation_id: relationId,
    status,
  });
}

/** scene 保存時に AnnotationMark の位置を DB に同期する。 */
export async function savePostEffectAnnotations(params: {
  projectId: string;
  sceneId: string;
  annotations: Array<{
    id: string;
    rangeStart: number;
    rangeEnd: number;
    textSnapshot: string;
  }>;
}): Promise<void> {
  return invoke<void>("save_post_effect_annotations", {
    project_id: params.projectId,
    scene_id: params.sceneId,
    annotations: params.annotations.map((a) => ({
      id: a.id,
      range_start: a.rangeStart,
      range_end: a.rangeEnd,
      text_snapshot: a.textSnapshot,
    })),
  });
}

// ---------------------------------------------------------------------------
// Stream event subscriptions
// ---------------------------------------------------------------------------

export async function onPostEffectProgress(
  handler: (e: PostEffectProgressEvent) => void,
) {
  return listen<PostEffectProgressEvent>("post_effect:progress", handler);
}

export async function onPostEffectPartial(
  handler: (e: PostEffectPartialEvent) => void,
) {
  return listen<PostEffectPartialEvent>("post_effect:partial", handler);
}

export async function onPostEffectDone(
  handler: (e: PostEffectDoneEvent) => void,
) {
  return listen<PostEffectDoneEvent>("post_effect:done", handler);
}

export async function onPostEffectError(
  handler: (e: PostEffectErrorEvent) => void,
) {
  return listen<PostEffectErrorEvent>("post_effect:error", handler);
}

// ---------------------------------------------------------------------------
// Convenience: launch + subscribe in one call (like chatApi pattern)
// ---------------------------------------------------------------------------

export interface PostEffectRunCallbacks {
  onProgress?: (e: PostEffectProgressEvent) => void;
  onPartial?: (e: PostEffectPartialEvent) => void;
  onDone?: (e: PostEffectDoneEvent) => void;
  onError?: (e: PostEffectErrorEvent) => void;
}

/**
 * start_post_effect_run を fire-and-forget で起動し、イベント購読を設定する。
 * 返り値の cleanup 関数を呼ぶことでリスナーを解除できる。
 */
export async function runPostEffect(
  req: StartPostEffectRunRequest,
  callbacks: PostEffectRunCallbacks,
): Promise<{ runId: string; cleanup: () => void }> {
  // listen を先に張ってから invoke（初期イベント取り逃し防止）
  const unlisteners = await Promise.all([
    callbacks.onProgress
      ? onPostEffectProgress(callbacks.onProgress)
      : Promise.resolve(() => {}),
    callbacks.onPartial
      ? onPostEffectPartial(callbacks.onPartial)
      : Promise.resolve(() => {}),
    callbacks.onDone
      ? onPostEffectDone(callbacks.onDone)
      : Promise.resolve(() => {}),
    callbacks.onError
      ? onPostEffectError(callbacks.onError)
      : Promise.resolve(() => {}),
  ]);

  const cleanup = () => unlisteners.forEach((u) => u());

  const result = await startPostEffectRun(req);
  return { runId: result.run_id, cleanup };
}

/**
 * start_post_effect_run_multi を fire-and-forget で起動し、イベント購読を設定する。
 * folder / project スコープの複数シーン一括チェック用。
 */
export async function runPostEffectMulti(
  req: StartPostEffectRunMultiRequest,
  callbacks: PostEffectRunCallbacks,
): Promise<{ runId: string; cleanup: () => void }> {
  const unlisteners = await Promise.all([
    callbacks.onProgress
      ? onPostEffectProgress(callbacks.onProgress)
      : Promise.resolve(() => {}),
    callbacks.onPartial
      ? onPostEffectPartial(callbacks.onPartial)
      : Promise.resolve(() => {}),
    callbacks.onDone
      ? onPostEffectDone(callbacks.onDone)
      : Promise.resolve(() => {}),
    callbacks.onError
      ? onPostEffectError(callbacks.onError)
      : Promise.resolve(() => {}),
  ]);

  const cleanup = () => unlisteners.forEach((u) => u());

  const result = await startPostEffectRunMulti(req);
  return { runId: result.run_id, cleanup };
}
