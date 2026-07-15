import { describe, expect, it } from "vitest";
import {
  canonicalInstantString,
  instantEpochMilliseconds,
  plainDateAtEpochMilliseconds,
  plainDateFromKey,
} from "./time";

describe("time boundary", () => {
  it("normalizes RFC 3339 offsets to a millisecond UTC string", () => {
    expect(canonicalInstantString("2026-07-15T21:34:56.789+09:00")).toBe(
      "2026-07-15T12:34:56.789Z",
    );
  });

  it("treats the legacy SQLite datetime format as UTC", () => {
    expect(instantEpochMilliseconds("2026-07-15 12:34:56")).toBe(
      Date.UTC(2026, 6, 15, 12, 34, 56),
    );
    expect(canonicalInstantString("2026-07-15 12:34:56")).toBe(
      "2026-07-15T12:34:56.000Z",
    );
  });

  it("returns null instead of accepting invalid instants", () => {
    expect(instantEpochMilliseconds("not-a-date")).toBeNull();
    expect(canonicalInstantString("")).toBeNull();
  });

  it("parses strict ISO date keys without rollover", () => {
    expect(plainDateFromKey("2024-02-29")?.toString()).toBe("2024-02-29");
    expect(plainDateFromKey("2026-02-30")).toBeNull();
    expect(plainDateFromKey("2026-2-3")).toBeNull();
  });

  it("derives a local calendar date in an explicit time zone", () => {
    const instant = Date.UTC(2026, 6, 15, 15, 30);
    expect(plainDateAtEpochMilliseconds(instant, "UTC").toString()).toBe(
      "2026-07-15",
    );
    expect(
      plainDateAtEpochMilliseconds(instant, "Asia/Tokyo").toString(),
    ).toBe("2026-07-16");
  });
});
