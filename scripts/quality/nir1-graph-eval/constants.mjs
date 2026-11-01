// CP-4 Graph evaluation harness: frozen constants and the variant catalog.
//
// Pure module with no imports. It never runs Graph, IR, Raw, a model,
// Electron or Native. The values below are confirmed or frozen elsewhere and
// are only referenced here (K6/2 `graph-eval-procedure`, l6-l9:349-361,
// post-B:214, CP-0 `evals/nir1-graph/`). No function in this harness accepts
// them as options.

/** D = min(100 ms, 0.20 * B), B = 54.2 ms. Confirmed; never recomputed. */
export const GRAPH_EVAL_D_MS = 10.84;
/**
 * Graph result lease (admission to result; separate from the P budget). No
 * evaluation rule reads it: it is named only so that an option carrying it is
 * refused (rejectOverrides). T_late borrows the value, not the interval.
 */
export const GRAPH_RESULT_LEASE_MS = 100;

/**
 * K6/4 (draftRef `nir1-final-request-eval-proposal/4`, contractId
 * `graph-eval-procedure`, confirmed 2026-10-26, Session B5). Each value is
 * written here once and read from here only (K6/4 判断 2〜4、技術点 2).
 *   W_f    = t_graph_c − t_raw_ready_c ≤ 100 ms (the child's Graph only;
 *            the child's IR keeps D; K6/4:64, 技術点 3)
 *   T_late = t_notice − t_raw_ready ≤ 100 ms (K6/4:65)
 *   T_show = t_follow − t_raw_ready ≤ 2 s (K6/4:66)
 * K6/4「変える点」16 allows only narrowing after observation, with a new
 * procedure-file version and review; no function here takes them as options.
 */
export const K64_W_F_MS = 100;
export const K64_T_LATE_MS = 100;
export const K64_T_SHOW_MS = 2_000;
/**
 * The R1 / R4 wait upper bound must be fixed in the procedure file before
 * observation and must not exceed 10 s (`DEFERRED_RELEASE_LIMIT`; K6/4 技術点
 * 2). The value itself is the procedure file's (not written yet, K6/4 確かめ
 * られなかったこと 9); only the ceiling is the contract's.
 */
export const K64_R1_R4_WAIT_CEILING_MS = 10_000;
/** The owner's `rebuild_min_interval` (R1 (3); `nir1_graph_product.rs:94`). */
export const OWNER_REBUILD_MIN_INTERVAL_MS = 1_000;
/**
 * S1f (R5, K6/4-N16): the receipt's runner kind of the K6/4 hook consumer
 * (`k64-runner.mjs`); receipt.mjs, k64-record.mjs and followup.mjs read it
 * from here.
 */
export const K64_HOOK_CONSUMER_RUNNER = "k64-hook-consumer";

/**
 * The K6/4 bytes (批准 7). The integrator froze them on
 * `claude/nir1-contracts` at commit `5dea38af…` (pushed 2026-10-27T09:11:20Z;
 * the freeze record is `docs/plans/nir1-cp4-records/k64-freeze-record.md` at
 * `a0b20a38` on the same branch), and `freezeCommit` pins that commit here
 * (DR-CP4-T14-1). A formal K6/4 receipt validates only with this commit and
 * these bytes at its head; `null` would stop every formal run (fail closed).
 */
export const K64_FREEZE = Object.freeze({
  path: "docs/plans/nir1-final-request-eval-proposal-4-draft.md",
  sha256: "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3",
  draftRef: "nir1-final-request-eval-proposal/4",
  contractId: "graph-eval-procedure",
  /** The confirmed version (continuation §10.7). Not the freeze commit. */
  confirmedCommit: "18ebc7b8de2d4f2701c573b5d91561a6cc852024",
  /** The freeze commit on `claude/nir1-contracts` (批准 7), pinned. */
  freezeCommit: "5dea38af158283c2a925d68ef0d8b0771c0ea209",
});

/**
 * 批准 5: the K6/4 relaxation applies only to a candidate that has all of
 * (a) D′ (#715), (b) the hook that keeps the list on a `graph-ready` refresh
 * (DR-RSJ-6; evidence: the candidate passes the RS-JOIN keep test, or has the
 * hook commit `c7b091da` as an ancestor; (b-3) from R7) and (c) the W_f
 * product change (批准 12, #725).
 */
export const K64_CANDIDATE_REQUIREMENTS = Object.freeze({
  dPrimeCommit: "4d38d0d164e02a76a0e172214b259a11e0b2c5ff",
  rsJoinHookCommit: "c7b091dadabac6cc098a932052cf817493205204",
  rsJoinKeepTest:
    "src/features/related-scenes/useNir1RelatedScenes.graphReadyKeep.test.tsx",
  wfWindowCommit: "c4333bbd081fb297cf2dddc598155791b9678be8",
});
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
  path: "evals/nir1-graph/freeze.v2.json",
  sha256: "8958dc736d67418cab4c183ab68131f723536bcc72cdf96944cd39e3fd4b127d",
});
export const G01_FIXTURE = Object.freeze({
  path: "evals/nir1-g01/fixture.v1.json",
  sha256: "996ef1c05b261a1d17618fea26342eb63418c050ae39246bb8b67c705ac84e79",
  fixtureId: "nir1-g01-explicit-pin-design/1",
});

/**
 * Frozen G-case fixture digests, copied from `freeze.v2.json` `cases` (G-04 is
 * version 2; the version-1 G-04 and `freeze.v1.json` stay in the tree as the
 * superseded record, DR-CP4-G4-6).
 */
export const FROZEN_FIXTURE_SHA256 = Object.freeze({
  [G01_FIXTURE.path]: G01_FIXTURE.sha256,
  "evals/nir1-graph/g02-directed-relation.v1.json":
    "c9e9ea0c41e6818d19722d6e2c4255cac96b54cd55f0808f88357ad74416946c",
  "evals/nir1-graph/g03-bounded-two-hop.v1.json":
    "39aec43a66f3ede60249cc74f5524fbe8201ca20ff629c98d54fc05cc360f76d",
  "evals/nir1-graph/g04-scope-exact-unknown.v2.json":
    "96d44ec362f30352d6cb971c208f2ab71aed944d008cab9eb65ca2ab57c218e1",
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
 * denominator (K6/2 step 1). `declaration` marks the six K2/4 declaration
 * runs (G-04/base is the fifth declared Scene of K2/4, DR-CP4-G4-2).
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
      true,
      "evals/nir1-graph/g04-scope-exact-unknown.v2.json",
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
  /^(d|dms|d-ms|window|windowms|window-ms|deadline|deadlinems|deadline-ms|lease|leasems|lease-ms|yardstick|threshold|maxrate|max-rate|warmup|warmups|measured|minqueries|min-queries|tolerance|tolerancems|tolerance-ms|wf|w-f|wfms|wf-ms|w_f|tlate|t-late|tlatems|tlate-ms|t_late|tshow|t-show|tshowms|tshow-ms|t_show|wait|waitms|wait-ms|ceiling)$/iu;

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
        `[precheck] ${key} is frozen (D=${GRAPH_EVAL_D_MS} ms, lease ${GRAPH_RESULT_LEASE_MS} ms, W_f ${K64_W_F_MS} ms, T_late ${K64_T_LATE_MS} ms, T_show ${K64_T_SHOW_MS} ms, 1%) and cannot be overridden`,
      );
    if (!allowed.includes(key))
      throw new Error(`[precheck] unsupported option ${key}`);
  }
}
