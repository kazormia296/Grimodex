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
  SceneLensRecord,
} from "./types";

// ---------------------------------------------------------------------------
// Editor flush
// ---------------------------------------------------------------------------

/**
 * run 起動前に未保存（autosave デバウンス中）の本文を DB へ flush する。
 * PayloadBuilder は treeNodes.content（DB）を読むため、これを挟まないと
 * 直近の編集が scene_text と input_hash の両方から漏れる。
 * sceneId 省略時は開いている dirty タブ全部（split 両グループ）を flush する。
 */
export async function flushPendingSceneSaves(sceneId?: string): Promise<void> {
  const { saveScene } = await import("@/features/editor/editorSaveRegistry");
  if (sceneId !== undefined) {
    await saveScene(sceneId);
    return;
  }
  // tabStore は layoutStore/i18n を引き込むため、本モジュールを import する
  // 純関数モジュールの test graph を汚さないよう遅延 import に留める。
  const { useTabStore } = await import("@/features/editor/tabStore");
  const ids = [...useTabStore.getState().dirtyTabIds];
  await Promise.all(ids.map((id) => saveScene(id)));
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export async function startPostEffectRun(
  req: StartPostEffectRunRequest,
): Promise<StartPostEffectRunResult> {
  return invoke<StartPostEffectRunResult>("start_post_effect_run", {
    args: req,
  });
}

export async function startPostEffectRunMulti(
  req: StartPostEffectRunMultiRequest,
): Promise<StartPostEffectRunResult> {
  return invoke<StartPostEffectRunResult>("start_post_effect_run_multi", {
    args: req,
  });
}

export async function abortPostEffectRun(
  runId: string,
  projectId: string,
): Promise<void> {
  return invoke<void>("abort_post_effect_run", { runId, projectId });
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
    projectId: params.projectId,
    effectType: params.effectType ?? null,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
  });
}

export async function getPostEffectRun(
  runId: string,
  projectId: string,
): Promise<RunDetailResponse> {
  return invoke<RunDetailResponse>("get_post_effect_run", { runId, projectId });
}

export async function listAnnotationsForScene(params: {
  projectId: string;
  sceneId: string;
  status?: PostEffectStatus;
}): Promise<AnnotationsForSceneResponse> {
  return invoke<AnnotationsForSceneResponse>("list_annotations_for_scene", {
    projectId: params.projectId,
    sceneId: params.sceneId,
    status: params.status ?? null,
  });
}

/** Outline オーバーレイ用: scene ごと最新 run の lens (meta_structure) を返す。 */
export async function listSceneLensForProject(
  projectId: string,
): Promise<SceneLensRecord[]> {
  return invoke<SceneLensRecord[]>("list_scene_lens_for_project", {
    projectId,
  });
}

