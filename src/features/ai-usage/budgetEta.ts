/**
 * 月次コスト予算のバーンレート / ETA 純関数 (機能①「トークン予算 ETA」)。
 *
 * 副作用なし・I/O なし。ai_usage から解決済みのコスト点列 (CostPoint) と、
 * プロジェクトの月予算 (USD) と「現在時刻」を受け取り、当月の累計コスト・
 * 日次バーンレート・月末予測・予算到達までの残日数などを算出する。
 *
 * 設計判断:
 * - 予算はコスト (USD)・プロジェクト毎・月次・**表示のみ** (生成はブロックしない)。
 *   よってここは数値を返すだけで、警告の出し分けは UI 側の責務。
 * - すべての境界 (0 除算 / NaN / 負値 / 予算未設定 / 月初) を安全側に倒し、
 *   出力は常に有限 (Number.isFinite) かつ非負になるよう正規化する。
 * - 「月」はローカルカレンダー月で切る (UI 表示と一致させるため。created_at は
 *   ISO だが Date でローカル解釈する)。
 */

/** ai_usage の 1 行から取り出したコスト点。createdAt は ISO 文字列。 */
export interface CostPoint {
  /** ISO 8601 タイムスタンプ (ai_usage.created_at)。 */
  createdAt: string;
  /** 解決済みコスト (provider 実値 or modelPricing 推定)。USD。 */
  costUsd: number;
}

export interface BudgetEtaInput {
  /** 対象プロジェクトのコスト点列 (期間で絞っていなくてよい。当月で内部フィルタする)。 */
  points: CostPoint[];
  /** 月予算 (USD)。0 以下 = 未設定。 */
  budgetUsd: number;
  /** 現在時刻 (テスト決定性のため注入)。 */
  now: Date;
  /** 直近ペースを測る窓 (日数)。既定 7。 */
  recentWindowDays?: number;
}

export interface BudgetEtaResult {
  // --- 当月実績 ---
  /** 当月 (カレンダー月) の累計コスト USD。 */
  monthCostUsd: number;
  /** 当月の日数 (例: 6月=30)。 */
  daysInMonth: number;
  /** 月初から今日までの経過日数 (今日を含む。最小 1)。 */
  elapsedDays: number;
  /** 今月末までの残り日数 (今日を含まない。最小 0)。 */
  remainingDays: number;

  // --- バーンレート / 予測 (平均ペース) ---
  /** 平均日次バーンレート = monthCost / elapsedDays。 */
  dailyRateUsd: number;
  /** 平均ペースでの月末予測 = dailyRate * daysInMonth。 */
  projectedMonthEndUsd: number;

  // --- 直近ペース ---
  /** 直近 N 日 (既定 7) の日次バーンレート。 */
  recentDailyRateUsd: number;
  /** 直近ペースでの月末予測 = monthCost + recentRate * remainingDays。 */
  recentProjectedMonthEndUsd: number;

  // --- 予算 ---
  /** 予算が設定済み (budgetUsd > 0) か。 */
  budgetSet: boolean;
  /** 消化率 % (monthCost / budget * 100)。予算未設定なら null。 */
  percentConsumed: number | null;
  /**
   * 予算到達までの残日数 = (budget - monthCost) / dailyRate。
   * 予算未設定 or レート 0 なら null、既に超過なら 0。
   */
  daysUntilBudget: number | null;
  /** 既に当月累計が予算を超えているか。 */
  overBudget: boolean;
  /** 平均ペースの月末予測が予算を超えるか (まだ超えていなくても警告するため)。 */
  projectedOverBudget: boolean;
}

/** 数値を有限・非負に正規化する。NaN / Infinity / 負値は 0。 */
function safeNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 当月 (ローカルカレンダー月) の [開始ms, 翌月開始ms) を返す。 */
export function monthRange(now: Date): { startMs: number; endMs: number } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 1, 0, 0, 0, 0); // Date が年跨ぎを正規化
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/** 当月の総日数 (28〜31)。 */
function daysInMonthOf(now: Date): number {
  // 翌月 0 日 = 当月末日。
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 月次予算のバーンレート / ETA を算出する。
 *
 * @example
 *   computeBudgetEta({ points, budgetUsd: 60, now: new Date() })
 */
export function computeBudgetEta(inp: BudgetEtaInput): BudgetEtaResult {
  const { points, now } = inp;
  const budgetUsd = safeNonNeg(inp.budgetUsd);
  const budgetSet = budgetUsd > 0;
  const recentWindowDays =
    inp.recentWindowDays && inp.recentWindowDays > 0 ? inp.recentWindowDays : 7;

  const { startMs, endMs } = monthRange(now);
  const nowMs = now.getTime();
  const daysInMonth = daysInMonthOf(now);

  // 経過日数 = 今日の "日" 番号 (1..daysInMonth)。今日を含むので最小 1。
  const elapsedDays = Math.min(Math.max(now.getDate(), 1), daysInMonth);
  // 月末までの残り日数 (今日を含まない)。最小 0。
  const remainingDays = Math.max(daysInMonth - elapsedDays, 0);

  // 直近窓の開始 (now から recentWindowDays 日前)。
  const recentStartMs = nowMs - recentWindowDays * MS_PER_DAY;

  let monthCostUsd = 0;
  let recentCostUsd = 0;
  for (const p of points) {
    const cost = safeNonNeg(p.costUsd);
    if (cost === 0) continue;
    const t = Date.parse(p.createdAt);
    if (!Number.isFinite(t)) continue;
    if (t >= startMs && t < endMs) {
      monthCostUsd += cost;
    }
    // 直近窓は「現時点までの直近 N 日」。当月内か否かは問わない方が
    // 月初の数日で過小評価しにくいが、月をまたいだ点は当月予測には使わない
    // ため、当月内 (>= startMs) かつ直近窓内に限定する。
    if (t >= recentStartMs && t <= nowMs && t >= startMs) {
      recentCostUsd += cost;
    }
  }

  const dailyRateUsd = elapsedDays > 0 ? monthCostUsd / elapsedDays : 0;
  const projectedMonthEndUsd = dailyRateUsd * daysInMonth;

  const recentDailyRateUsd = recentCostUsd / recentWindowDays;
  const recentProjectedMonthEndUsd =
    monthCostUsd + recentDailyRateUsd * remainingDays;

  let percentConsumed: number | null = null;
  let daysUntilBudget: number | null = null;
  let overBudget = false;
  let projectedOverBudget = false;

  if (budgetSet) {
    percentConsumed = (monthCostUsd / budgetUsd) * 100;
    overBudget = monthCostUsd >= budgetUsd;
    projectedOverBudget = projectedMonthEndUsd > budgetUsd;
    if (overBudget) {
      daysUntilBudget = 0;
    } else if (dailyRateUsd > 0) {
      daysUntilBudget = (budgetUsd - monthCostUsd) / dailyRateUsd;
    } else {
      // まだ予算内だがレート 0 → 永遠に到達しない → null (UI で「—」表示)。
      daysUntilBudget = null;
    }
  }

  return {
    monthCostUsd,
    daysInMonth,
    elapsedDays,
    remainingDays,
    dailyRateUsd,
    projectedMonthEndUsd,
    recentDailyRateUsd,
    recentProjectedMonthEndUsd,
    budgetSet,
    percentConsumed,
    daysUntilBudget,
    overBudget,
    projectedOverBudget,
  };
}
