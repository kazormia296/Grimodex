import { describe, expect, it } from "vitest";
import {
  evaluateForeshadowGate,
  isMaterialPayoffSignal,
  isMaterialSetupSignal,
  meetsNewForeshadowMinimum,
} from "./foreshadowGates";

describe("foreshadowGates", () => {
  it("rejects person recurrence as mere repetition", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "minor",
        setupKind: "character-trait",
        isMereRepetition: true,
      }),
    ).toEqual({ admit: false, reason: "mere-repetition" });
  });

  it("rejects object background callback as callback-only", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "minor",
        setupKind: "object-plant",
        isCallbackOnly: true,
      }),
    ).toEqual({ admit: false, reason: "callback-only" });
  });

  it("rejects rain motif as decorative atmospheric motif", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "minor",
        setupKind: "atmospheric-motif",
        bridgeKind: "motif-resolution",
        isDecorative: true,
      }),
    ).toEqual({ admit: false, reason: "decorative" });
  });

  it("admits causal-seed but rejects generic causality without seed kind", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "moderate",
        setupKind: "causal-seed",
        isGenericCausality: true,
      }),
    ).toEqual({ admit: true });

    expect(
      evaluateForeshadowGate({
        materiality: "moderate",
        setupKind: "other",
        isGenericCausality: true,
      }),
    ).toEqual({ admit: false, reason: "generic-causality" });
  });

  it("rejects retrospective payoff framing", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "major",
        setupKind: "causal-seed",
        payoffKind: "causal-unlock",
        isRetrospective: true,
      }),
    ).toEqual({ admit: false, reason: "retrospective" });
  });

  it("rejects payoff before setup in reading order", () => {
    expect(
      evaluateForeshadowGate({
        materiality: "moderate",
        setupKind: "object-plant",
        payoffKind: "object-return",
        setupReadingOrder: 12,
        payoffReadingOrder: 4,
      }),
    ).toEqual({
      admit: false,
      reason: "reading-order-setup-before-payoff",
    });
  });

  it("treats minor atmospheric motif as non-material setup", () => {
    expect(
      isMaterialSetupSignal({
        materiality: "minor",
        signalKind: "atmospheric-motif",
      }),
    ).toBe(false);
  });

  it("rejects callback-only payoff even when materiality is moderate", () => {
    expect(
      isMaterialPayoffSignal({
        materiality: "moderate",
        isCallbackOnly: true,
      }),
    ).toBe(false);
  });

  it("requires two scenes for new foreshadow thread minimum", () => {
    expect(
      meetsNewForeshadowMinimum({
        setupSignalCount: 1,
        payoffSignalCount: 1,
        distinctSceneCount: 1,
        edgeCount: 1,
        hasCoreConcern: true,
      }),
    ).toBe(false);

    expect(
      meetsNewForeshadowMinimum({
        setupSignalCount: 1,
        payoffSignalCount: 1,
        distinctSceneCount: 2,
        edgeCount: 1,
        hasCoreConcern: true,
      }),
    ).toBe(true);
  });
});