export async function listAnnotationsForProject(params: {
  projectId: string;
  status?: PostEffectStatus;
}): Promise<{ annotations: PostEffectAnnotation[] }> {
  return invoke<{ annotations: PostEffectAnnotation[] }>(
    "list_annotations_for_project",
    {
      projectId: params.projectId,
      status: params.status ?? null,
    },
  );
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

export async function updateAnnotationStatus(
  annotationId: string,
  status: PostEffectStatus,
  projectId: string,
): Promise<PostEffectAnnotation> {
  return invoke<PostEffectAnnotation>("update_annotation_status", {
    annotationId,
    status,
    projectId,
  });
}

export async function updateRelationStatus(
  relationId: string,
  status: PostEffectStatus,
  projectId: string,
): Promise<PostEffectAnnotationRelation> {
  return invoke<PostEffectAnnotationRelation>("update_relation_status", {
    relationId,
    status,
    projectId,
  });
}

/** 疑似コメントへの返信を追加する (親の run_id / persona を継承)。 */
export async function replyToAnnotation(params: {
  parentId: string;
  content: string;
  authorRole?: "user" | "ai" | "system";
  projectId: string;
}): Promise<PostEffectAnnotation> {
  return invoke<PostEffectAnnotation>("reply_to_annotation", {
    args: {
      parent_id: params.parentId,
      content: params.content,
      author_role: params.authorRole ?? "user",
      project_id: params.projectId,
    },
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
    projectId: params.projectId,
    sceneId: params.sceneId,
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
 *
 * ## 自動 cleanup
 * done / error イベントを受信した時点で**自動的に**全リスナーを解除する。
 * 呼び出し側のハンドラ内で `cleanup()` を呼ぶ必要はない（呼んでも no-op）。
 *
 * これは過去のバグ対策: 呼び出し側コードが
 *   `const { cleanup } = await runPostEffect(req, { onDone: () => cleanup() })`
 * のように cleanup を const 経由で参照していたとき、empty completion など
 * バックエンドが極端に速く done を emit すると、cleanup が TDZ のまま
 * ハンドラが走り ReferenceError → setRunning(false) 未到達 → spinner 永続
 * という race condition が発生していた。
 *
 * 返り値の `cleanup` は早期 abort 時のためだけに残してある。
 */
export async function runPostEffect(
  req: StartPostEffectRunRequest,
  callbacks: PostEffectRunCallbacks,
): Promise<{ runId: string; cleanup: () => void }> {
  return runPostEffectInternal(callbacks, () => startPostEffectRun(req));
}

/**
 * start_post_effect_run_multi を fire-and-forget で起動し、イベント購読を設定する。
 * folder / project スコープの複数シーン一括チェック用。
 *
 * `runPostEffect` と同じ自動 cleanup 仕様。
 */
export async function runPostEffectMulti(
  req: StartPostEffectRunMultiRequest,
  callbacks: PostEffectRunCallbacks,
): Promise<{ runId: string; cleanup: () => void }> {
  return runPostEffectInternal(callbacks, () => startPostEffectRunMulti(req));
}

async function runPostEffectInternal(
  callbacks: PostEffectRunCallbacks,
  starter: () => Promise<StartPostEffectRunResult>,
): Promise<{ runId: string; cleanup: () => void }> {
  // unlisteners は terminal handler 内からも触れるよう先に箱だけ用意する
  // (Promise.all 完了前にイベントが来ることはないが、TDZ を避けるため)。
  const unlisteners: Array<() => void> = [];
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const u of unlisteners) {
      try {
        u();
      } catch {
        /* listen 解除失敗は無視 */
      }
    }
  };

  // terminal (done/error) ハンドラを cleanup 自動付与でラップ。
  // ユーザー callback の例外は飲み込み (cleanup を最優先で実行する)。
  const wrapTerminal =
    <T>(fn: ((e: T) => void | Promise<void>) | undefined) =>
    async (e: T) => {
      try {
        if (fn) await fn(e);
      } catch (err) {
        console.error("post-effect terminal handler error", err);
      } finally {
        cleanup();
      }
    };

  const registered = await Promise.all([
    callbacks.onProgress
      ? onPostEffectProgress(callbacks.onProgress)
      : Promise.resolve(() => {}),
    callbacks.onPartial
      ? onPostEffectPartial(callbacks.onPartial)
      : Promise.resolve(() => {}),
    onPostEffectDone(wrapTerminal(callbacks.onDone)),
    onPostEffectError(wrapTerminal(callbacks.onError)),
  ]);
  unlisteners.push(...registered);

  // Listen 登録 → 呼び出し側 await 前に done/error が届くと
  // cleanup() が走るが、unlisteners に他の listen も入っているので OK。
  try {
    const result = await starter();
    // from_cache: true のときバックエンドはタスクを spawn せず、
    // 既存の completed run の id だけ返してくる。done イベントは
    // 永遠に飛んでこないので、ここで合成的に onDone を fire してやる。
    // (これがないと spinner が永久に回る)
    if (result.from_cache) {
      const synthetic: PostEffectDoneEvent = {
        run_id: result.run_id,
        annotation_count: 0,
        from_cache: true,
      };
      // wrapTerminal と同じ意味: callback 実行 → cleanup
      void (async () => {
        try {
          if (callbacks.onDone) await callbacks.onDone(synthetic);
        } catch (err) {
          console.error("post-effect onDone (cache) error", err);
        } finally {
          cleanup();
        }
      })();
    }
    return { runId: result.run_id, cleanup };
  } catch (e) {
    cleanup(); // 起動自体が失敗したらリスナーをリーク死しないよう解除
    throw e;
  }
}
