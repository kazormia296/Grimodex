import { describe, expect, it } from "vitest";
import type { MaintenanceHealthSummary } from "@/application/narrative-extraction/nativeApi";
import {
  isNothingToInspect,
  STALE_BREAKDOWN_KEYS,
} from "./structureHealthModel";

const EMPTY: MaintenanceHealthSummary = {
  proposalsChecked: 0,
  proposalsStale: 0,
  staleBreakdown: {
    stale: 0,
    "source-missing": 0,
    "anchor-mismatch": 0,
    "read-set-drift": 0,
    unknown: 0,
  },
  maintenanceStopped: 0,
  unrecognized: 0,
};

describe("isNothingToInspect", () => {
  it("is true only when nothing at all was counted", () => {
    expect(isNothingToInspect(EMPTY)).toBe(true);
    expect(isNothingToInspect({ ...EMPTY, proposalsChecked: 1 })).toBe(false);
    expect(isNothingToInspect({ ...EMPTY, maintenanceStopped: 1 })).toBe(false);
    // Unreadable rows must never read as "nothing to check".
    expect(isNothingToInspect({ ...EMPTY, unrecognized: 1 })).toBe(false);
  });

  it("lists every stale kind the read returns", () => {
    expect([...STALE_BREAKDOWN_KEYS].sort()).toEqual(
      Object.keys(EMPTY.staleBreakdown).sort(),
    );
  });
});
