/**
 * Dependency が破れたときの再評価方針。
 * AI 再抽出と決定的再検証を区別する。
 */
export type NarrativeInvalidationPolicy =
  | "revalidate-exact"
  | "reanchor-candidate"
  | "rerun-local"
  | "rerun-cluster"
  | "rerun-corpus"
  | "resolve-only"
  | "recompile-only"
  | "repreview-only"
  | "refresh-available"
  | "manual";

const INVALIDATION_POLICY_SEVERITY: Record<NarrativeInvalidationPolicy, number> =
  {
    "revalidate-exact": 1,
    "reanchor-candidate": 2,
    "repreview-only": 2,
    "resolve-only": 3,
    "recompile-only": 3,
    "refresh-available": 3,
    "rerun-local": 4,
    "rerun-cluster": 5,
    "rerun-corpus": 6,
    manual: 7,
  };

/** Pick the most disruptive of several policies affecting the same consumer. */
export function mostSevereInvalidationPolicy(
  policies: readonly NarrativeInvalidationPolicy[],
): NarrativeInvalidationPolicy | null {
  let winner: NarrativeInvalidationPolicy | null = null;
  for (const policy of policies) {
    if (
      !winner ||
      INVALIDATION_POLICY_SEVERITY[policy] >
        INVALIDATION_POLICY_SEVERITY[winner]
    ) {
      winner = policy;
    }
  }
  return winner;
}
