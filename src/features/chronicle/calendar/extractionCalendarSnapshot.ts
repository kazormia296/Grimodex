import {
  digestStableJson,
  hasLoneSurrogate,
  stableJsonStringify,
} from "@/features/narrative-extraction/source/digest";
import { freezeDeep } from "@/features/narrative-extraction/source/immutability";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import type { CalendarReform, LeapRule, TimeZoneDef } from "../chronicleTime";

export const EXTRACTION_CALENDAR_SCHEMA_VERSION = 1 as const;
export const EXTRACTION_CALENDAR_REF = "CAL001" as const;

export interface ExtractionCalendarSnapshotInput {
  readonly version: number;
  readonly startYear: number;
  readonly daysPerYear: number;
  readonly months: string;
  readonly seasonBoundaries: string;
  readonly eras: string;
  readonly weekdayNames: string;
  readonly weekdayStartIndex: number;
  readonly leapRule: string;
  readonly reform: string;
  readonly timezone: string;
  readonly lunarTzMinutes: number;
}

export interface ExtractionCalendarMonth {
  readonly ref: string;
  readonly name: string;
  readonly days: number;
}

export interface ExtractionCalendarSeason {
  readonly ref: string;
  readonly name: string;
  readonly startDayOfYear: number;
}

export interface ExtractionCalendarEra {
  readonly ref: string;
  readonly name: string;
  readonly startYear: number;
}

export interface ExtractionCalendarSnapshot {
  readonly schemaVersion: typeof EXTRACTION_CALENDAR_SCHEMA_VERSION;
  readonly calendarRef: typeof EXTRACTION_CALENDAR_REF;
  readonly version: number;
  readonly digest: Sha256Digest;
  readonly startYear: number;
  readonly daysPerYear: number;
  readonly months: readonly ExtractionCalendarMonth[];
  readonly seasons: readonly ExtractionCalendarSeason[];
  readonly eras: readonly ExtractionCalendarEra[];
  readonly weekdayNames: readonly string[];
  readonly weekdayStartIndex: number;
  readonly leapRule: Readonly<LeapRule>;
  readonly reform: Readonly<CalendarReform> | null;
  readonly timezone: Readonly<TimeZoneDef> | null;
  readonly lunarTzMinutes: number;
}

export interface ExtractionCalendarDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type ExtractionCalendarSnapshotBuildResult =
  | { readonly ok: true; readonly snapshot: ExtractionCalendarSnapshot }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ExtractionCalendarDiagnostic[];
    };

export type ExtractionCalendarSnapshotVerificationResult =
  ExtractionCalendarSnapshotBuildResult;

function diagnostic(
  code: string,
  message: string,
  path?: string,
): ExtractionCalendarDiagnostic {
  return { code, message, ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !hasLoneSurrogate(value) &&
    !/\p{Cc}/u.test(value)
  );
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function parseJson(
  raw: string,
  path: string,
  diagnostics: ExtractionCalendarDiagnostic[],
): unknown {
  if (typeof raw !== "string" || hasLoneSurrogate(raw)) {
    diagnostics.push(
      diagnostic("CALENDAR_INVALID_JSON", "Calendar JSON is invalid", path),
    );
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    diagnostics.push(
      diagnostic("CALENDAR_INVALID_JSON", "Calendar JSON is invalid", path),
    );
    return undefined;
  }
}

function cloneInput(
  input: ExtractionCalendarSnapshotInput,
): ExtractionCalendarSnapshotInput {
  if (!isRecord(input)) {
    throw new TypeError("Calendar Snapshot input must be an object");
  }
  return {
    version: input.version,
    startYear: input.startYear,
    daysPerYear: input.daysPerYear,
    months: input.months,
    seasonBoundaries: input.seasonBoundaries,
    eras: input.eras,
    weekdayNames: input.weekdayNames,
    weekdayStartIndex: input.weekdayStartIndex,
    leapRule: input.leapRule,
    reform: input.reform,
    timezone: input.timezone,
    lunarTzMinutes: input.lunarTzMinutes,
  };
}

function parseMonths(
  value: unknown,
  diagnostics: ExtractionCalendarDiagnostic[],
): ExtractionCalendarMonth[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_MONTH",
          "Calendar months must be an array",
          "months",
        ),
      );
    }
    return [];
  }
  const months: ExtractionCalendarMonth[] = [];
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !validName(item.name) ||
      !safeInteger(item.days) ||
      item.days <= 0
    ) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_MONTH",
          "Calendar month is invalid",
          `months[${index}]`,
        ),
      );
      continue;
    }
    months.push({
      ref: `M${String(index + 1).padStart(6, "0")}`,
      name: item.name,
      days: item.days,
    });
  }
  return months;
}

