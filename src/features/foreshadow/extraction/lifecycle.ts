import type {
  DerivedLabel,
  ForeshadowLoadBearing,
  ForeshadowRow,
} from "../types";

/**
 * Lifecycle axis (new extraction pipeline). Separated from legacy `deriveLabel`
 * so setup/payoff quality can evolve without breaking existing UI labels.
 */
export type ForeshadowLifecycle =
  | "planned"
  | "seeded"
  | "paid"
  | "orphan-payoff"
  | "abandoned";

export type ForeshadowQualityIssue =
  | "too-subtle"
  | "needs-strengthening"
  | "none";

export interface ForeshadowLifecycleInput {
  readonly abandoned: boolean;
  readonly setupCount: number;
  readonly payoffConfirmed: boolean;
}

export interface ForeshadowQualityInput {
  readonly anyWeak: boolean;
  readonly loadBearing: ForeshadowLoadBearing | null;
  readonly lifecycle: ForeshadowLifecycle;
}

export interface ForeshadowQualityResult {
  readonly qualityIssue: ForeshadowQualityIssue;
  readonly notes: string | null;
}

/** Derive coarse lifecycle from setup/payoff counts (no strength axis). */
export function deriveForeshadowLifecycle(
  input: ForeshadowLifecycleInput,
): ForeshadowLifecycle {
  if (input.abandoned) return "abandoned";
  if (input.setupCount === 0 && input.payoffConfirmed) return "orphan-payoff";
  if (input.setupCount === 0) return "planned";
  if (input.payoffConfirmed) return "paid";
  return "seeded";
}

/**
 * Derive quality issue from strength / load-bearing. Maps to legacy labels:
 * - critical_weak ≈ lifecycle seeded + qualityIssue too-subtle + loadBearing critical
 * - needs_strengthening ≈ seeded + needs-strengthening + loadBearing null/supporting
 * - optional × weak → seeded + none (no warning)
 */
export function deriveForeshadowQuality(
  input: ForeshadowQualityInput,
): ForeshadowQualityResult {
  if (
    !input.anyWeak ||
    input.lifecycle === "paid" ||
    input.lifecycle === "abandoned"
  ) {
    return { qualityIssue: "none", notes: null };
  }
  if (input.loadBearing === "critical") {
    return {
      qualityIssue: "too-subtle",
      notes: "critical load-bearing setup reads too subtle for payoff weight",
    };
  }
  if (input.loadBearing === "optional") {
    return { qualityIssue: "none", notes: null };
  }
  return {
    qualityIssue: "needs-strengthening",
    notes: "setup strength should be raised before payoff",
  };
}

/** Bridge new lifecycle+quality back to legacy DerivedLabel for existing UI. */
export function deriveLabelFromLifecycle(
  lifecycle: ForeshadowLifecycle,
  quality: ForeshadowQualityResult,
  loadBearing: ForeshadowLoadBearing | null,
): DerivedLabel {
  if (lifecycle === "abandoned") return "abandoned";
  if (lifecycle === "orphan-payoff") return "orphan_payoff";
  if (lifecycle === "planned") return "planned";
  if (lifecycle === "paid") return "paid";
  if (quality.qualityIssue === "too-subtle" && loadBearing === "critical") {
    return "critical_weak";
  }
  if (quality.qualityIssue === "needs-strengthening") {
    return "needs_strengthening";
  }
  return "seeded";
}

/** Convenience: derive lifecycle+quality from a ForeshadowRow snapshot. */
export function deriveForeshadowState(
  row: ForeshadowRow,
  setupCount: number,
  anyWeak: boolean,
): {
  lifecycle: ForeshadowLifecycle;
  quality: ForeshadowQualityResult;
  label: DerivedLabel;
} {
  const lifecycle = deriveForeshadowLifecycle({
    abandoned: row.abandoned,
    setupCount,
    payoffConfirmed: row.payoffConfirmed,
  });
  const quality = deriveForeshadowQuality({
    anyWeak,
    loadBearing: row.loadBearing,
    lifecycle,
  });
  const label = deriveLabelFromLifecycle(lifecycle, quality, row.loadBearing);
  return { lifecycle, quality, label };
}

/** Re-export compatibility: legacy deriveLabel remains canonical in deriveLabel.ts */
export { deriveLabel } from "../deriveLabel";
