import { describe, expect, it } from "vitest";
import {
  deriveForeshadowLifecycle,
  deriveForeshadowQuality,
  deriveLabelFromLifecycle,
} from "./lifecycle";
import type { ForeshadowRow } from "../types";

function makeRow(overrides: Partial<ForeshadowRow> = {}): ForeshadowRow {
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
    secret: false,
    loadBearing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("foreshadow lifecycle", () => {
  it("maps abandoned before orphan payoff", () => {
    expect(
      deriveForeshadowLifecycle({
        abandoned: true,
        setupCount: 0,
        payoffConfirmed: true,
      }),
    ).toBe("abandoned");
  });

  it("derives orphan-payoff when payoff confirmed without setups", () => {
    expect(
      deriveForeshadowLifecycle({
        abandoned: false,
        setupCount: 0,
        payoffConfirmed: true,
      }),
    ).toBe("orphan-payoff");
  });

  it("maps critical weak via too-subtle quality", () => {
    const lifecycle = deriveForeshadowLifecycle({
      abandoned: false,
      setupCount: 2,
      payoffConfirmed: false,
    });
    const quality = deriveForeshadowQuality({
      anyWeak: true,
      loadBearing: "critical",
      lifecycle,
    });
    expect(quality.qualityIssue).toBe("too-subtle");
    expect(
      deriveLabelFromLifecycle(lifecycle, quality, "critical"),
    ).toBe("critical_weak");
  });

  it("maps optional weak to seeded without quality issue", () => {
    const lifecycle = deriveForeshadowLifecycle({
      abandoned: false,
      setupCount: 1,
      payoffConfirmed: false,
    });
    const quality = deriveForeshadowQuality({
      anyWeak: true,
      loadBearing: "optional",
      lifecycle,
    });
    expect(quality.qualityIssue).toBe("none");
    expect(
      deriveLabelFromLifecycle(lifecycle, quality, "optional"),
    ).toBe("seeded");
  });

  it("aligns deriveLabelFromLifecycle with legacy deriveLabel for paid", () => {
    const row = makeRow({ payoffConfirmed: true });
    const lifecycle = deriveForeshadowLifecycle({
      abandoned: row.abandoned,
      setupCount: 2,
      payoffConfirmed: row.payoffConfirmed,
    });
    const quality = deriveForeshadowQuality({
      anyWeak: true,
      loadBearing: row.loadBearing,
      lifecycle,
    });
    expect(deriveLabelFromLifecycle(lifecycle, quality, row.loadBearing)).toBe(
      "paid",
    );
  });
});