function parseSeasons(
  value: unknown,
  daysPerYear: number,
  diagnostics: ExtractionCalendarDiagnostic[],
): ExtractionCalendarSeason[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_SEASON",
          "Calendar seasons must be an array",
          "seasonBoundaries",
        ),
      );
    }
    return [];
  }
  const seasons: ExtractionCalendarSeason[] = [];
  const starts = new Set<number>();
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !validName(item.name) ||
      !safeInteger(item.startDayOfYear) ||
      item.startDayOfYear < 0 ||
      item.startDayOfYear >= daysPerYear ||
      starts.has(item.startDayOfYear)
    ) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_SEASON",
          "Calendar season is invalid",
          `seasonBoundaries[${index}]`,
        ),
      );
      continue;
    }
    starts.add(item.startDayOfYear);
    seasons.push({
      ref: `S${String(index + 1).padStart(6, "0")}`,
      name: item.name,
      startDayOfYear: item.startDayOfYear,
    });
  }
  return seasons;
}

function parseEras(
  value: unknown,
  diagnostics: ExtractionCalendarDiagnostic[],
): ExtractionCalendarEra[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_ERA",
          "Calendar eras must be an array",
          "eras",
        ),
      );
    }
    return [];
  }
  const eras: ExtractionCalendarEra[] = [];
  for (const [index, item] of value.entries()) {
    if (
      !isRecord(item) ||
      !validName(item.name) ||
      !safeInteger(item.startYear)
    ) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_ERA",
          "Calendar era is invalid",
          `eras[${index}]`,
        ),
      );
      continue;
    }
    eras.push({
      ref: `E${String(index + 1).padStart(6, "0")}`,
      name: item.name,
      startYear: item.startYear,
    });
  }
  return eras;
}

function parseWeekdays(
  value: unknown,
  diagnostics: ExtractionCalendarDiagnostic[],
): string[] {
  if (!Array.isArray(value) || value.some((item) => !validName(item))) {
    if (value !== undefined) {
      diagnostics.push(
        diagnostic(
          "CALENDAR_INVALID_WEEKDAY",
          "Calendar weekday names are invalid",
          "weekdayNames",
        ),
      );
    }
    return [];
  }
  return [...value];
}

function parseLeapRule(
  value: unknown,
  monthCount: number,
  diagnostics: ExtractionCalendarDiagnostic[],
): LeapRule {
  if (isRecord(value) && value.kind === "none") return { kind: "none" };
  if (
    isRecord(value) &&
    value.kind === "gregorian" &&
    safeInteger(value.monthIndex) &&
    value.monthIndex >= 0 &&
    value.monthIndex < monthCount
  ) {
    return { kind: "gregorian", monthIndex: value.monthIndex };
  }
  if (value !== undefined) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_LEAP_RULE",
        "Calendar leap rule is invalid",
        "leapRule",
      ),
    );
  }
  return { kind: "none" };
}

function parseReform(
  value: unknown,
  diagnostics: ExtractionCalendarDiagnostic[],
): CalendarReform | null {
  if (value === null) return null;
  if (isRecord(value) && isRecord(value.gregorianStart)) {
    const start = value.gregorianStart;
    if (
      safeInteger(start.year) &&
      safeInteger(start.monthIndex) &&
      start.monthIndex >= 0 &&
      start.monthIndex <= 11 &&
      safeInteger(start.dayOfMonth) &&
      start.dayOfMonth >= 1 &&
      start.dayOfMonth <= 31 &&
      (value.region === undefined || validName(value.region))
    ) {
      return {
        gregorianStart: {
          year: start.year,
          monthIndex: start.monthIndex,
          dayOfMonth: start.dayOfMonth,
        },
        ...(typeof value.region === "string" ? { region: value.region } : {}),
      };
    }
  }
  if (value !== undefined) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_REFORM",
        "Calendar reform is invalid",
        "reform",
      ),
    );
  }
  return null;
}

