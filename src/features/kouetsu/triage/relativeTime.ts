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
import { instantFrom, Temporal } from "@/lib/time";

export type RelativeTime =
  | { kind: "justNow" }
  | { kind: "minutesAgo"; minutes: number }
  | { kind: "timeOfDay"; label: string /* HH:MM */ }
  | { kind: "yesterday" }
  | { kind: "date"; label: string /* M/D */ };

/**
 * RFC 3339 / legacy SQLite 時刻文字列を now 起点の相対時刻表現へ変換する。
 *
 * 規則（上から順に優先）:
 * 1. 60 秒未満          → justNow
 * 2. 60 分未満          → minutesAgo（分は切り捨て、1〜59）
 * 3. 同一ローカル日     → timeOfDay（"HH:MM" ゼロ埋め、ローカル時刻）
 * 4. 前日（ローカル）   → yesterday
 * 5. それ以前           → date（"M/D" ゼロ埋めなし、ローカル日付）
 *
 * 不正な時刻文字列は null を返す。i18n はしない（UI 層が kind ごとに
 * t() でレンダリングする）。未来時刻はクロックずれ耐性として規則 1 に
 * 丸め込まれる（diff が負 → justNow）。
 */
export function formatRelativeTime(
  iso: string,
  now: Date,
): RelativeTime | null {
  const targetInstant = instantFrom(iso);
  const nowEpochMilliseconds = now.getTime();
  if (targetInstant === null || !Number.isFinite(nowEpochMilliseconds)) {
    return null;
  }

  const diffMs = nowEpochMilliseconds - targetInstant.epochMilliseconds;
  if (diffMs < 60_000) return { kind: "justNow" };

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { kind: "minutesAgo", minutes };

  const timeZone = Temporal.Now.timeZoneId();
  const target = targetInstant.toZonedDateTimeISO(timeZone);
  const current = Temporal.Instant.fromEpochMilliseconds(nowEpochMilliseconds)
    .toZonedDateTimeISO(timeZone);
  const dayDiff = target
    .toPlainDate()
    .until(current.toPlainDate(), { largestUnit: "day" }).days;
  if (dayDiff === 0) {
    const hh = String(target.hour).padStart(2, "0");
    const mm = String(target.minute).padStart(2, "0");
    return { kind: "timeOfDay", label: `${hh}:${mm}` };
  }
  if (dayDiff === 1) return { kind: "yesterday" };
  return { kind: "date", label: `${target.month}/${target.day}` };
}
