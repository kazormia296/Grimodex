import { describe, expect, it } from "vitest";
import {
  buildExtractionCalendarSnapshot,
  type ExtractionCalendarSnapshotInput,
  verifyExtractionCalendarSnapshot,
} from "./extractionCalendarSnapshot";

function input(
  overrides: Partial<ExtractionCalendarSnapshotInput> = {},
): ExtractionCalendarSnapshotInput {
  return {
    version: 4,
    startYear: 100,
    daysPerYear: 360,
    months: JSON.stringify([
      { name: "First", days: 180 },
      { name: "Second", days: 180 },
    ]),
    seasonBoundaries: JSON.stringify([
      { name: "Light", startDayOfYear: 0 },
      { name: "Dark", startDayOfYear: 180 },
    ]),
    eras: JSON.stringify([{ name: "Republic", startYear: 100 }]),
    weekdayNames: JSON.stringify(["One", "Two", "Three"]),
    weekdayStartIndex: 1,
    leapRule: JSON.stringify({ kind: "none" }),
    reform: "null",
    timezone: JSON.stringify({ label: "RST", offsetMinutes: 60 }),
    lunarTzMinutes: 480,
    ...overrides,
  };
}

describe("buildExtractionCalendarSnapshot", () => {
  it("strictly parses a calendar into opaque, immutable artifact-local refs", async () => {
    const result = await buildExtractionCalendarSnapshot(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        calendarRef: "CAL001",
        version: 4,
        startYear: 100,
        daysPerYear: 360,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    );
    expect(result.snapshot.months.map((month) => month.ref)).toEqual([
      "M000001",
      "M000002",
    ]);
    expect(result.snapshot.seasons.map((season) => season.ref)).toEqual([
      "S000001",
      "S000002",
    ]);
    expect(result.snapshot.eras.map((era) => era.ref)).toEqual(["E000001"]);
    expect(JSON.stringify(result.snapshot)).not.toContain("project-");
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.months)).toBe(true);
    expect(Object.isFrozen(result.snapshot.months[0])).toBe(true);
  });

  it("seals semantic JSON rather than raw whitespace or property order", async () => {
    const first = await buildExtractionCalendarSnapshot(input());
    const reordered = await buildExtractionCalendarSnapshot(
      input({
        months:
          '[ { "days": 180, "name": "First" }, {"days":180,"name":"Second"} ]',
      }),
    );

    expect(first.ok && reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(reordered.snapshot.digest).toBe(first.snapshot.digest);
  });

  it("includes version and normalized calendar semantics in the digest", async () => {
    const first = await buildExtractionCalendarSnapshot(input());
    const nextVersion = await buildExtractionCalendarSnapshot(
      input({ version: 5 }),
    );
    const changed = await buildExtractionCalendarSnapshot(
      input({ weekdayStartIndex: 2 }),
    );

    expect(first.ok && nextVersion.ok && changed.ok).toBe(true);
    if (!first.ok || !nextVersion.ok || !changed.ok) return;
    expect(nextVersion.snapshot.digest).not.toBe(first.snapshot.digest);
    expect(changed.snapshot.digest).not.toBe(first.snapshot.digest);
  });

  it.each([
    ["malformed JSON", { months: "{not-json" }, "CALENDAR_INVALID_JSON"],
    [
      "invalid month length",
      { months: JSON.stringify([{ name: "Broken", days: 0 }]) },
      "CALENDAR_INVALID_MONTH",
    ],
    [
      "blank month label",
      { months: JSON.stringify([{ name: "   ", days: 360 }]) },
      "CALENDAR_INVALID_MONTH",
    ],
    [
      "inconsistent year length",
      { daysPerYear: 361 },
      "CALENDAR_YEAR_LENGTH_MISMATCH",
    ],
    [
      "invalid season boundary",
      {
        seasonBoundaries: JSON.stringify([
          { name: "Beyond", startDayOfYear: 360 },
        ]),
      },
      "CALENDAR_INVALID_SEASON",
    ],
    [
      "invalid weekday index",
      { weekdayStartIndex: 3 },
      "CALENDAR_INVALID_WEEKDAY_INDEX",
    ],
    ["negative version", { version: -1 }, "CALENDAR_INVALID_VERSION"],
    [
      "out-of-range timezone",
      {
        timezone: JSON.stringify({
          label: "Impossible",
          offsetMinutes: 1_441,
        }),
      },
      "CALENDAR_INVALID_TIMEZONE",
    ],
    [
      "out-of-range DST timezone",
      {
        timezone: JSON.stringify({
          label: "Base",
          offsetMinutes: 0,
          dst: {
            label: "Impossible DST",
            offsetMinutes: -1_441,
            startDayOfYear: 0,
            endDayOfYear: 100,
          },
        }),
      },
      "CALENDAR_INVALID_TIMEZONE",
    ],
  ] as const)("fails closed for %s", async (_name, overrides, code) => {
    const result = await buildExtractionCalendarSnapshot(input(overrides));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

  it("copies input before digesting so caller mutation cannot alter the artifact", async () => {
    const mutable = input();
    const pending = buildExtractionCalendarSnapshot(mutable);
    (mutable as { months: string }).months = "[]";
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.months).toHaveLength(2);
  });

  it("verifies a sealed snapshot and rejects nested data changed under its old digest", async () => {
    const result = await buildExtractionCalendarSnapshot(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verified = await verifyExtractionCalendarSnapshot(result.snapshot);
    const tampered = structuredClone(result.snapshot) as unknown as {
      months: Array<{ ref: string; name: string; days: number }>;
    };
    tampered.months[0]!.days = 179;
    const rejected = await verifyExtractionCalendarSnapshot(tampered);

    expect(verified.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CALENDAR_SNAPSHOT_DIGEST_MISMATCH" }),
      ]),
    );
  });

  it("returns typed diagnostics for a malformed top-level builder input", async () => {
    const result = await buildExtractionCalendarSnapshot(
      null as unknown as ExtractionCalendarSnapshotInput,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CALENDAR_INVALID_INPUT" }),
      ]),
    );
  });
});
