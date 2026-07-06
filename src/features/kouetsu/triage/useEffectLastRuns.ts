/**
 * useEffectLastRuns.ts — 観点別の最新完了 run の completedAt を取得するフック。
 *
 * 設計上の決定（2026-07-06 トリアージ設計書 Phase 1C）:
 * - 対象は EFFECT_LAST_RUN_TARGETS の 7 種。consistency と
 *   intra_scene_consistency は畳み込まず**生のまま 7 キーで返す**
 *   （"consistency" への max 畳み込みは表示側の責務。フックは単純さを優先）。
 * - `list_post_effect_runs` は status フィルタを持たず started_at 降順で
 *   返す（src-tauri/src/commands/post_effect.rs）ため、effect ごとに
 *   RUN_FETCH_LIMIT 件を取得し、最初の status === "completed" の
 *   completedAt を採用する。
 * - 再取得トリガ（fullCheck 完了・個別 run done 等）は呼び出し側が
 *   refresh() を呼ぶ責務。**フック内でのイベント購読はしない**。
 * - projectId（useTreeStore）が空の間は何もしない。
 * - 失敗した effect は throw せず undefined のまま残す（部分成功を許容）。
 * - アンマウント後は setState しない（cancelled フラグ）。
 */

import { useCallback, useEffect, useState } from "react";
import { listPostEffectRuns } from "@/features/post-effect/api";
import type { PostEffectType } from "@/features/post-effect/types";
import { useTreeStore } from "@/features/tree/treeStore";

/**
 * 最終実行時刻を表示する観点（設計書 Phase 1C の 7 種 + impact_review、固定順）。
 * impact_review はダッシュボードタイルの「未実行」判定に使う（フッターには
 * 出さない — 手動運用のため鮮度ドットの対象外）。
 */
export const EFFECT_LAST_RUN_TARGETS: readonly PostEffectType[] = [
  "typo_detection",
  "consistency",
  "intra_scene_consistency",
  "review",
  "intent_drift",
  "meta_structure",
  "timeline_consistency",
  "impact_review",
];

/** 直近に failed / cancelled / running が混ざっても completed を拾える深さ。 */
const RUN_FETCH_LIMIT = 10;

/** 観点 → 最新完了 run の completedAt（ISO）。未実行/失敗は undefined。 */
export type EffectLastRunMap = Partial<Record<PostEffectType, string>>;

export interface EffectLastRuns {
  lastRuns: EffectLastRunMap;
  refresh: () => void;
  loading: boolean;
}

export function useEffectLastRuns(): EffectLastRuns {
  const projectId = useTreeStore((s) => s.projectId);
  const [lastRuns, setLastRuns] = useState<EffectLastRunMap>({});
  const [loading, setLoading] = useState(false);
  // refresh() でインクリメントして effect を再発火させる。
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      EFFECT_LAST_RUN_TARGETS.map(async (effectType) => {
        try {
          const runs = await listPostEffectRuns({
            projectId,
            effectType,
            limit: RUN_FETCH_LIMIT,
          });
          const done = runs.find(
            (r) => r.status === "completed" && r.completedAt != null,
          );
          return [effectType, done?.completedAt ?? undefined] as const;
        } catch {
          // 失敗した effect は undefined のまま（他 effect の結果は活かす）。
          return [effectType, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: EffectLastRunMap = {};
      for (const [effectType, completedAt] of entries) {
        if (completedAt !== undefined) next[effectType] = completedAt;
      }
      setLastRuns(next);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { lastRuns, refresh, loading };
}
