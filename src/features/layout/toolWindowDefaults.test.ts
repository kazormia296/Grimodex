import { describe, it, expect } from "vitest";
import {
  DEFAULT_INDEX_MAP,
  DEFAULT_REGION_MAP,
  DEFAULT_SLOT_MAP,
  SLOT_TO_INDEX,
  SLOT_TO_REGION,
  getEffectiveIndexInRegion,
  getStripeRegion,
  migrateToolWindowState,
  migrateToolWindowsRecord,
} from "./toolWindowDefaults";

describe("toolWindowDefaults derived maps", () => {
  it("DEFAULT_REGION_MAP matches SLOT_TO_REGION applied to DEFAULT_SLOT_MAP", () => {
    for (const [id, slot] of Object.entries(DEFAULT_SLOT_MAP)) {
      expect(DEFAULT_REGION_MAP[id as keyof typeof DEFAULT_REGION_MAP]).toBe(
        SLOT_TO_REGION[slot],
      );
    }
  });

  it("DEFAULT_INDEX_MAP matches SLOT_TO_INDEX applied to DEFAULT_SLOT_MAP", () => {
    for (const [id, slot] of Object.entries(DEFAULT_SLOT_MAP)) {
      expect(DEFAULT_INDEX_MAP[id as keyof typeof DEFAULT_INDEX_MAP]).toBe(
        SLOT_TO_INDEX[slot],
      );
    }
  });

  it("SLOT_TO_INDEX assigns 0 to top/left slots and 1 to bottom/right", () => {
    expect(SLOT_TO_INDEX.LT).toBe(0);
    expect(SLOT_TO_INDEX.RT).toBe(0);
    expect(SLOT_TO_INDEX.BL).toBe(0);
    expect(SLOT_TO_INDEX.LB).toBe(1);
    expect(SLOT_TO_INDEX.RB).toBe(1);
    expect(SLOT_TO_INDEX.BR).toBe(1);
  });
});

describe("migrateToolWindowState", () => {
  it("populates region+indexInRegion from slot for old format", () => {
    const result = migrateToolWindowState("scenes", {
      slot: "LT",
      viewMode: "docked-pinned",
    });
    expect(result).toEqual({
      slot: "LT",
      region: "left",
      groupRef: undefined,
      indexInRegion: 0,
      viewMode: "docked-pinned",
      undockSize: undefined,
    });
  });

  it("derives region 'left' and index 1 from LB", () => {
    const result = migrateToolWindowState("codex", {
      slot: "LB",
      viewMode: "docked-pinned",
    });
    expect(result.region).toBe("left");
    expect(result.indexInRegion).toBe(1);
  });

  it("derives region 'bottom' and index 0 from BL", () => {
    const result = migrateToolWindowState("timeline", {
      slot: "BL",
      viewMode: "docked-pinned",
    });
    expect(result.region).toBe("bottom");
    expect(result.indexInRegion).toBe(0);
  });

  it("preserves existing region/indexInRegion when already new format", () => {
    const result = migrateToolWindowState("scenes", {
      slot: "LT",
      region: "right",
      indexInRegion: 5,
      groupRef: "group-xyz",
      viewMode: "docked-pinned",
    });
    expect(result.region).toBe("right");
    expect(result.indexInRegion).toBe(5);
    expect(result.groupRef).toBe("group-xyz");
  });

  it("uses DEFAULT_SLOT_MAP when raw is undefined", () => {
    const result = migrateToolWindowState("scenes", undefined);
    expect(result.slot).toBe(DEFAULT_SLOT_MAP.scenes);
    expect(result.region).toBe(DEFAULT_REGION_MAP.scenes);
    expect(result.indexInRegion).toBe(DEFAULT_INDEX_MAP.scenes);
  });

  it("preserves undockSize", () => {
    const result = migrateToolWindowState("scenes", {
      slot: "LT",
      viewMode: "docked-pinned",
      undockSize: { width: 400, height: 300 },
    });
    expect(result.undockSize).toEqual({ width: 400, height: 300 });
  });
});

describe("migrateToolWindowsRecord", () => {
  it("returns empty object when input is undefined", () => {
    expect(migrateToolWindowsRecord(undefined)).toEqual({});
  });

  it("migrates each entry and skips editor", () => {
    const result = migrateToolWindowsRecord({
      scenes: { slot: "LT", viewMode: "docked-pinned" },
      codex: { slot: "LB", viewMode: "docked-unpinned" },
      editor: { slot: "LT", viewMode: "docked-pinned" } as never,
    });
    expect(result.scenes).toMatchObject({
      slot: "LT",
      region: "left",
      indexInRegion: 0,
    });
    expect(result.codex).toMatchObject({
      slot: "LB",
      region: "left",
      indexInRegion: 1,
      viewMode: "docked-unpinned",
    });
    expect((result as Record<string, unknown>).editor).toBeUndefined();
  });
});

describe("getStripeRegion / getEffectiveIndexInRegion read precedence", () => {
  it("getStripeRegion prefers override.region over override.slot derivation", () => {
    expect(
      getStripeRegion("scenes", {
        slot: "LT",
        region: "bottom",
        viewMode: "docked-pinned",
      }),
    ).toBe("bottom");
  });

  it("getStripeRegion falls back to override.slot when region missing", () => {
    expect(
      getStripeRegion("scenes", {
        slot: "RB",
        viewMode: "docked-pinned",
      }),
    ).toBe("right");
  });

  it("getStripeRegion falls back to DEFAULT_REGION_MAP when override is undefined", () => {
    expect(getStripeRegion("scenes")).toBe(DEFAULT_REGION_MAP.scenes);
  });

  it("getEffectiveIndexInRegion prefers indexInRegion field", () => {
    expect(
      getEffectiveIndexInRegion("scenes", {
        slot: "LT",
        indexInRegion: 7,
        viewMode: "docked-pinned",
      }),
    ).toBe(7);
  });

  it("getEffectiveIndexInRegion falls back to slot derivation", () => {
    expect(
      getEffectiveIndexInRegion("codex", {
        slot: "LB",
        viewMode: "docked-pinned",
      }),
    ).toBe(1);
  });
});
