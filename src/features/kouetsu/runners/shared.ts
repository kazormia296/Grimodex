/**
 * runners/shared.ts — 校閲 runner 群の共有型とヘルパー。
 *
 * ガード(policy/license) → flush → payload build → runPostEffect(Multi) →
 * outcome 正規化 のうち、各 runner に共通する部分をまとめる。
 */

import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { runPostEffect, runPostEffectMulti } from "@/features/post-effect/api";
import { getSceneIdsForScope } from "@/features/post-effect/consistencyPayloadBuilder";
import type {
  StartPostEffectRunRequest,
  StartPostEffectRunMultiRequest,
  PostEffectDoneEvent,
} from "@/features/post-effect/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type KouetsuRunScope =
  | { type: "scene"; sceneId: string }
  | { type: "folder"; anchorId: string }
  | { type: "project" };

export type KouetsuRunOutcome =
  // 実行/キャッシュ短絡で完了（summary は multi の部分失敗メッセージ）。
  | { ok: true; fromCache: boolean; count: number; summary?: string }
  // 起動 or 実行が失敗（ガードとは別。ビューはエラートーストを出す）。
  | { ok: false; error: string }
  // 対象シーン 0 件。ビューは基本無反応（timeline のみ noScenesPlaced 表示）。
  | { ok: true; skipped: true }
  // policy/license ガードで拒否（ガードが既に toast 済み。ビューは無反応）。
  | { ok: true; blocked: true };

export const SKIPPED: KouetsuRunOutcome = { ok: true, skipped: true };
export const BLOCKED: KouetsuRunOutcome = { ok: true, blocked: true };

/**
 * runner が起動した実 run の副作用フック。全体チェックが「自分が起動した run
 * だけ」を中止対象に絞るために使う（無関係の並走 run を巻き込まないため）。
 * onRunStarted は backend が採番した run_id を run 起動直後に通知する。
 */
export interface KouetsuRunHooks {
  onRunStarted?: (runId: string) => void;
}

// ---------------------------------------------------------------------------
// Guards / scope / params
// ---------------------------------------------------------------------------

/** policy / license ガード。ブロック時（ガードが toast 済み）は false を返す。 */
export function guardsPass(): boolean {
  if (blockIfPolicyOff("analysis")) return false;
  if (blockIfUnlicensed()) return false;
  return true;
}

export type MultiScope = Exclude<KouetsuRunScope, { type: "scene" }>;

/** folder → {folder, anchorId} / project → {project, null}。 */
export function multiScope(scope: MultiScope): {
  scopeType: "folder" | "project";
  scopeTargetId: string | null;
} {
  return scope.type === "folder"
    ? { scopeType: "folder", scopeTargetId: scope.anchorId }
    : { scopeType: "project", scopeTargetId: null };
}

/** projectId / lang / model(base) / customKouetsu をまとめて読む。 */
export function commonParams() {
  return {
    projectId: useTreeStore.getState().projectId,
    lang: getCurrentProjectLanguage(),
    model: useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini",
    customKouetsu: useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", ""),
  };
}

/** scope 内のシーンが 0 件かを getSceneIdsForScope で判定する。 */
export function scopeHasNoScenes(
  scopeType: "folder" | "project",
  target: string | null,
): boolean {
  return (
    getSceneIdsForScope(useTreeStore.getState().nodes, scopeType, target)
      .length === 0
  );
}

// ---------------------------------------------------------------------------
// Launch + normalize
// ---------------------------------------------------------------------------

function normalizeDone(e: PostEffectDoneEvent): KouetsuRunOutcome {
  return {
    ok: true,
    fromCache: e.from_cache ?? false,
    count: e.annotation_count,
    summary: e.summary,
  };
}

/** runPostEffect を起動し、terminal イベントを待って outcome へ正規化する。 */
export function launchSingle(
  req: StartPostEffectRunRequest,
  hooks?: KouetsuRunHooks,
): Promise<KouetsuRunOutcome> {
  return new Promise((resolve) => {
    runPostEffect(req, {
      onDone: (e) => resolve(normalizeDone(e)),
      onError: (e) => resolve({ ok: false, error: e.error }),
    })
      // 起動成功時に run_id を呼び出し側へ通知（中止対象の限定に使う）。
      // begin は runPostEffect の resolve 前に済んでいるので、この時点で
      // runStore にエントリが存在する。
      .then(({ runId }) => hooks?.onRunStarted?.(runId))
      .catch((err) => resolve({ ok: false, error: String(err) }));
  });
}

/** runPostEffectMulti を起動し、terminal イベントを待って outcome へ正規化する。 */
export function launchMulti(
  req: StartPostEffectRunMultiRequest,
  hooks?: KouetsuRunHooks,
): Promise<KouetsuRunOutcome> {
  return new Promise((resolve) => {
    runPostEffectMulti(req, {
      onDone: (e) => resolve(normalizeDone(e)),
      onError: (e) => resolve({ ok: false, error: e.error }),
    })
      .then(({ runId }) => hooks?.onRunStarted?.(runId))
      .catch((err) => resolve({ ok: false, error: String(err) }));
  });
}
