// Disclosure statistics shared by the CP-4 summaries. Pure; never a
// threshold.

/** Nearest-rank percentile (the P harness's `nearestRank`). */
export function nearestRank(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

export function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return {
    n: finite.length,
    p50: nearestRank(finite, 0.5),
    p90: nearestRank(finite, 0.9),
    p99: nearestRank(finite, 0.99),
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
  };
}