function parseTimezone(
  value: unknown,
  daysPerYear: number,
  diagnostics: ExtractionCalendarDiagnostic[],
): TimeZoneDef | null {
  if (value === null) return null;
  if (
    isRecord(value) &&
    validName(value.label) &&
    safeInteger(value.offsetMinutes) &&
    value.offsetMinutes >= -1_440 &&
    value.offsetMinutes <= 1_440
  ) {
    let dst: TimeZoneDef["dst"];
    if (value.dst !== undefined) {
      if (
        !isRecord(value.dst) ||
        !validName(value.dst.label) ||
        !safeInteger(value.dst.offsetMinutes) ||
        value.dst.offsetMinutes < -1_440 ||
        value.dst.offsetMinutes > 1_440 ||
        !safeInteger(value.dst.startDayOfYear) ||
        value.dst.startDayOfYear < 0 ||
        value.dst.startDayOfYear >= daysPerYear ||
        !safeInteger(value.dst.endDayOfYear) ||
        value.dst.endDayOfYear < 0 ||
        value.dst.endDayOfYear >= daysPerYear
      ) {
        diagnostics.push(
          diagnostic(
            "CALENDAR_INVALID_TIMEZONE",
            "Calendar timezone is invalid",
            "timezone.dst",
          ),
        );
        return null;
      }
      dst = {
        label: value.dst.label,
        offsetMinutes: value.dst.offsetMinutes,
        startDayOfYear: value.dst.startDayOfYear,
        endDayOfYear: value.dst.endDayOfYear,
      };
    }
    return {
      label: value.label,
      offsetMinutes: value.offsetMinutes,
      ...(dst ? { dst } : {}),
    };
  }
  if (value !== undefined) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_TIMEZONE",
        "Calendar timezone is invalid",
        "timezone",
      ),
    );
  }
  return null;
}

export async function buildExtractionCalendarSnapshot(
  untrustedInput: ExtractionCalendarSnapshotInput,
): Promise<ExtractionCalendarSnapshotBuildResult> {
  let input: ExtractionCalendarSnapshotInput;
  try {
    input = cloneInput(untrustedInput);
  } catch {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_INVALID_INPUT",
          "Calendar Snapshot input cannot be copied",
        ),
      ],
    });
  }
  const diagnostics: ExtractionCalendarDiagnostic[] = [];
  if (!safeInteger(input.version) || input.version < 0) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_VERSION",
        "Calendar version must be a non-negative safe integer",
        "version",
      ),
    );
  }
  if (!safeInteger(input.startYear)) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_START_YEAR",
        "Calendar start year must be a safe integer",
        "startYear",
      ),
    );
  }
  if (!safeInteger(input.daysPerYear) || input.daysPerYear <= 0) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_YEAR_LENGTH",
        "Calendar year length must be a positive safe integer",
        "daysPerYear",
      ),
    );
  }

  const months = parseMonths(
    parseJson(input.months, "months", diagnostics),
    diagnostics,
  );
  if (
    months.length > 0 &&
    safeInteger(input.daysPerYear) &&
    months.reduce((sum, month) => sum + month.days, 0) !== input.daysPerYear
  ) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_YEAR_LENGTH_MISMATCH",
        "Calendar month lengths must sum to daysPerYear",
        "daysPerYear",
      ),
    );
  }
  const seasons = parseSeasons(
    parseJson(input.seasonBoundaries, "seasonBoundaries", diagnostics),
    input.daysPerYear,
    diagnostics,
  );
  const eras = parseEras(
    parseJson(input.eras, "eras", diagnostics),
    diagnostics,
  );
  const weekdayNames = parseWeekdays(
    parseJson(input.weekdayNames, "weekdayNames", diagnostics),
    diagnostics,
  );
  const validWeekdayIndex =
    safeInteger(input.weekdayStartIndex) &&
    (weekdayNames.length === 0
      ? input.weekdayStartIndex === 0
      : input.weekdayStartIndex >= 0 &&
        input.weekdayStartIndex < weekdayNames.length);
  if (!validWeekdayIndex) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_WEEKDAY_INDEX",
        "Calendar weekday start index is out of range",
        "weekdayStartIndex",
      ),
    );
  }
  const leapRule = parseLeapRule(
    parseJson(input.leapRule, "leapRule", diagnostics),
    months.length,
    diagnostics,
  );
  const reform = parseReform(
    parseJson(input.reform, "reform", diagnostics),
    diagnostics,
  );
  const timezone = parseTimezone(
    parseJson(input.timezone, "timezone", diagnostics),
    input.daysPerYear,
    diagnostics,
  );
  if (
    !safeInteger(input.lunarTzMinutes) ||
    input.lunarTzMinutes < -1_440 ||
    input.lunarTzMinutes > 1_440
  ) {
    diagnostics.push(
      diagnostic(
        "CALENDAR_INVALID_LUNAR_TIMEZONE",
        "Calendar lunar timezone offset is invalid",
        "lunarTzMinutes",
      ),
    );
  }

  if (diagnostics.length > 0) {
    return freezeDeep({ ok: false, diagnostics });
  }

  const draft = {
    schemaVersion: EXTRACTION_CALENDAR_SCHEMA_VERSION,
    calendarRef: EXTRACTION_CALENDAR_REF,
    version: input.version,
    startYear: input.startYear,
    daysPerYear: input.daysPerYear,
    months,
    seasons,
    eras,
    weekdayNames,
    weekdayStartIndex: input.weekdayStartIndex,
    leapRule,
    reform,
    timezone,
    lunarTzMinutes: input.lunarTzMinutes,
  } as const;
  const digest = await digestStableJson(draft);
  return { ok: true, snapshot: freezeDeep({ ...draft, digest }) };
}

