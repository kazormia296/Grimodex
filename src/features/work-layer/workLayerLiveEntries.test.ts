import { describe, expect, it } from "vitest";

import type { WorkLayerLiveEntry, WorkLayerModel } from "./types";
import {
  isValidWorkLayerLiveEntry,
  selectAttentionCount,
} from "./workLayerLiveEntries";

const entry = (
  id: WorkLayerLiveEntry["id"],
  status: WorkLayerLiveEntry["status"],
  count: WorkLayerLiveEntry["count"],
): WorkLayerLiveEntry => ({ id, status, count });

function model(liveEntries?: readonly WorkLayerLiveEntry[]): WorkLayerModel {
  return {
    scopeId: "example-work",
    focus: null,
    attention: [
      { id: "example-1" },
      { id: "example-2" },
    ] as unknown as WorkLayerModel["attention"],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
    ...(liveEntries === undefined ? {} : { liveEntries }),
  };
}

describe("workLayerLiveEntries", () => {
  it("uses preview attention length", () => {
    expect(selectAttentionCount(model())).toEqual({ total: 2, complete: true });
  });

  it("sums ready rows and marks non-ready statuses incomplete", () => {
    expect(
      selectAttentionCount(
        model([
          entry("codex-candidates", "ready", 3),
          entry("stale-proposals", "ready", 0),
        ]),
      ),
    ).toEqual({ total: 3, complete: true });
    expect(
      selectAttentionCount(
        model([
          entry("codex-candidates", "ready", 3),
          entry("stale-proposals", "not-counted", null),
        ]),
      ),
    ).toEqual({ total: 3, complete: false });
    expect(
      selectAttentionCount(
        model([entry("codex-candidates", "unavailable", null)]),
      ),
    ).toEqual({ total: 0, complete: false });
  });

  it("validates the status and count combinations", () => {
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "ready", 0)),
    ).toBe(true);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "ready", -1)),
    ).toBe(false);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "ready", null)),
    ).toBe(false);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "ready", 1.5)),
    ).toBe(false);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "not-counted", null)),
    ).toBe(true);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "unavailable", null)),
    ).toBe(true);
    expect(
      isValidWorkLayerLiveEntry(entry("codex-candidates", "not-counted", 1)),
    ).toBe(false);
  });

  it("excludes invalid rows and repeated ids from the total", () => {
    expect(
      selectAttentionCount(
        model([
          entry("codex-candidates", "ready", 2),
          entry("codex-candidates", "ready", 99),
          entry("stale-proposals", "ready", -1),
        ]),
      ),
    ).toEqual({ total: 2, complete: false });
  });

  it("treats an empty live list as a complete zero", () => {
    expect(selectAttentionCount(model([]))).toEqual({
      total: 0,
      complete: true,
    });
  });
});
