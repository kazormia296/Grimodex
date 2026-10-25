// CP-4 Graph evaluation harness: frozen constants and the variant catalog.
//
// Pure module with no imports. It never runs Graph, IR, Raw, a model,
// Electron or Native. The values below are confirmed or frozen elsewhere and
// are only referenced here (K6/2 `graph-eval-procedure`, l6-l9:349-361,
// post-B:214, CP-0 `evals/nir1-graph/`). No function in this harness accepts
// them as options.

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
/**
 * Window-boundary disagreement tolerance (10 µs). A result the product
 * joined although its renderer `performance.now()` arrival is after
 * `t_raw_ready + D` is classified conservatively as out of window when it is
 * within this width (the product compares `now < deadline` with
 * D = 10.840000000596048 ms, a 6e-7 ms difference from the confirmed 10.84);
 * beyond it the run stops with `[precheck]` as a suspected product N-7
 * violation. Not a threshold of the evaluation; registered for review in the
 * observation-prep record.
 */
export const BOUNDARY_TOLERANCE_MS = 0.01;

export const K62_FREEZE = Object.freeze({
  path: "docs/plans/nir1-final-request-eval-proposal-2-draft.md",
  commit: "af643a93eeae7f937c9cd5a9dd87a6308c96fab6",
  sha256: "4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8",
});
export const GRAPH_CASE_FREEZE = Object.freeze({
  path: "evals/nir1-graph/freeze.v1.json",
  sha256: "6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7",
});
export const G01_FIXTURE = Object.freeze({
  path: "evals/nir1-g01/fixture.v1.json",
  sha256: "996ef1c05b261a1d17618fea26342eb63418c050ae39246bb8b67c705ac84e79",
  fixtureId: "nir1-g01-explicit-pin-design/1",
});

/** Frozen G-case fixture digests, copied from `freeze.v1.json` `cases`. */
export const FROZEN_FIXTURE_SHA256 = Object.freeze({
  [G01_FIXTURE.path]: G01_FIXTURE.sha256,
  "evals/nir1-graph/g02-directed-relation.v1.json":
    "c9e9ea0c41e6818d19722d6e2c4255cac96b54cd55f0808f88357ad74416946c",
  "evals/nir1-graph/g03-bounded-two-hop.v1.json":
    "39aec43a66f3ede60249cc74f5524fbe8201ca20ff629c98d54fc05cc360f76d",
  "evals/nir1-graph/g04-scope-exact-unknown.v1.json":
    "4d002261b1230d2a3fd355d97bb53a146f94515f3c513872337e7176a893abcf",
  "evals/nir1-graph/g05-current-revision-freshness.v1.json":
    "52c5ac72bf5886bcc6fc1c901575bc91e36a17c7d236191a610d5dcb31093c28",
  "evals/nir1-graph/g06-evidence-anchor-path.v1.json":
    "acb55cbd352949ced010dbbc2e3b06fed4dad9144488172cbe76cd6105d7b40a",
  "evals/nir1-graph/g07-reading-before-reveal.v1.json":
    "385eaa732f48c10417a775430615ee4b0e245818e87b525ce7c1509ea83d12d0",
  "evals/nir1-graph/g08-graph-index-fallback.v1.json":
    "0415561e3834eff5c1f04d1a66e49177209b6755c79015d3b7944f374600a4c9",
});
/** Digests a dev fixture must never equal (copies of frozen material). */
export const FROZEN_MATERIAL_SHA256 = Object.freeze(
  new Set([GRAPH_CASE_FREEZE.sha256, ...Object.values(FROZEN_FIXTURE_SHA256)]),
);

/** The pre-observation freeze record (S4); its path is not an argument. */
export const OBSERVATION_PREP_RECORD_PATH =
  "evals/nir1-graph/observation-prep-freeze.v1.json";
export const OBSERVATION_PREP_RECORD_SCHEMA =
  "nir1-cp4-observation-prep-freeze/1";
/** The only remote-tracking ref that proves "on the remote" (TASK D13). */
export const OBSERVATION_PREP_REMOTE_REF = "refs/remotes/origin/master";

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
    ["G-01", "v1", "available", true, G01_FIXTURE.path],
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
      kind: "frozen",
      caseId,
      variantId,
      expectedGraph,
      declaration,
      fixturePath,
      fixtureSha256: FROZEN_FIXTURE_SHA256[fixturePath],
    }),
  ),
);
export const ALL_VARIANT_KEYS = Object.freeze(
  GRAPH_EVAL_VARIANTS.map((row) => row.key),
);

/** Dev (synthetic, not frozen) variant keys: `dev:<fixture>/<variant>`. */
export const DEV_VARIANT_KEY = /^dev:[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9-]*$/u;

export function variantByKey(key) {
  const variant = GRAPH_EVAL_VARIANTS.find((row) => row.key === key);
  if (!variant) throw new Error(`[precheck] unknown CP-4 variant ${key}`);
  return variant;
}

/** A dev variant row, validated; never a frozen key. */
export function devVariant({ key, expectedGraph }) {
  if (typeof key !== "string" || !DEV_VARIANT_KEY.test(key))
    throw new Error(
      `[precheck] dev variant key must match dev:<fixture>/<variant>: ${key}`,
    );
  if (expectedGraph !== "available" && expectedGraph !== "unavailable")
    throw new Error(
      `[precheck] dev variant ${key} needs its expected Graph status`,
    );
  return Object.freeze({ key, kind: "dev", expectedGraph, declaration: false });
}

/**
 * The predeclared variant plan of an (a) computation. A frozen plan is
 * always all 13 variants; a dev plan lists dev variants only.
 */
export function resolvePlan(plan) {
  if (plan?.kind === "frozen") {
    if (plan.variants !== undefined)
      throw new Error(
        "[precheck] a frozen plan is always the 13 catalog variants",
      );
    return { kind: "frozen", variants: GRAPH_EVAL_VARIANTS };
  }
  if (plan?.kind === "dev") {
    if (!Array.isArray(plan.variants) || plan.variants.length === 0)
      throw new Error("[precheck] a dev plan lists its dev variants");
    const variants = plan.variants.map(devVariant);
    if (new Set(variants.map((row) => row.key)).size !== variants.length)
      throw new Error("[precheck] duplicate dev variant");
    return { kind: "dev", variants };
  }
  throw new Error("[precheck] the variant plan must be frozen or dev");
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
  /^(d|dms|d-ms|window|windowms|window-ms|deadline|deadlinems|deadline-ms|lease|leasems|lease-ms|yardstick|threshold|maxrate|max-rate|warmup|warmups|measured|minqueries|min-queries|tolerance|tolerancems|tolerance-ms)$/iu;

/**
 * Refuses option maps that try to carry D, the lease, the yardstick, the
 * tolerance or the run counts, and any key outside `allowed` (N-9).
 */
export function rejectOverrides(options, allowed) {
  if (options === null || typeof options !== "object")
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
