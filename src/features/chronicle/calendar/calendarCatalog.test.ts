import { describe, expect, it } from "vitest";
import { createCalendarCatalog } from "./calendarCatalog";
import { buildExtractionCalendarSnapshot } from "./extractionCalendarSnapshot";

describe("createCalendarCatalog", () => {
  it("resolves only exact opaque refs and never falls back", async () => {
    const result = await buildExtractionCalendarSnapshot({
      version: 0,
      startYear: 0,
      daysPerYear: 10,
      months: JSON.stringify([{ name: "Only", days: 10 }]),
      seasonBoundaries: JSON.stringify([
        { name: "Opening", startDayOfYear: 0 },
      ]),
      eras: JSON.stringify([{ name: "First", startYear: 0 }]),
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: JSON.stringify({ kind: "none" }),
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 480,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const catalog = await createCalendarCatalog(result.snapshot);
    expect(catalog.resolveMonth("M000001")?.name).toBe("Only");
    expect(catalog.resolveSeason("S000001")?.name).toBe("Opening");
    expect(catalog.resolveEra("E000001")?.name).toBe("First");
    expect(catalog.resolveMonth("Only")).toBeNull();
    expect(catalog.resolveMonth("M999999")).toBeNull();
    expect(catalog.resolveMonth("")).toBeNull();
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("rejects a Calendar Snapshot whose content no longer matches its seal", async () => {
    const result = await buildExtractionCalendarSnapshot({
      version: 0,
      startYear: 0,
      daysPerYear: 10,
      months: JSON.stringify([{ name: "Only", days: 10 }]),
      seasonBoundaries: "[]",
      eras: "[]",
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: JSON.stringify({ kind: "none" }),
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 480,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tampered = structuredClone(result.snapshot) as unknown as {
      months: Array<{ ref: string; name: string; days: number }>;
    };
    tampered.months[0]!.name = "Changed";

    await expect(createCalendarCatalog(tampered)).rejects.toThrow(
      "Invalid Extraction Calendar Snapshot",
    );
  });
});
