// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { debugLog } from "@/lib/debugLog";

// `loadTreeNodeRestoreSnapshot` sends the date range only in the shape Main and
// Native accept (safe integers, known words). A legacy row can hold a REAL day
// or minute (tree_node_patch writes the columns unchecked), which the browser
// mock's writer will not make, so the row is supplied here.

const state = vi.hoisted(() => ({ row: {} as Record<string, unknown> }));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => Promise.resolve([state.row]) }),
    }),
  },
}));

import { loadTreeNodeRestoreSnapshot } from "./api";

const base = {
  content: "{}",
  sourceUri: null,
  sourceMtime: null,
  intent: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  contextMode: null,
  aliases: "[]",
  excludedAliases: "[]",
  unplacedBeatsDoc: "[]",
  unplacedBeatPreview: null,
  placedBeatPreview: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  chronicleStartTime: null,
  chronicleStartMinute: null,
  chronicleStartGranularity: "none",
  chronicleEndTime: null,
  chronicleEndMinute: null,
  chronicleEndGranularity: "none",
  chroniclePrecision: "exact",
};

const chronicleKeys = (restoreState: object): string[] =>
  Object.keys(restoreState).filter((key) => key.startsWith("chronicle"));

describe("loadTreeNodeRestoreSnapshot date range shape", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "a non-integer minute",
      {
        chronicleStartMinute: 30.5,
        chronicleStartTime: 5,
        chronicleStartGranularity: "time",
      },
    ],
    [
      "a non-integer day",
      { chronicleEndTime: 1.25, chronicleEndGranularity: "day" },
    ],
    [
      "an unsafe integer",
      { chronicleStartTime: 2 ** 60, chronicleStartGranularity: "day" },
    ],
    [
      "a text day",
      { chronicleStartTime: "5", chronicleStartGranularity: "day" },
    ],
    [
      "an unknown granularity",
      { chronicleStartTime: 5, chronicleStartGranularity: "century" },
    ],
    [
      "an unknown precision",
      {
        chronicleStartTime: 5,
        chronicleStartGranularity: "day",
        chroniclePrecision: "roughly",
      },
    ],
  ])(
    "%s: the date alone is left out and it is logged",
    async (_label, range) => {
      const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
      state.row = { ...base, intent: "goal", ...range };
      const snapshot = (await loadTreeNodeRestoreSnapshot("node-1"))!;
      expect(chronicleKeys(snapshot.restoreState)).toEqual([]);
      // the rest of the row is still restored
      expect(snapshot.restoreState.intent).toBe("goal");
      expect(warn).toHaveBeenCalledWith(
        "tree",
        "undo date range not restorable",
        expect.stringContaining("node-1"),
      );
    },
  );

  it("an inconsistent but well-shaped range is sent as it is, without a warning", async () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    state.row = {
      ...base,
      chronicleStartTime: 10,
      chronicleStartGranularity: "day",
      chronicleEndTime: 9,
      chronicleEndGranularity: "day",
    };
    const snapshot = (await loadTreeNodeRestoreSnapshot("node-1"))!;
    expect(snapshot.restoreState).toMatchObject({
      chronicleStartTime: 10,
      chronicleEndTime: 9,
      chronicleStartGranularity: "day",
      chronicleEndGranularity: "day",
      chroniclePrecision: "exact",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("the default range sends no date key", async () => {
    state.row = { ...base };
    const snapshot = (await loadTreeNodeRestoreSnapshot("node-1"))!;
    expect(chronicleKeys(snapshot.restoreState)).toEqual([]);
  });
});
