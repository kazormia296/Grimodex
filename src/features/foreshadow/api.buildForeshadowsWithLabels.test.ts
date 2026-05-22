import { describe, expect, it } from "vitest";
import { buildForeshadowsWithLabels } from "./api";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";

function makeRow(overrides: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f-1",
    projectId: "proj-1",
    title: "白鯨の前兆",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: false,
    loadBearing: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeSetup(
  overrides: Partial<ForeshadowSetupRow> = {},
): Pick<
  ForeshadowSetupRow,
  "foreshadowId" | "isOrphan" | "strength" | "aiStrength" | "aiReasoning"
> {
  return {
    foreshadowId: "f-1",
    isOrphan: false,
    strength: null,
    aiStrength: null,
    aiReasoning: null,
    ...overrides,
  };
}

describe("buildForeshadowsWithLabels", () => {
  it("empty rows → empty result", () => {
    expect(buildForeshadowsWithLabels([], [])).toEqual([]);
  });

  it("row with no setups gets label=planned and setupCount=0", () => {
    const [item] = buildForeshadowsWithLabels([makeRow()], []);
    expect(item.label).toBe("planned");
    expect(item.setupCount).toBe(0);
  });

  it("non-orphan setup increments setupCount → label=seeded", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow()],
      [makeSetup({ isOrphan: false })],
    );
    expect(item.setupCount).toBe(1);
    expect(item.label).toBe("seeded");
  });

  it("orphan setup is NOT counted", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow()],
      [makeSetup({ isOrphan: true })],
    );
    expect(item.setupCount).toBe(0);
    expect(item.label).toBe("planned");
  });

  it("strength=subtle → label=needs_strengthening", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow()],
      [makeSetup({ isOrphan: false, strength: "subtle" })],
    );
    expect(item.label).toBe("needs_strengthening");
  });

  it("aiStrength=subtle → label=needs_strengthening", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow()],
      [makeSetup({ isOrphan: false, aiStrength: "subtle" })],
    );
    expect(item.label).toBe("needs_strengthening");
  });

  it("payoffConfirmed + setupCount>0 → label=paid", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow({ payoffConfirmed: true })],
      [makeSetup({ isOrphan: false })],
    );
    expect(item.label).toBe("paid");
  });

  it("payoffConfirmed + setupCount=0 → label=orphan_payoff", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow({ payoffConfirmed: true })],
      [],
    );
    expect(item.label).toBe("orphan_payoff");
  });

  it("abandoned=true → label=abandoned regardless of setups", () => {
    const [item] = buildForeshadowsWithLabels(
      [makeRow({ abandoned: true })],
      [makeSetup({ isOrphan: false })],
    );
    expect(item.label).toBe("abandoned");
  });

  it("multiple rows get independent labels", () => {
    const items = buildForeshadowsWithLabels(
      [makeRow({ id: "f-1" }), makeRow({ id: "f-2", payoffConfirmed: true })],
      [makeSetup({ foreshadowId: "f-1", isOrphan: false })],
    );
    expect(items.find((i) => i.id === "f-1")?.label).toBe("seeded");
    expect(items.find((i) => i.id === "f-2")?.label).toBe("orphan_payoff");
  });
});
