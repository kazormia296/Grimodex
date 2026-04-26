import { describe, it, expect } from "vitest";
import { deriveLabel } from "./deriveLabel";
import type { ForeshadowRow } from "./types";

function makeForeshadow(overrides: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f1",
    projectId: "p1",
    title: "test",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("deriveLabel", () => {
  it("returns 'abandoned' when abandoned is true (takes priority)", () => {
    const f = makeForeshadow({ abandoned: true, payoffConfirmed: true });
    expect(deriveLabel(f, 5, false)).toBe("abandoned");
  });

  it("returns 'orphan_payoff' when payoffConfirmed but no setups", () => {
    const f = makeForeshadow({ payoffConfirmed: true });
    expect(deriveLabel(f, 0, false)).toBe("orphan_payoff");
  });

  it("returns 'planned' when no setups and not confirmed", () => {
    const f = makeForeshadow();
    expect(deriveLabel(f, 0, false)).toBe("planned");
  });

  it("returns 'paid' when payoffConfirmed with setups", () => {
    const f = makeForeshadow({ payoffConfirmed: true });
    expect(deriveLabel(f, 2, false)).toBe("paid");
  });

  it("returns 'needs_strengthening' when anyWeak is true", () => {
    const f = makeForeshadow();
    expect(deriveLabel(f, 1, true)).toBe("needs_strengthening");
  });

  it("returns 'seeded' when has setups, not confirmed, not weak", () => {
    const f = makeForeshadow();
    expect(deriveLabel(f, 3, false)).toBe("seeded");
  });

  it("abandoned takes priority over orphan_payoff", () => {
    const f = makeForeshadow({ abandoned: true, payoffConfirmed: true });
    expect(deriveLabel(f, 0, false)).toBe("abandoned");
  });

  it("paid takes priority over needs_strengthening (payoffConfirmed)", () => {
    const f = makeForeshadow({ payoffConfirmed: true });
    expect(deriveLabel(f, 1, true)).toBe("paid");
  });
});
