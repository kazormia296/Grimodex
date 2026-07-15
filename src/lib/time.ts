import { Temporal } from "./temporal";

export { Temporal } from "./temporal";

export type InstantInput = string | number | Date | Temporal.Instant;

const ISO_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_UTC_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)$/;

/**
 * SQLite の `datetime('now')` が返すタイムゾーンなし文字列だけを UTC とみなす。
 * その他の文字列は Temporal の RFC 3339 / ISO 8601 パーサーへそのまま渡す。
 */
function normalizeInstantString(value: string): string {
  const trimmed = value.trim();
  const sqliteTimestamp = SQLITE_UTC_TIMESTAMP_PATTERN.exec(trimmed);
  return sqliteTimestamp
    ? `${sqliteTimestamp[1]}T${sqliteTimestamp[2]}Z`
    : trimmed;
}

/** DB・IPC のプリミティブ値を Temporal.Instant へ変換する共通境界。 */
export function instantFrom(input: InstantInput): Temporal.Instant | null {
  try {
    if (typeof input === "number") {
      if (!Number.isFinite(input) || !Number.isInteger(input)) return null;
      return Temporal.Instant.fromEpochMilliseconds(input);
    }

    if (input instanceof Date) {
      const epochMilliseconds = input.getTime();
      return Number.isFinite(epochMilliseconds)
        ? Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
        : null;
    }

    if (typeof input === "string") {
      const normalized = normalizeInstantString(input);
      return normalized.length > 0 ? Temporal.Instant.from(normalized) : null;
    }

    return Temporal.Instant.from(input);
  } catch {
    return null;
  }
}

/** DB・IPC 境界向けの epoch milliseconds。変換不能なら null。 */
export function instantEpochMilliseconds(input: InstantInput): number | null {
  return instantFrom(input)?.epochMilliseconds ?? null;
}

/** 実時刻を時系列で比較する。変換不能値は昇順・降順とも末尾へ送る。 */
export function compareInstantValues(
  left: InstantInput | null | undefined,
  right: InstantInput | null | undefined,
  direction: "ascending" | "descending" = "ascending",
): number {
  const leftEpoch = left == null ? null : instantEpochMilliseconds(left);
  const rightEpoch = right == null ? null : instantEpochMilliseconds(right);

  if (leftEpoch === null && rightEpoch === null) {
    const order = String(left ?? "").localeCompare(String(right ?? ""));
    return direction === "ascending" ? order : -order;
  }
  if (leftEpoch === null) return 1;
  if (rightEpoch === null) return -1;

  const order = Math.sign(leftEpoch - rightEpoch);
  return direction === "ascending" ? order : -order;
}

/** UTC・ミリ秒固定の RFC 3339 文字列。変換不能なら null。 */
export function canonicalInstantString(input: InstantInput): string | null {
  return instantFrom(input)?.toString({ fractionalSecondDigits: 3 }) ?? null;
}

/** Temporal.Instant をローカライズ表示する。変換不能なら null。 */
export function formatInstant(
  input: InstantInput,
  locales?: Intl.LocalesArgument,
  options?: Intl.DateTimeFormatOptions,
): string | null {
  return instantFrom(input)?.toLocaleString(locales, options) ?? null;
}

/** 現在時刻を UTC・ミリ秒固定の RFC 3339 文字列で返す。 */
export function nowInstantString(): string {
  return Temporal.Now.instant().toString({ fractionalSecondDigits: 3 });
}

/** 厳密な `YYYY-MM-DD` を PlainDate として読む。 */
export function plainDateFromKey(value: string): Temporal.PlainDate | null {
  if (!ISO_DATE_KEY_PATTERN.test(value)) return null;

  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    return null;
  }
}

/** epoch milliseconds が属する暦日を、明示したタイムゾーンで返す。 */
export function plainDateAtEpochMilliseconds(
  epochMilliseconds: number,
  timeZone = Temporal.Now.timeZoneId(),
): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}
