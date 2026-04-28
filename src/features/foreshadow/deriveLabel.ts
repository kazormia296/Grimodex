import type { DerivedLabel, ForeshadowRow } from "./types";

export function deriveLabel(
  f: ForeshadowRow,
  setupCount: number,
  anyWeak: boolean,
): DerivedLabel {
  if (f.abandoned) return "abandoned";
  if (setupCount === 0 && f.payoffConfirmed) return "orphan_payoff";
  if (setupCount === 0) return "planned";
  if (f.payoffConfirmed) return "paid";
  if (anyWeak) {
    if (f.loadBearing === "critical") return "critical_weak";
    if (f.loadBearing === "optional") return "seeded";
    return "needs_strengthening"; // null / supporting → 既存挙動維持（案①）
  }
  return "seeded";
}
