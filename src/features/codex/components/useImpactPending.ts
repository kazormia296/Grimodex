import { useEffect, useRef, useState } from "react";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import {
  IMPACT_PENDING_NONE,
  type ImpactPending,
} from "@/features/impact-review/impactPending";
import { readImpactPending } from "@/features/impact-review/readImpactPending";
import { useImpactPendingEpochStore } from "@/features/impact-review/impactPendingEpoch";

/** 項目の更新・タブ切替などの再計算を、保存の連打でまとめる待ち（ms）。mount 時は待たない。 */
const RECOMPUTE_DEBOUNCE_MS = 500;

/**
 * 「前回のチェック以降の変更」を、影響チェックのボタンを押す前に知らせるための状態（DR-INN-1）。
 * ローカルの DB 読み 2 回＋純関数だけ。AI は呼ばない・何も保存しない。
 *
 * 出すのは `pending` だけ。AI gate が enabled でない間・影響チェックの実行中・読みの失敗は
 * 「表示なし」（`none`）。再計算の契機: mount／entryId の変化／`refreshKey` の変化
 * （debounce）／実行中の終了／押下完了の合図（epoch）。
 */
export function useImpactPending(
  entryId: string,
  refreshKey: string = "",
): ImpactPending {
  const aiEnabled = useAiGate("analysis").presentation === "enabled";
  const running = useIsPostEffectRunning("impact_review", "project");
  const epoch = useImpactPendingEpochStore((s) => s.epoch);
  const [result, setResult] = useState<{
    entryId: string;
    pending: ImpactPending;
  } | null>(null);
  const active = aiEnabled && !running;
  // 押下完了の合図（epoch）が前回の読みから進んでいれば、debounce せずすぐ読む。
  const readEpoch = useRef(epoch);
  // 影響チェックの実行が終わった（running が true → false）後は、baseline の前進を待つ
  // ボタンの onDone／onError の合図（epoch の進み）が来るまで読まない。post-effect/api.ts は
  // store の complete（running が落ちる）を callbacks.onDone（baseline の前進の後）より
  // 先に走らせるので、すぐ読むと古い baseline を見て「N 件」が戻る。
  const wasRunning = useRef(running);
  const awaitingEpoch = useRef<{ entryId: string; epoch: number } | null>(null);
  // 実行中に最後に見た epoch。実行の終了と合図が同じ描画にまとまっても、合図を取りこぼさない。
  const epochWhileRunning = useRef(epoch);

  useEffect(() => {
    const justFinishedRun = wasRunning.current && !running;
    wasRunning.current = running;
    if (running) epochWhileRunning.current = epoch;
    if (justFinishedRun && aiEnabled) {
      awaitingEpoch.current = { entryId, epoch: epochWhileRunning.current };
    }
    if (!active) {
      // AI が使えない・実行中の間は読まず、前の結果も残さない（終了直後に古い件数を出さない）。
      setResult(null);
      return;
    }
    const awaiting = awaitingEpoch.current;
    if (awaiting && awaiting.entryId === entryId && awaiting.epoch === epoch) {
      // 実行の終了直後で、まだ baseline の前進の合図が来ていない。結果は消したまま待つ。
      setResult(null);
      return;
    }
    awaitingEpoch.current = null;
    let cancelled = false;
    const epochAdvanced = readEpoch.current !== epoch;
    readEpoch.current = epoch;
    const timer = setTimeout(
      () => {
        readImpactPending(entryId)
          .then((pending) => {
            if (!cancelled) setResult({ entryId, pending });
          })
          .catch(() => {
            // 読みの失敗は表示なし（toast も出さない）。
            if (!cancelled) setResult(null);
          });
      },
      result?.entryId === entryId && !epochAdvanced ? RECOMPUTE_DEBOUNCE_MS : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // result は debounce の有無の判定にだけ使う（依存に入れると読みの完了で再実行される）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, active, epoch, refreshKey]);

  // entryId が変わった直後に、前の項目の結果を一瞬でも出さない。
  if (!active || result === null || result.entryId !== entryId) {
    return IMPACT_PENDING_NONE;
  }
  return result.pending;
}
