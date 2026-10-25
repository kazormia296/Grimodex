// CP-4 Graph evaluation harness: frozen constants and the variant catalog.
//
// Pure module. It never runs Graph, IR, Raw, a model, Electron or Native.
// The values below are confirmed or frozen elsewhere and are only referenced
// here (K6/2 `graph-eval-procedure`, l6-l9:349-361, post-B:214, CP-0
// `evals/nir1-graph/`). No function in this harness accepts them as options.

/** D = min(100 ms, 0.20 * B), B = 54.2 ms. Confirmed; never recomputed. */
export const GRAPH_EVAL_D_MS = 10.84;
/** Graph result lease (separate from the P budget). */
export const GRAPH_RESULT_LEASE_MS = 100;
/** K6/2 option A yardstick (1%) as an exact integer ratio. */
export const AVAILABILITY_YARDSTICK = Object.freeze({
  numerator: 1,
  denominator: 100,
});
export const WARMUP_RUNS_PER_ARM = 5;
export const MEASURED_RUNS_PER_ARM = 30;
export const TRACE_MIN_QUERIES = 200;
/** D3 measurement-window sampling interval. */
export const WINDOW_SAMPLE_INTERVAL_MS = 20_000;

export const K62_FREEZE = Object.freeze({
  path: "docs/plans/nir1-final-request-eval-proposal-2-draft.md",
  commit: "af643a93eeae7f937c9cd5a9dd87a6308c96fab6",
  sha256: "4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8",
});
export const GRAPH_CASE_FREEZE_SHA256 =
  "6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7";
export const G01_FIXTURE_SHA256 =
  "996ef1c05b261a1d17618fea26342eb63418c050ae39246bb8b67c705ac84e79";

/** Arms of a G-case run; AB/BA alternates hybrid and graph (K6/2 step 2). */
export const GRAPH_CASE_ARMS = Object.freeze(["hybrid", "graph"]);
export const D2A_MODES = Object.freeze(["restricted", "unrestricted"]);

/**
 * The 13 measured variants (TASK §15.2): G-01 has one, G-02..G-08 have 12.
 * `expectedGraph` copies the frozen `expectations.graph.status`; variants
 * expected unavailable are measured for quality but never enter the (a)
 * denominator (K6/2 step 1). `declaration` marks the five K2/4 declaration
 * runs.
 */
export const GRAPH_EVAL_VARIANTS = Object.freeze(
  [
    ["G-01", "v1", "available", true, "evals/nir1-g01/fixture.v1.json"],
    [
      "G-02",
      "base",
      "available",
      true,
      "evals/nir1-graph/g02-directed-relation.v1.json",
    ],
    [
      "G-03",
      "base",
      "available",
      false,
      "evals/nir1-graph/g03-bounded-two-hop.v1.json",
    ],
    [
      "G-03",
      "frontier-exceeded",
      "unavailable",
      false,
      "evals/nir1-graph/g03-bounded-two-hop.v1.json",
    ],
    [
      "G-04",
      "base",
      "available",
      false,
      "evals/nir1-graph/g04-scope-exact-unknown.v1.json",
    ],
    [
      "G-05",
      "base",
      "available",
      false,
      "evals/nir1-graph/g05-current-revision-freshness.v1.json",
    ],
    [
      "G-06",
      "base",
      "available",
      false,
      "evals/nir1-graph/g06-evidence-anchor-path.v1.json",
    ],
    [
      "G-07",
      "base",
      "available",
      true,
      "evals/nir1-graph/g07-reading-before-reveal.v1.json",
    ],
    [
      "G-08",
      "base-usable",
      "available",
      true,
      "evals/nir1-graph/g08-graph-index-fallback.v1.json",
    ],
    [
      "G-08",
      "graph-index-unusable",
      "unavailable",
      false,
      "evals/nir1-graph/g08-graph-index-fallback.v1.json",
    ],
    [
      "G-08",
      "graph-recovered",
      "available",
      true,
      "evals/nir1-graph/g08-graph-index-fallback.v1.json",
    ],
    [
      "G-08",
      "chronicle-index-unusable",
      "unavailable",
      false,
      "evals/nir1-graph/g08-graph-index-fallback.v1.json",
    ],
    [
      "G-08",
      "both-indexes-unusable",
      "unavailable",
      false,
      "evals/nir1-graph/g08-graph-index-fallback.v1.json",
    ],
  ].map(([caseId, variantId, expectedGraph, declaration, fixturePath]) =>
    Object.freeze({
      key: `${caseId}/${variantId}`,
      caseId,
      variantId,
      expectedGraph,
      declaration,
      fixturePath,
    }),
  ),
);

export function variantByKey(key) {
  const variant = GRAPH_EVAL_VARIANTS.find((row) => row.key === key);
  if (!variant) throw new Error(`[precheck] unknown CP-4 variant ${key}`);
  return variant;
}

/** True when `numerator / denominator` is strictly above the 1% yardstick. */
export function exceedsYardstick(numerator, denominator) {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator))
    throw new Error("yardstick counts must be integers");
  if (numerator < 0 || denominator < 0 || numerator > denominator)
    throw new Error("yardstick counts out of range");
  // A zero denominator cannot satisfy the yardstick (K6/2 (b) rule 3).
  if (denominator === 0) return true;
  return (
    numerator * AVAILABILITY_YARDSTICK.denominator >
    denominator * AVAILABILITY_YARDSTICK.numerator
  );
}

export function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

const THRESHOLD_OPTION =
  /^(d|dms|d-ms|window|windowms|window-ms|deadline|deadlinems|deadline-ms|lease|leasems|lease-ms|yardstick|threshold|maxrate|max-rate|warmup|warmups|measured|minqueries|min-queries)$/iu;

/**
 * Refuses option maps that try to carry D, the lease, the yardstick or the
 * run counts, and any key outside `allowed` (N-9).
 */
export function rejectOverrides(options, allowed) {
  if (options === undefined || options === null) return;
  if (typeof options !== "object")
    throw new Error("[precheck] options must be an object");
  for (const key of Object.keys(options)) {
    if (THRESHOLD_OPTION.test(key))
      throw new Error(
        `[precheck] ${key} is frozen (D=${GRAPH_EVAL_D_MS} ms, lease ${GRAPH_RESULT_LEASE_MS} ms, 1%) and cannot be overridden`,
      );
    if (!allowed.includes(key))
      throw new Error(`[precheck] unsupported option ${key}`);
  }
}
