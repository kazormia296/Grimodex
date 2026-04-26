import { describe, it, expect } from "vitest";
import { isSetupEvaluationStale } from "./staleness";
import type { ForeshadowSetupRow } from "./types";

function makeSetup(
  overrides: Partial<ForeshadowSetupRow> = {},
): ForeshadowSetupRow {
  return {
    id: "s1",
    foreshadowId: "f1",
    sceneId: "scene1",
    fromPos: 0,
    toPos: 10,
    kind: "designated_existing",
    strength: null,
    aiStrength: null,
    aiReasoning: null,
    attribution: "human",
    aiRationale: null,
    lastEvaluatedAt: null,
    isOrphan: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("isSetupEvaluationStale", () => {
  it("returns true when lastEvaluatedAt is null", () => {
    const setup = makeSetup({ lastEvaluatedAt: null });
    expect(isSetupEvaluationStale(setup, "2026-01-01T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("returns true when scene was updated after evaluation", () => {
    const setup = makeSetup({
      lastEvaluatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(isSetupEvaluationStale(setup, "2026-01-02T00:00:00.000Z")).toBe(
      true,
    );
  });

  it("returns false when scene was updated before evaluation", () => {
    const setup = makeSetup({
      lastEvaluatedAt: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(isSetupEvaluationStale(setup, "2026-01-01T00:00:00.000Z")).toBe(
      false,
    );
  });

  it("returns false when scene was updated at the same time as evaluation", () => {
    const ts = "2026-01-05T12:00:00.000Z";
    const setup = makeSetup({
      lastEvaluatedAt: new Date(ts),
    });
    expect(isSetupEvaluationStale(setup, ts)).toBe(false);
  });
});
