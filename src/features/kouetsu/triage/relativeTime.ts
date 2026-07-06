/**
 * relativeTime.ts — 校閲トリアージ用の相対時刻フォーマッタ（純関数）。
 *
 * 既存ユーティリティの調査結果（重複実装回避のための記録）:
 * - `src/features/trash-bin/TrashBinListView.tsx` の relativeTime は
 *   コンポーネントローカルで i18next 直結（seconds/hours/days 粒度）と仕様が異なる。
 * - `src/features/chronicle/chronicleTime.ts` の formatRelativeDays は
 *   作中暦（ChronicleCalendar）用で実時刻とは別物。
 * いずれも本用途（構造化した RelativeTime を返し、文言化は UI 層の t() に
 * 委譲する）とは互換しないため新規実装とした。
 */

export type RelativeTime =
  | { kind: "justNow" }
  | { kind: "minutesAgo"; minutes: number }
  | { kind: "timeOfDay"; label: string /* HH:MM */ }
  | { kind: "yesterday" }
  | { kind: "date"; label: string /* M/D */ };

/** ローカル日付の 0 時（日境界比較用）。 */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * ISO 8601 文字列を now 起点の相対時刻表現へ変換する。
 *
 * 規則（上から順に優先）:
 * 1. 60 秒未満          → justNow
 * 2. 60 分未満          → minutesAgo（分は切り捨て、1〜59）
 * 3. 同一ローカル日     → timeOfDay（"HH:MM" ゼロ埋め、ローカル時刻）
 * 4. 前日（ローカル）   → yesterday
 * 5. それ以前           → date（"M/D" ゼロ埋めなし、ローカル日付）
 *
 * 不正な ISO 文字列は null を返す。i18n はしない（UI 層が kind ごとに
 * t() でレンダリングする）。未来時刻はクロックずれ耐性として規則 1 に
 * 丸め込まれる（diff が負 → justNow）。
 */
export function formatRelativeTime(
  iso: string,
  now: Date,
): RelativeTime | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;

  const diffMs = now.getTime() - t.getTime();
  if (diffMs < 60_000) return { kind: "justNow" };

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { kind: "minutesAgo", minutes };

  // DST で 1 日が 23/25 時間になっても round で吸収する。
  const dayDiff = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(t)) / 86_400_000,
  );
  if (dayDiff === 0) {
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    return { kind: "timeOfDay", label: `${hh}:${mm}` };
  }
  if (dayDiff === 1) return { kind: "yesterday" };
  return { kind: "date", label: `${t.getMonth() + 1}/${t.getDate()}` };
}
