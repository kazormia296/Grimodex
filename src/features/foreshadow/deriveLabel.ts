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
  if (anyWeak) return "needs_strengthening";
  return "seeded";
}