/** Recompute the seal and strict shape before a persisted artifact is trusted. */
export async function verifyExtractionCalendarSnapshot(
  value: unknown,
): Promise<ExtractionCalendarSnapshotVerificationResult> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== EXTRACTION_CALENDAR_SCHEMA_VERSION ||
    value.calendarRef !== EXTRACTION_CALENDAR_REF ||
    typeof value.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest)
  ) {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_SNAPSHOT_INVALID",
          "Extraction Calendar Snapshot envelope is invalid",
        ),
      ],
    });
  }

  const claimedDigest = value.digest;
  const { digest: _claimedDigest, ...claimedDraft } = value;
  try {
    if ((await digestStableJson(claimedDraft)) !== claimedDigest) {
      return freezeDeep({
        ok: false,
        diagnostics: [
          diagnostic(
            "CALENDAR_SNAPSHOT_DIGEST_MISMATCH",
            "Extraction Calendar Snapshot content does not match its digest",
          ),
        ],
      });
    }
  } catch {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_SNAPSHOT_INVALID",
          "Extraction Calendar Snapshot cannot be sealed",
        ),
      ],
    });
  }

  if (
    !Array.isArray(value.months) ||
    !Array.isArray(value.seasons) ||
    !Array.isArray(value.eras) ||
    !Array.isArray(value.weekdayNames)
  ) {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_SNAPSHOT_INVALID",
          "Extraction Calendar Snapshot catalogs are invalid",
        ),
      ],
    });
  }

  let rebuilt: ExtractionCalendarSnapshotBuildResult;
  try {
    rebuilt = await buildExtractionCalendarSnapshot({
      version: value.version as number,
      startYear: value.startYear as number,
      daysPerYear: value.daysPerYear as number,
      months: JSON.stringify(
        value.months.map((item) =>
          isRecord(item) ? { name: item.name, days: item.days } : item,
        ),
      ),
      seasonBoundaries: JSON.stringify(
        value.seasons.map((item) =>
          isRecord(item)
            ? { name: item.name, startDayOfYear: item.startDayOfYear }
            : item,
        ),
      ),
      eras: JSON.stringify(
        value.eras.map((item) =>
          isRecord(item)
            ? { name: item.name, startYear: item.startYear }
            : item,
        ),
      ),
      weekdayNames: JSON.stringify(value.weekdayNames),
      weekdayStartIndex: value.weekdayStartIndex as number,
      leapRule: JSON.stringify(value.leapRule),
      reform: JSON.stringify(value.reform),
      timezone: JSON.stringify(value.timezone),
      lunarTzMinutes: value.lunarTzMinutes as number,
    });
  } catch {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_SNAPSHOT_INVALID",
          "Extraction Calendar Snapshot structure is invalid",
        ),
      ],
    });
  }
  if (!rebuilt.ok) return rebuilt;
  if (stableJsonStringify(value) !== stableJsonStringify(rebuilt.snapshot)) {
    return freezeDeep({
      ok: false,
      diagnostics: [
        diagnostic(
          "CALENDAR_SNAPSHOT_DIGEST_MISMATCH",
          "Extraction Calendar Snapshot is not in canonical sealed form",
        ),
      ],
    });
  }
  return rebuilt;
}
