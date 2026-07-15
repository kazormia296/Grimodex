/**
 * 「完走ペースメーカー」の純関数。原稿の目標総文字数・現在総量・直近の暦日平均
 * ペース・任意の締切から、完走予定日と（締切があれば）必要ペース・間に合うかを
 * 計算する。`computeGoalProgress`（本日の目標）の累積版にあたる。
 *
 * すべて `now`（unix ms）を注入する純関数。日付はローカルタイムゾーン基準の
 * `Temporal.PlainDate` と "YYYY-MM-DD" 日キーで扱うため、DST を跨いでも
 * 24 時間単位の差分計算に引きずられない。
 */
import { plainDateAtEpochMilliseconds, plainDateFromKey } from "@/lib/time";

export interface FinishLineInput {
  /** 目標総文字数（<= 0 は「目標未設定」）。 */
  target: number;
  /** 現在の原稿総文字数（シーン charCount の合計、負値は 0 にクランプ）。 */
  current: number;
  /** 直近の暦日平均ペース（字/日、負値は 0 にクランプ）。 */
  pace: number;
  /** 締切のローカル日キー "YYYY-MM-DD"。未設定は null/空。 */
  deadlineKey: string | null;
  /** 現在時刻 unix ms。 */
  now: number;
}

export interface FinishLineProgress {
  /** 有効な目標が設定されているか（target > 0）。 */
  hasTarget: boolean;
  target: number;
  /** 現在の原稿総文字数（0 クランプ済み）。 */
  current: number;
  /** 目標までの残り文字数（達成済みは 0）。 */
  remaining: number;
  /** 0..100 に丸めてクランプした達成率。 */
  pct: number;
  reached: boolean;
  /** 直近の暦日平均ペース（字/日、0 クランプ済み）。 */
  pace: number;
  /** 現ペースで完走に要する残り日数（ceil）。達成済みは 0、ペース 0 等で算出不能なら null。 */
  daysToFinish: number | null;
  /** 完走予定日のローカル日キー "YYYY-MM-DD"。達成済み/算出不能なら null。 */
  projectedFinishKey: string | null;
  hasDeadline: boolean;
  /** 締切まで残り日数（今日基準・過ぎていれば負）。締切なしは null。 */
  daysUntilDeadline: number | null;
  /** 締切に間に合わせるのに必要な 1 日あたり字数（ceil）。締切なし/達成済みは null。 */
  requiredPace: number | null;
  /** 完走予定が締切に対し何日 遅れる(正)/早い(負) か。締切なし/達成済み/算出不能は null。 */
  deltaDays: number | null;
  /** 現ペースで締切に間に合うか。締切なし/達成済みは null。 */
  onTrack: boolean | null;
}

/**
 * 完走進捗とペースメーカー指標を計算する純関数。`target <= 0` は「目標未設定」
 * として hasTarget=false を返す（締切の残り日数だけは設定されていれば返す）。
 */
export function computeFinishLineProgress(
  input: FinishLineInput,
): FinishLineProgress {
  const current = input.current > 0 ? input.current : 0;
  const pace = input.pace > 0 ? input.pace : 0;
  const { target } = input;
  const deadline =
    input.deadlineKey && input.deadlineKey.length > 0
      ? plainDateFromKey(input.deadlineKey)
      : null;
  const hasDeadline = deadline !== null;
  const today = plainDateAtEpochMilliseconds(input.now);
  const daysUntilDeadline = hasDeadline
    ? today.until(deadline, { largestUnit: "day" }).days
    : null;

  if (target <= 0) {
    return {
      hasTarget: false,
      target: 0,
      current,
      remaining: 0,
      pct: 0,
      reached: false,
      pace,
      daysToFinish: null,
      projectedFinishKey: null,
      hasDeadline,
      daysUntilDeadline,
      requiredPace: null,
      deltaDays: null,
      onTrack: null,
    };
  }

  const remaining = Math.max(0, target - current);
  const reached = current >= target;
  const pct = Math.min(100, Math.round((current / target) * 100));

  const daysToFinish = reached
    ? 0
    : pace > 0
      ? Math.ceil(remaining / pace)
      : null;
  const projectedFinishKey =
    !reached && daysToFinish !== null
      ? today.add({ days: daysToFinish }).toString()
      : null;

  let requiredPace: number | null = null;
  let deltaDays: number | null = null;
  let onTrack: boolean | null = null;
  if (hasDeadline && !reached) {
    requiredPace =
      // 締切が未来なら残りを残日数で割る。今日/過去なら残り全部を即日。
      daysUntilDeadline! > 0
        ? Math.ceil(remaining / daysUntilDeadline!)
        : remaining;
    if (daysToFinish === null) {
      // ペース 0 で残りあり → どんな締切にも間に合わない。
      onTrack = false;
      deltaDays = null;
    } else {
      deltaDays = daysToFinish - daysUntilDeadline!;
      onTrack = deltaDays <= 0;
    }
  }

  return {
    hasTarget: true,
    target,
    current,
    remaining,
    pct,
    reached,
    pace,
    daysToFinish,
    projectedFinishKey,
    hasDeadline,
    daysUntilDeadline,
    requiredPace,
    deltaDays,
    onTrack,
  };
}
