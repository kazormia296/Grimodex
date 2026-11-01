// CP-4 S2: validator of the documents fixed before the first Graph observation.
//
//   evals/nir1-g01/setup-addendum.v1.json          K2/4 setup addendum (G-01)
//   evals/nir1-graph/declaration-addendum.v2.json  K2/4 addendum (G-02/04/07/08;
//                                                  v1 without G-04 is kept)
//   evals/nir1-graph/observation-prep.v1.json      D1, D2, D10, sample plan,
//                                                  traces, K6/4 procedure,
//                                                  diagnostic runs
//   evals/nir1-graph/trace-editing.v1.json         K6/2 step 4 (b) traces
//   evals/nir1-graph/trace-browsing.v1.json
//   evals/nir1-graph/observation-prep-author-declaration.v1.json
//   scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-2.json
//
// Like contract.mjs, this module never runs Graph, IR, Raw, a model, Electron
// or Native, and reads no runtime output. It recomputes what the documents
// copy from the contracts (the K2/4 table, K6/2 Q >= 200 and the editing
// density, the K6/4 values) and from the frozen fixtures, and checks the
// digests the documents reference. The frozen fixtures are those of the
// current Graph case freeze (contract.mjs NIR1_GRAPH_FREEZE_PATH, freeze.v2.json
// since G-04 version 2; DR-CP4-G4-6, B1 review P3-6); they are only read.
// Documents that still name freeze.v1.json fail closed until re-pinned. A draft (placeholders `S4:<name>`) validates, but is never usable for
// a formal run (assertObservationPrepFormal).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NIR1_GRAPH_FREEZE_PATH } from "./contract.mjs";
import {
  SEED_PIN_ADDENDUM_PATH,
  SP1,
  SYNTHETIC_NEGATIVES,
  seedPinAddendumErrors,
} from "./seed-pin-addendum.mjs";

export const OBSERVATION_PREP_FILES = Object.freeze({
  setupAddendum: "evals/nir1-g01/setup-addendum.v1.json",
  declarationAddendum: "evals/nir1-graph/declaration-addendum.v2.json",
  prep: "evals/nir1-graph/observation-prep.v1.json",
  traceEditing: "evals/nir1-graph/trace-editing.v1.json",
  traceBrowsing: "evals/nir1-graph/trace-browsing.v1.json",
  authorDeclaration:
    "evals/nir1-graph/observation-prep-author-declaration.v1.json",
  procedureDraft:
    "scripts/quality/nir1-graph-eval/procedure/k64-procedure.draft-2.json",
  seedPinAddendum: SEED_PIN_ADDENDUM_PATH,
});

/** The placeholder S4 replaces in the observation-prep commit. */
export const PLACEHOLDER = /^S4:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/u;

/** Contract bytes (K2/4 confirmed in Session B2; K6/2 frozen; K6/4 confirmed in B5). */
export const CONTRACTS = Object.freeze({
  k24: Object.freeze({
    draftRef: "nir1-c-body-disclosure-proposal/4",
    path: "docs/plans/nir1-c-body-disclosure-proposal-4-draft.md",
    sha256: "efc30cca32f2c91386baf3061836427ae7df3499c18188d31b5e2ba422a2fcfd",
    contractIds: Object.freeze([
      "graph-target-scene-body-disclosure",
      "scope-storage-authority",
    ]),
  }),
  k62: Object.freeze({
    draftRef: "nir1-final-request-eval-proposal/2",
    path: "docs/plans/nir1-final-request-eval-proposal-2-draft.md",
    sha256: "4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8",
    freezeCommit: "af643a93eeae7f937c9cd5a9dd87a6308c96fab6",
  }),
  k64: Object.freeze({
    draftRef: "nir1-final-request-eval-proposal/4",
    contractId: "graph-eval-procedure",
    path: "docs/plans/nir1-final-request-eval-proposal-4-draft.md",
    sha256: "d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3",
    confirmedCommit: "18ebc7b8de2d4f2701c573b5d91561a6cc852024",
  }),
});

/**
 * K2/4「setup の addendum」の表（宣言する Scene、reading、excerpt）。K2/4 :391
 * は 4 つの Scene を列挙する。G-04 base（fixture v2 の g04-lio-landing）は、
 * ユーザーの確認（K24_SCOPE_EXTENSION、contracts a7027915 の質問 3）で K2/4 の
 * 適用範囲を広げた 5 件目で、値は fixture v2 と K2/4 の規則から導いた
 * （DR-CP4-G4-2、G4-7）。`extension` がその行の印。
 */
export const K24_TABLE = Object.freeze(
  [
    ["G-01", "v1", "g01-mira", 20, 100, 78],
    ["G-02", "base", "g02-tamsin-first", 30, 100, 78],
    ["G-04", "base", "g04-lio-landing", 20, 100, 211, true],
    ["G-07", "base", "g07-pell-dock", 40, 100, 70],
    ["G-08", "base-usable", "g08-cass-attic", 20, 100, 64],
    ["G-08", "graph-recovered", "g08-cass-attic", 20, 100, 64],
  ].map(([caseId, variantId, sceneId, scene, query, end, extension = false]) =>
    Object.freeze({ caseId, variantId, sceneId, scene, query, end, extension }),
  ),
);

/**
 * The user's confirmation that widened K2/4's declared Scenes to G-04 base
 * (DR-CP4-G4-2). The values, vetoes, use-time checks and the product's
 * authority are K2/4's, unchanged.
 */
export const K24_SCOPE_EXTENSION = Object.freeze({
  decision: "DR-CP4-G4-2",
  variants: Object.freeze(
    K24_TABLE.filter((row) => row.extension).map(
      (row) => `${row.caseId}/${row.variantId}`,
    ),
  ),
  userConfirmation: Object.freeze({
    record:
      "claude/nir1-contracts:docs/plans/nir1-cp4-records/user-confirmation-2026-11-01-g04-v2c-build.md",
    commit: "a70279156d1ea75332e2b22f9ec479a270869143",
    sha256: "1de09724c6db736e9d688c71fe2f0d18c59eed49325bf03cbdc5ef0b726f6f5a",
  }),
});

/**
 * The declaration addendum v2 supersedes (bytes kept): its rows outside the
 * rebuilt cases are copied unchanged (DR-CP4-G4-7).
 */
export const DECLARATION_ADDENDUM_V1 = Object.freeze({
  path: "evals/nir1-graph/declaration-addendum.v1.json",
  sha256: "82b05bae92d05b3af2a73739bd14b73cf88dcdc3290e19860126c057c5552949",
});

/** K2/4「宣言の値（v1 は G-01 subset）」。 */
const DECLARATION_VALUES = Object.freeze({
  target: "saved-body-full-and-title",
  reading: "not-declared",
  story: "independent",
  auto: "independent",
  phase: "independent",
  reveal: "non-secret",
  pov: "independent",
  a1: "not-declared",
});

const G01_NEGATIVES = Object.freeze([
  ["K24-G01-N1", false, null],
  ["K24-G01-N2", true, "resave-same-body"],
  ["K24-G01-N3", true, "restore-same-bytes-body-version"],
  ["K24-G01-N4", true, "restore-different-bytes-body-version"],
]);
/** K2/4 :416 restore negatives need a prepared body version (S3-P3-2). */
const RESTORE_MUTATIONS = new Set([
  "restore-same-bytes-body-version",
  "restore-different-bytes-body-version",
]);
/** S3-P1-1: what R5 gates (every Graph arm run and the K6/4 freeze). */
const R5_GATED = Object.freeze([
  "g-case-gold",
  "g-case-diagnostic-negative",
  "v10-ready-probe",
  "k62-ii-diagnostic",
  "k62-iii-diagnostic",
  "trace",
  "k64-freeze-commit",
]);
/** S3-P3-4: every use of BOUNDARY_TOLERANCE_MS in claude/nir1-cp4. */
const TOLERANCE_USAGES = Object.freeze([
  "join.mjs:93",
  "followup.mjs:437",
  "followup.mjs:588",
  "followup.mjs:614",
  "k64-record.mjs:198",
]);
const STALL_ATTEMPT_LIMIT = 2;
/** SP/1 SP-P4: the base variants measured with and without the seed pin step. */
const SP_P4_VARIANTS = Object.freeze([
  "G-01/v1",
  "G-02/base",
  "G-03/base",
  "G-04/base",
  "G-05/base",
  "G-06/base",
  "G-07/base",
  "G-08/base-usable",
]);
const R5_MATCH_REQUIRES = Object.freeze([
  "seed-pin-step-executed-workspace",
  "product-db-reread",
]);
const R5_EXEMPT = Object.freeze([
  "g-case-parity-unrestricted",
  "sp-p4-seed-pin-parity",
  "r5-seed-pin-check",
]);
/** The R5 check run: setup and a DB read only (integrator; K6/4 :317). */
const R5_CHECK_SCOPE = Object.freeze([
  "setup-through-seed-pin-step",
  "product-db-read",
]);
const R5_CHECK_FORBIDS = Object.freeze([
  "graph-arm",
  "rir-query",
  "evaluation-run",
  "diagnostic",
  "trace",
  "v10-ready-probe",
  "maintenance-enable",
  "setup-timeline",
  "typed-revision-prepare",
  "b-graph-index-build",
  "chronicle-index-build",
  "index-state-record",
]);
/**
 * ① R5 -> ② K6/4 freeze -> ②' synthetic detection (node tests, no runtime)
 * -> ③ S4 (S4a bytes, S4b fill and freeze) -> ④ SP-P4 -> ⑤ Graph arm.
 */
const PHASES = Object.freeze([
  "r5-seed-pin-check",
  "k64-freeze-commit",
  "sp-synthetic-detection",
  "s4-observation-prep-commit",
  "sp-p4-seed-pin-parity",
  "graph-arm-runs",
]);
/** The order of the setup and measurement steps (SP/1 設計; K2/4 :406-408). */
const STEP_ORDER = Object.freeze({
  graphCases: Object.freeze([
    "setupOrder: project and Scenes, Codex, registry and explicit A1, foreshadows/foreshadow links/fixture pins",
    "SP/1 seed pin step",
    "setupOrder: maintenance enabled",
    "setupTimeline",
    "measurementPoint",
    "measurement workspace opened (copy of the setup DB)",
    "K2/4 declaration step (declaration runs only; D1 (ii))",
    "V-10 READY probe and the Graph arm",
  ]),
  g01: Object.freeze([
    "candidate §7 Scenes, explicit A1, registry, the g01-mira pin",
    "SP/1 seed pin step",
    "typed Revision prepare/approval, qualified IR, B seal",
    "measurement workspace opened (copy of the setup DB)",
    "K2/4 declaration step (D1 (ii))",
    "V-10 READY probe and the Graph arm",
  ]),
});
const PROCEDURE_V1 =
  "scripts/quality/nir1-graph-eval/procedure/k64-procedure.v1.json";
const GRAPH_NEGATIVES = Object.freeze([
  ["K24-G02-N1", "G-02", "base"],
  ["K24-G04-N1", "G-04", "base"],
  ["K24-G07-N1", "G-07", "base"],
  ["K24-G08-N1", "G-08", "base-usable"],
]);
const SETUP_ORDER_ANCHOR = "then foreshadows, foreshadow Codex links and pins";
const ADDENDUM_STATUSES = Object.freeze([
  "draft-awaiting-independent-review",
  "frozen-after-independent-review",
]);
const PREP_DRAFT = "draft-awaiting-s3-review-and-s4-freeze";
const PREP_FROZEN = "frozen-before-observation";

/** K6/4 values (判断 2〜4; D from the P contract) and 技術点 2's ceiling. */
export const K64_VALUES = Object.freeze({
  dMs: 10.84,
  wFMs: 100,
  tLateMs: 100,
  tShowMs: 2_000,
});
export const K64_WAIT_CEILING_MS = 10_000;
const K64_FOLLOW = Object.freeze(
  Array.from({ length: 7 }, (_, at) => `F${at + 1}`),
);
const K64_EXCLUSIONS = Object.freeze(
  Array.from({ length: 13 }, (_, at) => `X${at + 1}`),
);

/** K6/2 step 2 and (b) rule 1. */
const WARMUP_PER_ARM = 5;
const MEASURED_PER_ARM = 30;
const TRACE_MIN_QUERIES = 200;
const PARITY_VARIANTS = Object.freeze([
  "G-02/base",
  "G-03/base",
  "G-03/frontier-exceeded",
  "G-04/base",
  "G-05/base",
  "G-06/base",
  "G-07/base",
  "G-08/base-usable",
  "G-08/graph-index-unusable",
  "G-08/graph-recovered",
  "G-08/chronicle-index-unusable",
  "G-08/both-indexes-unusable",
]);
const PLAN_VARIANTS = Object.freeze(["G-01/v1", ...PARITY_VARIANTS]);
const DIAGNOSTIC_IDS = Object.freeze([
  ...G01_NEGATIVES.map(([id]) => id),
  ...GRAPH_NEGATIVES.map(([id]) => id),
  "K62-iii",
  "SP-P4",
]);

/**
 * S2 追補（DR-CP4-L-1〜L-15。master 3a6e65e4 の frozen-setup-plan.mjs と
 * frozen-setup-driver.mjs の写し）: the complete setup's sessions, the
 * measurement spec of each measurementPoint, the seal reopen and the names a
 * setup stops with. The validator re-derives each variant's sessions from the
 * frozen fixtures with the plan's rule.
 */
const SETUP_READING_ITEMS = Object.freeze([
  ["SR-1", "(1)"],
  ["SR-2", "(2)"],
  ["SR-3", "(3)"],
  ["SR-4", "(4)"],
  ["SR-5", "(5)"],
  ["SR-6", "(6)"],
  ["SR-7", "(7)"],
  ["SR-8", "(8)"],
  ["SR-9", "(9)"],
  ["SR-10", "(10)"],
  ["SR-11", "L-24"],
  ["SR-12", "L-27"],
  ["SR-13", "L-19"],
  // S2 追補 #9（DR-CP4-P-5）: the re-freeze's harness readings.
  ["SR-14", "T-3、T-5"],
  ["SR-15", "T-1"],
  ["SR-16", "T-4"],
]);
/**
 * S2 追補 #2（S3v6-P2-1）: the master commits S2 pins (never a commit a rebase
 * left unreachable). S5 checks the candidate's harness files against them.
 */
const HARNESS_DIR = "scripts/quality/nir1-graph-eval/";
/**
 * S2 追補 #4（DR-CP4-O-5 (i)、DR-CP4-P-1）: each pin's role, commit, check
 * and (bytes) the exact harness paths it holds — a file is held by the
 * master commit that last changed it, and no path is held twice. The pins
 * after b1a87b0b hold every non-test harness file #754 and #756 changed.
 * S2 追補 #5（S3 の 7 回目の P2-2、P-S2-9 (b)、DR-CP4-P-2）: every harness
 * file in the closure of FORMAL_HARNESS_ENTRIES (static imports and the
 * harness paths a file names) is held too.
 * S2 追補 #7（DR-CP4-P-4。P-S2-9 (b) を厳しい側へ拡張）: the closure's
 * eval-only scripts outside the harness directory are held too; only
 * EVAL_CLOSURE_EXCLUSIONS (shared CI and product) are not.
 */
export const SOURCE_PINS = Object.freeze(
  [
    ["s1j2-blocked-map", "b1a87b0b81fbdce7f3d280e0671bced51306be1d", []],
    [
      "s1j2-complete-setup",
      "3a6e65e400cac5d72e761f58eb1ae8eaec514e18",
      [
        "electron-observer.entry.mjs",
        "frozen-setup-plan.mjs",
        "launcher.mjs",
        "session.mjs",
        "setup-main-build.mjs",
        "setup-receipt.mjs",
      ],
    ],
    // S2 追補 #10（DR-CP4-P-6）: renderer/cp4-trace-probe.tsx and
    // trace-record.mjs moved to the V-2〜V-4 pins.
    [
      "trace-runner",
      "35537447b4e38c31a2dc9463b2d6fe8ccb54e4ba",
      ["build-receipt-check.mjs", "renderer/trace-cycle.ts", "trace-seal.mjs"],
    ],
    ["b-route-seam-fix", "c06dc17ec86fa968c87176aece12b4a1d67e2105", []],
    [
      "t14-k64-freeze",
      "9e1a564efe5d7ac9d72d3c4008a6d9677b2b6d6f",
      ["constants.mjs", "receipt.mjs"],
    ],
    ["freshness-requeue-fix", "02837f02bb9df82da6dc65b3d237bf17840ad775", []],
    ["startup-gate-io-settle", "26764b433e6299db960f608bb99e4332949d39a3", []],
    // S2 追補 #9（DR-CP4-P-5）: frozen-k64-plan.mjs and workspace-db.mjs moved
    // to the T-1〜T-5 pins.
    [
      "s5a-graph-arm-runner",
      "2c9316848ce028565c4d8e8af2d2779c3fd7e187",
      [
        "k64-record.mjs",
        "k64-runner.mjs",
        "material-revision.mjs",
        "renderer/cp4-k64-probe.tsx",
      ],
    ],
    [
      "maintenance-ownership-release",
      "3f3d9999225007417708ab471bea307331f7e8a2",
      [],
    ],
    // S2 追補 #9（DR-CP4-P-5）: frozen-k64-run.mjs and frozen-setup-driver.mjs
    // moved to the T-1〜T-5 pins. S2 追補 #10（DR-CP4-P-6）: trace-runner.mjs
    // moved to the V-4 pin.
    [
      "s5b-diagnostics-wiring",
      "950751d040b29b6d78a067a003dc19b196cfb692",
      [
        "g01-negative-preview.mjs",
        "g01-negatives.mjs",
        "renderer/cp4-diagnostic-probe.ts",
        "renderer/cp4-harness.ts",
        "renderer/nir1RelatedScenesApi.timing.ts",
        "window.mjs",
      ],
    ],
    // S2 追補 #6（DR-CP4-Q-1、DR-CP4-P-3）: #757 last changed these three
    // (frozen-diagnostics.mjs moved to sp-p4-ir-pair-limit in S2 追補 #8).
    [
      "sp-p4-ir-timeout",
      "43e3f40b5d653c62d5aca4ca795917b67310992c",
      ["g01-negative-run.mjs"],
    ],
    // S2 追補 #7（DR-CP4-S4-1、DR-CP4-P-4）: #758 last changed these five
    // (nir1-retrieval/contract.mjs is outside the harness directory;
    // diagnostic-runner.mjs moved to sp-p4-ir-pair-limit in S2 追補 #8).
    [
      "s4-rehearsal-admission",
      "82d427465b16a12809c6f93adad74ac97859c85a",
      [
        "admission.mjs",
        "frozen-k64-admission.mjs",
        "trace-frozen.mjs",
        "scripts/quality/nir1-retrieval/contract.mjs",
      ],
    ],
    // S2 追補 #8（DR-CP4-Q-2）: #759 last changes these two (the pair limit).
    // The commit is #759's squash on master (the same bytes as the PR head).
    [
      "sp-p4-ir-pair-limit",
      "906da641befb8dfbb445e05ce5df814bf5b16c35",
      ["diagnostic-runner.mjs", "frozen-diagnostics.mjs"],
    ],
    // S2 追補 #9（DR-CP4-P-5、DR-CP4-S4-5）: the harness fix of the re-freeze
    // (DR-CP4-T-1〜T-5, branch claude/cp4-freshness-settle). b0df31f0 (T-5)
    // last changes the setup's Freshness/maintenance wait and the read-only
    // reads; 354b1ba6 (T-4) last changes the measurement process's wait (T-1)
    // and the V-10 READY applicability. These are branch commits that S4's PR
    // brings to master with its merge commit (gh pr merge --merge), never a
    // squash, so they stay master's ancestors with these hashes.
    [
      "t3-t5-setup-freshness-settle",
      "b0df31f076ea1e11fd187c5c6fdf179d0df337b5",
      ["frozen-setup-driver.mjs", "workspace-db.mjs"],
    ],
    [
      "t1-t4-measurement-settle-ready",
      "354b1ba6a997bc464fb2ee9d7a2276c9f7d0bc78",
      ["frozen-k64-plan.mjs", "frozen-k64-run.mjs"],
    ],
    // S2 追補 #10（DR-CP4-P-6、DR-CP4-S4-6）: the harness fix of the trace
    // path (DR-CP4-V-2〜V-4, branch claude/cp4-trace-path-fix). Each file is
    // held by the branch commit that last changes it: 262be7a9 (V-2 (2), the
    // probe's paths), 527589b6 (V-4 (B3), trace-record.mjs), 2854aa31 (V-4
    // (B1), followup.mjs) and 759a4679 (V-4, the quote guard in
    // trace-runner.mjs). Like the T-1〜T-5 pins, S4's PR brings them to
    // master with its merge commit (gh pr merge --merge), never a squash.
    [
      "v2-trace-probe-paths",
      "262be7a9f53834a8d2b2f4d2751757519b94c9d1",
      ["renderer/cp4-trace-probe.tsx"],
    ],
    [
      "v4-trace-record-requery",
      "527589b6ca374d8c4e3933f6ec0b35632ca7cd2d",
      ["trace-record.mjs"],
    ],
    [
      "v4-followup-cancelled-match",
      "2854aa31da9b172b3e6d5a847267fbc76b9accf6",
      ["followup.mjs"],
    ],
    [
      "v4-trace-runner-quote-guard",
      "759a4679a7b90d25c13bc9a8517f8a64df43adda",
      ["trace-runner.mjs"],
    ],
    [
      "pr1-native-eval-feature",
      "3739dbedb762ada8961f509c1b4d6885a11c3099",
      ["native-architecture.mjs"],
    ],
    // S2 追補 #10（DR-CP4-P-6）: followup.mjs moved to the V-4 pin.
    [
      "p1-harness-core",
      "865a3e2bad1ada5f6e5648e50c6902052b9b2a3c",
      [
        "admission-facts.mjs",
        "availability.mjs",
        "egress.mjs",
        "join.mjs",
        "native-sample.mjs",
        "procedure-file.mjs",
        "q4.mjs",
        "run-sample.mjs",
        "stats.mjs",
        "scripts/quality/nir1-retrieval/standard-build-receipt.mjs",
      ],
    ],
    [
      "p2p3-harness-admission",
      "a4e65b66006dec7101f93340cdca70fcafabfc5d",
      [
        "dev-fixture.mjs",
        "dprime-check.mjs",
        "eval-native-build.mjs",
        "keep-test.mjs",
        "observer-core.mjs",
        "outcome.mjs",
        "renderer-build.mjs",
        "renderer/cp4-harness.html",
        "renderer/cp4-hook-probe.tsx",
        "renderer/fetchRelatedScenes.timing.ts",
        "renderer/nir1GraphAvailability.eval.ts",
        "renderer/shell.timing.ts",
        "signal-cleanup.mjs",
        "scripts/quality/nir1-retrieval/standard-build.mjs",
      ],
    ],
    [
      "p4-setup-driver-seed-pin",
      "7a2669ead5262cc1a1126a7ab52bf808afeb98ff",
      [
        "r5-check-runner.mjs",
        "seed-pin-setup.mjs",
        "seed-pin.mjs",
        "setup-driver.mjs",
      ],
    ],
    // S2 追補 #7（DR-CP4-P-4）: the eval-only scripts outside the harness
    // directory in the formal entries' closure, each at the master commit
    // that last changed it (the shared CI and product files are
    // EVAL_CLOSURE_EXCLUSIONS).
    [
      "nir1-retrieval-ir-base",
      "ffa3c0adc56e9af0b385c0379b63a69278242240",
      [
        "scripts/quality/nir1-retrieval/acceptance-policy.mjs",
        "scripts/quality/nir1-retrieval/candidate-policy.mjs",
      ],
    ],
    [
      "cp0-graph-eval-freeze",
      "6bdf61e99f80debd8c2c0c56f2c892e21534f924",
      [
        "scripts/quality/nir1-graph/porter.mjs",
        "scripts/quality/nir1-retrieval/paired.mjs",
      ],
    ],
    [
      "da1-route-isolation",
      "2b68fd4df67599ca2f277fc94f94956de463381e",
      ["scripts/quality/run-nir1-retrieval.mjs"],
    ],
    [
      "cq-lim-graph-limits",
      "a789039a779eb4df0dec2b8b3be5e29d2bff5a5c",
      ["scripts/quality/nir1-graph/contract.mjs"],
    ],
    [
      "dp-h-unknown-scope",
      "e2d22b89c92b9de9585d273349e516e9df6ee5b7",
      ["scripts/quality/nir1-packing/final-request/architecture.mjs"],
    ],
  ].map(([role, commit, names]) =>
    Object.freeze({
      role,
      commit,
      check: names.length > 0 ? "bytes" : "ancestor",
      // A name under scripts/ is a repository path (S2 追補 #7), any other a
      // harness path.
      paths: Object.freeze(
        names.map((name) =>
          name.startsWith("scripts/") ? name : HARNESS_DIR + name,
        ),
      ),
    }),
  ),
);
/**
 * S2 追補 #7（DR-CP4-P-4）: the files the formal entries' closure reaches
 * but no pin holds — shared CI and product files (the product build's
 * receipt binds the product; the CI files change for reasons unrelated to
 * the eval). The closure stops at them; a new one fails the closure test.
 */
export const EVAL_CLOSURE_EXCLUSIONS = Object.freeze([
  "electron/main/rendererContainment.ts",
  "electron/main/rendererContainmentListener.ts",
  "electron/main/rendererContainmentStartup.ts",
  "electron/scripts/build.mjs",
  "scripts/local-ci-process-supervisor.mjs",
]);
/** S2 追補 #7: a file the eval closure does not pin (product or shared CI). */
export function isSharedClosureBoundary(file) {
  return /^(?:src\/|electron\/|scripts\/local-ci)/u.test(file);
}
/**
 * S2 追補 #7（DR-CP4-S4-1、DR-CP4-P-4）: the words S2's S4 procedure
 * (s4StagesRule) carries — (a) S4's branch merges origin/claude/nir1-contracts
 * with a merge commit so ①, ② and ②' are strict ancestors of S4b, (b) S4's
 * PR is merged with a merge commit, never squash or rebase, (c) the
 * integrator runs assertObservationPrepFormal on S4b's commit, which no
 * runtime entry calls, (d) the formal entries read S2's file against the
 * freeze record's binding and sha256.
 */
export const S4_PROCEDURE_WORDS = Object.freeze({
  a: ["origin/claude/nir1-contracts", "merge commit", "①", "②'", "真の祖先"],
  b: ["gh pr merge --merge", "squash", "rebase"],
  c: ["assertObservationPrepFormal", "S4b の commit", "integrator"],
  d: ["DR-CP4-S4-1", "freeze record", "sha256", "readAdmittedObservationPrep"],
  // S2 追補 #9（DR-CP4-S4-5）: (e) the re-freeze — a revocation commit deletes
  // the old S4b's record and S4b' introduces the new one at the same path
  // (recordIntroducedByCommit), with the user's confirmation on record.
  e: [
    "DR-CP4-S4-5",
    "b7d7495034ee693e82b9a6e55bbcbfd433215012",
    "失効",
    "recordIntroducedByCommit",
    "user-confirmation-2026-10-31-refreeze.md",
  ],
  // S2 追補 #10（DR-CP4-S4-6）: (f) the third re-freeze — the old S4b' is
  // revoked after its trace was invalid from the harness's trace path
  // (DR-CP4-V-2〜V-4), with the user's confirmation on record, and only the
  // new S4's results are used.
  f: [
    "DR-CP4-S4-6",
    "9f52e7da37b84603424d0b7e6ecee8e019d1c7c9",
    "DR-CP4-V-2〜V-4",
    "user-confirmation-2026-10-31-trace-refreeze.md",
    "新しい S4 の結果だけ",
  ],
});
/**
 * S2 追補 #5（P-S2-9 (b)）: the formal entries whose harness closure the
 * bytes pins cover.
 */
export const FORMAL_HARNESS_ENTRIES = Object.freeze([
  "diagnostic-runner.mjs",
  "trace-runner.mjs",
  "frozen-k64-run.mjs",
  "frozen-setup-driver.mjs",
  "r5-check-runner.mjs",
]);
/**
 * S2 追補 #6: the bytes pin that holds a harness path (each path is held by
 * exactly one pin), or undefined.
 */
export function harnessPinOf(file) {
  return SOURCE_PINS.find((pin) => pin.paths.includes(file));
}
/**
 * S2 追補 #3／#4: the harness file whose BLOCKED_CONTRACT_TABLE (DR-CP4-L-28)
 * blockedCaseJudgement must equal, read at the pinned commit.
 */
export const BLOCKED_TABLE_SOURCE = Object.freeze({
  role: harnessPinOf(`${HARNESS_DIR}frozen-setup-driver.mjs`).role,
  commit: harnessPinOf(`${HARNESS_DIR}frozen-setup-driver.mjs`).commit,
  path: `${HARNESS_DIR}frozen-setup-driver.mjs`,
});
/**
 * S2 追補 #4: the harness constants S2's readings copy, parsed from the
 * pinned bytes (never imported or run) and compared with S2's values.
 * S2 追補 #6: each file is read at the commit of the pin that holds it
 * (frozen-diagnostics.mjs at sp-p4-ir-timeout, the others at
 * s5b-diagnostics-wiring), and SP_P4_IR_TIMEOUT_LIMIT is DR-CP4-Q-1's C2 K.
 * S2 追補 #8（DR-CP4-Q-2）: frozen-diagnostics.mjs is read at the
 * sp-p4-ir-pair-limit pin, and SP_P4_IR_TIMEOUT_PAIR_LIMIT is the pair limit
 * (S3's C2: at least 24 IR-compared pairs of 30).
 */
export const HARNESS_CONSTANTS = Object.freeze({
  // S2 追補 #9（DR-CP4-T-3）: the complete setup's Freshness wait (read at the
  // t3-t5-setup-freshness-settle pin).
  [`${HARNESS_DIR}frozen-setup-driver.mjs`]: Object.freeze([
    "B_SEAL_REOPENS",
    "B_SEAL_WAIT_MS",
    "FRESHNESS_SETTLE_WAIT_MS",
    "FRESHNESS_SETTLE_INTERVAL_MS",
  ]),
  [`${HARNESS_DIR}g01-negatives.mjs`]: Object.freeze([
    "G01_CONTROL_ATTEMPTS",
    "G01_SAMPLE_ATTEMPTS",
    "G01_CONTROL_GAP_MS",
    "G01_GRAPH_READY_WAIT_MS",
  ]),
  [`${HARNESS_DIR}frozen-diagnostics.mjs`]: Object.freeze([
    "SP_P4_COMPARISON_RULE",
    "SP_P4_IR_TIMEOUT_LIMIT",
    "SP_P4_IR_TIMEOUT_PAIR_LIMIT",
  ]),
});
/**
 * S2 追補 #9（DR-CP4-T-1）: the measurement process's Freshness wait. The
 * harness keeps these module constants unexported (`const`, not `export
 * const`) and its names are the setup's names, so S2 reads each once from
 * the pinned bytes under its own name `as` (never imported or run).
 */
export const HARNESS_MODULE_CONSTANTS = Object.freeze({
  [`${HARNESS_DIR}frozen-k64-run.mjs`]: Object.freeze([
    Object.freeze({
      name: "FRESHNESS_SETTLE_LIMIT_MS",
      as: "RUN_FRESHNESS_SETTLE_LIMIT_MS",
    }),
    Object.freeze({
      name: "FRESHNESS_SETTLE_INTERVAL_MS",
      as: "RUN_FRESHNESS_SETTLE_INTERVAL_MS",
    }),
  ]),
});
/**
 * S2 追補 #9（DR-CP4-T-4 (a)）: the plan file whose `readyProbeOf` decides the
 * kinds V-10 READY applies to (read from its pin's bytes).
 */
export const READY_PROBE_SOURCE = Object.freeze({
  path: `${HARNESS_DIR}frozen-k64-plan.mjs`,
});
const SETUP_SESSIONS = Object.freeze({
  author: Object.freeze({ main: "product", seam: false }),
  ir: Object.freeze({ main: "setup-ir", seam: false }),
  seal: Object.freeze({ main: "product", seam: true }),
  hold: Object.freeze({ main: "product", seam: false }),
  reseal: Object.freeze({ main: "product", seam: true }),
});
const STEADY_POINT = "after-maintenance-current";
/** S3v6 の P-4 (b): warm-up 5 (unused) and 30 measured processes per arm. */
// S2 追補 #9（DR-CP4-T-4 (a)）: readyProbe is the harness plan's (V-10 READY
// only in the steady state; never in graph-held-unusable or one-shot).
const ONE_SHOT = Object.freeze({
  kind: "one-shot",
  maintenanceSeam: false,
  warmUpInProcess: false,
  warmupProcessesPerArm: WARMUP_PER_ARM,
  measuredProcessesPerArm: MEASURED_PER_ARM,
  queriesPerProcess: 1,
  freshColdCopyPerProcess: true,
  readyProbe: false,
});
const inProcessSpec = (kind, maintenanceSeam, readyProbe) =>
  Object.freeze({
    kind,
    maintenanceSeam,
    warmUpInProcess: true,
    warmupProcessesPerArm: null,
    measuredProcessesPerArm: null,
    queriesPerProcess: "runner-procedure",
    freshColdCopyPerProcess: false,
    readyProbe,
  });
const MEASUREMENT_SPECS = Object.freeze({
  [STEADY_POINT]: inProcessSpec("steady-state", "runner-procedure", true),
  "while-graph-index-unusable": inProcessSpec(
    "graph-held-unusable",
    false,
    false,
  ),
  "while-chronicle-index-unusable": ONE_SHOT,
  "while-both-indexes-unusable": ONE_SHOT,
});
const B_SEAL_NOT_PUBLISHED = "blocked:b-seal-not-published";
const INDEX_STATE_HOLDING = "blocked:index-state-holding";
/** The names the master harness stops a setup with (DR-CP4-L-18, L-24, L-27). */
const SETUP_BLOCKED = Object.freeze([
  B_SEAL_NOT_PUBLISHED,
  "blocked:measurement-point-mismatch",
  INDEX_STATE_HOLDING,
  "blocked:pre-mutation-index-state",
  "blocked:maintenance-enabled",
  "blocked:index-build-timeout",
]);
/** DR-CP4-L-24: the closed set of reopen triggers and the limits. */
const REOPEN_TRIGGERS = Object.freeze([
  [
    "not-published",
    ["seal", "reseal"],
    120_000,
    "session-first-step",
    B_SEAL_NOT_PUBLISHED,
  ],
  [
    "sealed-then-dirty",
    ["seal", "reseal"],
    null,
    "session-first-step",
    "blocked:measurement-point-mismatch",
  ],
  [
    "maintenance-wait",
    ["author"],
    180_000,
    "maintenance-step",
    "blocked:maintenance-enabled",
  ],
]);
const REOPEN_LIMITS = Object.freeze({
  author: { openings: 3, reopens: 2, waitMs: 180_000 },
  ir: { openings: 1, reopens: 0, waitMs: null },
  seal: { openings: 3, reopens: 2, waitMs: 120_000 },
  hold: { openings: 1, reopens: 0, waitMs: null },
  reseal: { openings: 3, reopens: 2, waitMs: 120_000 },
});
const REOPEN_TOTAL = 9;
/** DR-CP4-L-27 (P-6). */
const INDEX_BUILD = Object.freeze({
  intervalMs: 500,
  waitMs: 120_000,
  reopenTrigger: false,
  onExhausted: "blocked:index-build-timeout",
  receiptField: "indexBuilds",
});
/** DR-CP4-L-24's receipt fields (and the closed outcome sets). */
const RECEIPT_FIELDS = Object.freeze({
  sealAttempts: ["sealed", "sealed-then-dirty", "not-published", "failed"],
  maintenanceAttempts: ["reached", "not-reached"],
  indexBuilds: null,
  preMutationIndexState: null,
  blocked: null,
  "readBack.relationStaleness": null,
  // S2 追補 #9（DR-CP4-T-1、T-3、T-5）: the complete setup's waits and the
  // feed and maintenance state at the measurement point and on the cold DB.
  freshnessSettles: null,
  "measurementPoint.freshnessFeed": null,
  "readBack.freshnessFeed": null,
  "readBack.maintenance": null,
});
/**
 * S2 追補 #9（DR-CP4-T-1、T-3、T-5。harness b0df31f0 と 354b1ba6）: the waits
 * for the product's Freshness (and, in a complete setup, maintenance) before
 * the measurement. The limits and intervals are the pinned harness's
 * constants (compared separately); the rest is fixed here.
 */
const FRESHNESS_SETTLE = Object.freeze({
  settledWhen: Object.freeze([
    "acknowledged>=head",
    "no-active-run",
    "no-reservation",
  ]),
  consumerId: "narrative-incremental-freshness/v1",
  readOnly: true,
  setup: Object.freeze({
    scope: "complete-setup",
    r5CheckWaits: false,
    beforeExecutors: Object.freeze(["chronicle-index", "measurement-point"]),
    sessionEnd: true,
    maintenanceStillAt: Object.freeze([
      "before:measurement-point",
      "session-end",
    ]),
    maintenanceStillWhen: Object.freeze([
      "no-running-run",
      "same-run-count-and-newest-created-at-on-two-consecutive-reads",
    ]),
    onExhausted: "[precheck] S1i freshness-settle",
    maintenanceOnExhausted: "disclosed",
    blocked: false,
    reopenTrigger: false,
    coldDbNotSettled: "[precheck] S1i freshness-settle",
    coldDbRunningRuns: "disclosed",
  }),
  measurement: Object.freeze({
    at: "open-process-after-open-before-negative-hook-declaration-raw-index",
    maintenanceStill: false,
    onExhausted: "index-build-timeout",
    onExhaustedConditions: Object.freeze({
      "while-variant": "blocked:index-state-holding",
      "other-variant": "hold-and-precheck",
    }),
    receiptFields: Object.freeze([
      "checks.process.freshnessSettle",
      "checks.d2Probes[].freshnessFeed",
    ]),
  }),
});
/** S2 追補 #9（DR-CP4-T-4 (a)）: V-10 READY only where B is current. */
const READY_PROBE = Object.freeze({
  receiptField: "checks.process.ownerReady",
  skipped: "not-applicable:<kind>",
  disclosure: Object.freeze(["skipped", "diagnostics"]),
  judged: false,
});
const READY_PROBE_WORDS = Object.freeze([
  "steady-state",
  "graph-held-unusable",
  "ownerReady.skipped",
  "fallback",
  "at-query",
  "閾値",
]);
const RECEIPT_BLOCKED_FIELDS = Object.freeze([
  "harnessId",
  "unmetPreconditions",
  "declaredPreconditions",
  "contractBlockedId",
  "hold",
]);
/** P-4 (b) applies to these variants only (validator: no other variant). */
const ONE_SHOT_VARIANTS = Object.freeze([
  "G-08/chronicle-index-unusable",
  "G-08/both-indexes-unusable",
]);
const SWITCHING_RETRY = Object.freeze({
  error: "WORKSPACE_SWITCHING",
  boundMs: 30_000,
  scope: "complete-setup",
  r5CheckRetries: false,
});
const SETUP_IR_AI_SETTINGS = Object.freeze({
  provider: "ollama",
  model: "product-journey-model",
  ollamaEndpoint: "http://127.0.0.1:11434",
});
const PROBE_SOURCES = Object.freeze([
  "readIndexMetadata",
  "query.initialSnapshot.indexUsable",
]);
const DECLARED_DEFAULT = Object.freeze({
  graph: "usable",
  chronicle: "usable",
});
/** The open points S2 hands to S3 without deciding them. */
const REVIEWER_QUESTIONS = Object.freeze([
  "P-4",
  "P-S2-2",
  "P-S2-3",
  "P-S2-4",
  "P-S2-5",
  // S2 追補 #4: the S3 7th review's questions (DR-CP4-O-6, O-7, O-14, P-1).
  "P-S2-6",
  "P-S2-7",
  "P-S2-8",
  "P-S2-9",
]);
/**
 * S2 追補 #4（DR-CP4-O-5 (xi)、O-14、O-15）: the K24-G01-N2〜N4 re-ask rule,
 * fixed before the observation. The limits and the gap are the harness's
 * constants (HARNESS_CONSTANTS), compared separately.
 */
const G01_RETRY = Object.freeze({
  decidedAnswers: ["graph-ready", "graph-unavailable"],
  unavailableReasons: "any",
  neutralAnswers: ["late", "no-answer", "fetch-failed"],
  retryOn: "neutral-only",
  decision: "first-decided",
  parentChild: "parent-if-decided-else-child",
  onExhausted: "inconclusive",
  cachedAnswers: "same-kind-rule",
  onConstantMismatch: "[precheck]",
  disclose: [
    "limit",
    "gapMs",
    "kind",
    "outcome",
    "parentOutcome",
    "childOutcome",
    "countersDelta",
    "cached",
    "durationMs",
    "rawTimes",
    "readyMarkTime",
  ],
  // S2 追補 #6（DR-CP4-Q-1 P3-2）: what the harness's askGraph keeps in
  // graphTries for each measured sample, disclosed only (never judged).
  graphTries: {
    sample: ["phase", "repeat", "decided", "tries", "discardedTakes", "retry"],
    perTry: ["kind", "outcome", "counters", "cached", "durationMs"],
    counters: ["begins", "cacheHits", "lateCached"],
    countersFrom: "reopened-measurement-main",
    discarded: [
      "reason",
      "parentOutcome",
      "childOutcome",
      "release",
      "indexUsable",
      "returnedSceneIds",
      "declaredSceneReturned",
    ],
    returnedSceneIds: "logical-parent-then-child-once",
    judged: false,
  },
});
/** S2 追補 #6: words retry.rule must carry for the P3-2 disclosure. */
const G01_RETRY_RULE_WORDS = Object.freeze([
  "graphTries",
  "counters",
  "cached",
  "returnedSceneIds",
  "declaredSceneReturned",
  "判定には使わない",
]);
/** S2 追補 #4（DR-CP4-O-6）: the control and the per-sample reading. */
const G01_REACHED_OUTCOMES = Object.freeze([
  "reached",
  "not-reached",
  "undetermined",
]);
const G01_CONTROL = Object.freeze({
  when: "after-declaration-before-mutation",
  workspace: "same",
  seed: "same",
  outcomes: G01_REACHED_OUTCOMES,
  graphInputs: ["codexEntries", "codexRelations", "pins"],
  bIndex: "disclose",
});
const G01_SAMPLE = Object.freeze({
  outcomes: G01_REACHED_OUTCOMES,
  reachedWhen: [
    "control-reached",
    "graph-inputs-digest-equal",
    "parent-fetch-seed-g01-orin",
    "decided-answer-graph-ready",
    "a3-eligible",
  ],
  notReachedWhen: [
    "seed-differs",
    "decided-answer-graph-unavailable",
    "a3-not-eligible",
  ],
  undeterminedWhen: [
    "control-not-reached",
    "graph-inputs-digest-differs",
    "no-decided-answer",
    "a3-unread",
  ],
});
/** S2 追補 #4（DR-CP4-O-6 (3)）: assessG01Negative's outcomes and reasons. */
const G01_VERDICT = Object.freeze({
  outcomes: ["blocked", "inconclusive", "not-established", "established"],
  inconclusiveReasons: [
    "sp-p1-recheck",
    "no-measured-graph-sample",
    "graph-requested-with-seed",
    "g01-mira-entity-reached:undetermined",
    "g01-mira-entity-reached",
  ],
});
/** S2 追補 #4（DR-CP4-O-3 (7)、O-9、O-17 (2)）: the reseal after the mutation. */
const G01_RESEAL = Object.freeze({
  reopenMain: true,
  sealRule: "new-b-generation-not-dirty",
  chronicle: "query-route-build-then-usable",
  blocked: ["b-seal-not-published", "chronicle-index-not-usable"],
  measurementPoint: "reopened-main-sealed-generation",
});
const G01_MUTATED = Object.freeze(["K24-G01-N2", "K24-G01-N3", "K24-G01-N4"]);
/** S2 追補 #4（DR-CP4-O-7）: the SP-P4 comparison rules. */
const SP_P4_RULE_IDS = Object.freeze(["current", "ir-complete-pairs"]);
/**
 * S2 追補 #6（DR-CP4-Q-1、P-S2-6 e、DR-CP4-P-3）: ir-complete-pairs as the
 * harness's #757 implements it. C1: only a sample whose IR is a `timeout`
 * with `deadlineExceeded` true, R+IR equal to R (same order) and no
 * supplement leaves the IR comparison (`spP4IrTimeoutExcluded`); a pair
 * leaves when either side does; any other non-ready sample is compared as
 * `current` does. C2: more than the harness's SP_P4_IR_TIMEOUT_LIMIT
 * excluded measured samples on a side of a variant, or no IR compared, is
 * `[precheck]`. The limit is the harness constant (checked separately), so
 * the earlier "no threshold" is withdrawn.
 * S2 追補 #8（DR-CP4-Q-2）: and more than SP_P4_IR_TIMEOUT_PAIR_LIMIT pairs of a
 * variant left without their IR (either side excluded) is `[precheck]`
 * (ir-timeout-pair-limit), which holds S3's C2 (at least 24 IR-compared pairs);
 * the per-side limit stays as the earlier check of one side.
 */
const SP_P4_IR_COMPLETE_PAIRS = Object.freeze({
  rFields: ["rSceneIds", "denseHitSceneIds", "sparseSceneIds"],
  irFields: ["rIrSceneIds", "irSupplementSceneId"],
  irExcludedWhen: {
    outcome: "timeout",
    deadlineExceeded: true,
    rIrSceneIds: "equals-rSceneIds-same-order",
    irSupplementSceneId: null,
  },
  otherNotReady: "compared-as-current",
  pairing: "same-repeat",
  pairExcludedWhen: "either-side-excluded",
  disclose: [
    "timeoutExcluded",
    "timeoutExcludedRate",
    "timeoutLimit",
    "timeoutPairLimit",
  ],
  discloseBy: ["side", "variant"],
  timeoutLimitConstant: "SP_P4_IR_TIMEOUT_LIMIT",
  timeoutLimitBy: ["side", "variant"],
  onOverTimeoutLimit: "[precheck]",
  timeoutPairLimitConstant: "SP_P4_IR_TIMEOUT_PAIR_LIMIT",
  timeoutPairLimitBy: ["variant"],
  onOverTimeoutPairLimit: "[precheck]",
  onNoIrCompared: "[precheck]",
  undefinedReasons: [
    "ir-timeout-limit",
    "ir-timeout-pair-limit",
    "no-ir-complete-pair",
  ],
});
/**
 * S2 追補 #6: words each condition's body must carry (C1 its four
 * conditions, C2 the limit's constant, C3 the switch and the pin).
 * S2 追補 #8（DR-CP4-Q-2）: C2 also carries the pair limit and S3's 24 pairs.
 */
const SP_P4_CONDITION_WORDS = Object.freeze({
  C1: [
    "timeout",
    "deadlineExceeded",
    "R+IR",
    "共通追加枠",
    "spP4IrTimeoutExcluded",
    "current と同じ",
  ],
  C2: [
    "SP_P4_IR_TIMEOUT_LIMIT",
    "SP_P4_IR_TIMEOUT_PAIR_LIMIT",
    "[precheck]",
    "組の上限",
    "組の最少 24",
  ],
  C3: ["SP_P4_COMPARISON_RULE", "43e3f40b", "sp-p4-ir-timeout"],
});
/**
 * S2 追補 #6: the receipt fields S2 reads for the rule (the harness's
 * spP4ReceiptDesign〔diagnostic-runner.mjs〕, spP4IrDisclosure,
 * assertSpP4WorkspaceStable and compareSpP4Variant〔frozen-diagnostics.mjs〕;
 * both at the sp-p4-ir-pair-limit pin since S2 追補 #8, which adds the pair
 * limit's fields, DR-CP4-Q-2).
 */
const SP_P4_RECEIPT_READING = Object.freeze({
  design: ["rule", "irTimeoutLimit", "irTimeoutPairLimit"],
  attemptIrMeasured: [
    "samples",
    "notReady",
    "timeoutExcluded",
    "timeoutExcludedRate",
    "timeoutLimit",
    "timeoutPairLimit",
  ],
  sideStability: [
    "rule",
    "measured",
    "irReady",
    "irNotReady",
    "irCompared",
    "irTimeoutExcluded",
    "irTimeoutLimit",
  ],
  comparison: [
    "irCompletePairs",
    "irComparedPairs",
    "irTimeouts",
    "irTimeoutLimit",
    "irExcludedPairs",
    "irTimeoutPairLimit",
    "undefinedReason",
  ],
  gate: "readSpP4Gate",
});
/**
 * S2 追補 #5（S3 の 7 回目、DR-CP4-P-2）: the P-S2-6 choices that let
 * ir-complete-pairs come into force. "a" is the proposal as written; "e" is
 * S3's conditional decision (C1〜C3), which needs the rule's conditions body
 * (written after the harness PR that wires C1〜C3 is merged; S2 追補 #6
 * wrote it after #757 and puts ir-complete-pairs in force).
 */
const SP_P4_SWITCH_CHOICES = Object.freeze({
  a: "as-proposed",
  e: "conditional",
});
const SP_P4_CONDITIONS = Object.freeze(["C1", "C2", "C3"]);
/** S2 追補 #4（DR-CP4-N-14 (2)）: the Gold receipt's priorAttempts. */
const PRIOR_ATTEMPTS = Object.freeze({
  priorAttempts: ["gold", "parity", "parityUsed", "thisAttempt"],
  attemptRow: [
    "runName",
    "runKind",
    "status",
    "startedAtUtc",
    "finishedAtUtc",
    "fileSha256",
  ],
  thisAttempt: ["runName", "fileSha256AtStart"],
});
/** S2 追補 #4（DR-CP4-O-5 (x)、O-10 P2-2）: what a trace's setup receipt is. */
const TRACE_SETUP_RECEIPT = Object.freeze({
  accepts: "frozen-g02-base-complete-setup",
  candidate: "same-commit-and-tree",
  rejects: [
    "other-case-or-variant",
    "r5-check-run",
    "sp-p4-branch",
    "dev-setup",
    "not-stops-at-complete",
    "blocked-without-harness-id",
    "other-candidate",
  ],
  onReject: "[precheck]",
});
/** S2 追補 #4（DR-CP4-O-2 (d)、O-5 (vi)）: the trace's R5 check. */
const TRACE_R5_CHECK = Object.freeze({
  check: "sp-p1-one-row",
  on: "trace-measurement-copy",
  onMismatch: "[precheck]",
});
/**
 * S3v6-P3-3: the exact S4 placeholder tokens of the draft (filling one and
 * dropping it from the list is S4b's work, never a draft's).
 */
const S4_PLACEHOLDERS = Object.freeze(
  [
    "k64-freeze-commit",
    "da1-acceptance-record",
    "g01-r-rir-mode",
    "trace-editing-commit",
    "trace-editing-sha256",
    "trace-browsing-commit",
    "trace-browsing-sha256",
    "k64-procedure-v1-commit",
    "k64-procedure-v1-sha256",
    "setup-addendum-commit",
    "setup-addendum-sha256",
    "declaration-addendum-commit",
    "declaration-addendum-sha256",
    "author-declaration-commit",
    "author-declaration-sha256",
    "seed-pin-addendum-commit",
    "seed-pin-addendum-sha256",
    "sp-synthetic-detection-record",
    "sp1-bytes-commit",
    "r5-check-record",
  ].map((name) => `S4:${name}`),
);

/**
 * S2 追補（DR-CP4-TR-8〜TR-10、TR-13。master 35537447 の trace-record.mjs と
 * trace-seal.mjs の写し）: how the trace runner reads the operations.
 */
const A3_READ = "once-right-after-parent-fetch-call-observed";
const START_SEAL_STATES = Object.freeze([
  "current",
  "dirty",
  "missing",
  "unknown",
]);
const MAINTENANCE_LAUNCH_ENV = Object.freeze([
  "CI",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER",
]);
const FORBIDDEN_SEAM_OPTIONS = Object.freeze([
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP",
  "GRIMODEX_PRODUCT_JOURNEY_NARRATIVE_FRESHNESS_HOLD_PROJECT_ID",
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID",
]);
const CONTENT_PROPOSAL_STATUS = "proposal-awaiting-s3";
/** S3v6-P2-3: this version's trace project (never swapped in this version). */
const TRACE_PROJECT = "G-02/base";

const TRACE_KINDS = Object.freeze({
  editing: Object.freeze({ file: OBSERVATION_PREP_FILES.traceEditing }),
  browsing: Object.freeze({ file: OBSERVATION_PREP_FILES.traceBrowsing }),
});
/** Product sources whose values a trace writes (K6/2 step 4, K6/4 変える点 12). */
const PRODUCT_SOURCES = Object.freeze({
  settings: "src/features/settings/types.ts",
  hook: "src/features/related-scenes/useNir1RelatedScenes.ts",
});
/**
 * cp4-decisions.md is an observation record; the S2 addendum may list it only
 * for the DR rows the integrator permitted (DR-CP4-L-1〜L-15, L-18〜L-24,
 * L-27, L-28, TR-1〜TR-14). S3v6-P3-1: every pattern is searched anywhere in the
 * path as written (absolute paths, `git show <ref>:…`, `./…`).
 */
const DECISIONS_RECORD = /nir1-lane-decisions\/cp4-decisions\.md/u;
const PERMITTED_DECISION_ROWS = new Set([
  ...Array.from({ length: 15 }, (_, at) => `DR-CP4-L-${at + 1}`),
  ...Array.from({ length: 7 }, (_, at) => `DR-CP4-L-${at + 18}`),
  "DR-CP4-L-27",
  "DR-CP4-L-28",
  ...Array.from({ length: 14 }, (_, at) => `DR-CP4-TR-${at + 1}`),
]);
const FORBIDDEN_READ = Object.freeze([
  /nir1-lane-decisions\/cq-deferred-decisions\.md/u,
  /nir1-lane-decisions\/rsj-/u,
  /nir1-lane-decisions\/rs-join-decisions\.md/u,
  /nir1-cp4-records\//u,
  /\.artifacts\//u,
  /\/tasks\/[^/\s]+\.output/u,
  /cp4-(?:task|hardening-task|s1f-task|k64-task)\.md/u,
]);
/**
 * S2 追補 #10（DR-CP4-P-6）: the trace runner's readings (traceRunnerReadings)
 * and the DR rows each copies.
 */
const TRACE_RUNNER_READING_ITEMS = Object.freeze([
  ["TP-1", ["DR-CP4-V-2 (1)", "DR-CP4-V-3 (B)"]],
  ["TP-2", ["DR-CP4-V-2 (2)", "DR-CP4-V-3 (C)"]],
  ["TP-3", ["DR-CP4-V-2 (3)"]],
  ["TP-4", ["DR-CP4-V-3 (A)", "DR-CP4-V-4 (B1)"]],
  ["TP-5", ["DR-CP4-V-4 (A)"]],
  ["TP-6", ["DR-CP4-V-4 (B2)"]],
  ["TP-7", ["DR-CP4-V-4"]],
]);
/** S2 追補 #10: the V-2〜V-4 pins the trace runner's readings bind. */
const TRACE_PATH_PIN_ROLES = Object.freeze([
  "v2-trace-probe-paths",
  "v4-trace-record-requery",
  "v4-followup-cancelled-match",
  "v4-trace-runner-quote-guard",
]);
/**
 * S2 追補 #10 (c): what the limits disclose — editing's lapse (i) from the
 * product side (DR-BSEAM-5) that can make (b) HOLD or [precheck], the rules
 * chosen after the first (invalid) trace, and the frozen Graph arm runs
 * before this freeze (the record's false is the contract's fixed value).
 */
const TRACE_RUNNER_LIMIT_WORDS = Object.freeze([
  "失効 (i)",
  "DR-BSEAM-5",
  "HOLD または [precheck]",
  "見た後",
  "成功の方向へ動く判定は無い",
  "graphRuntimeObservedBeforeFreeze",
  "8913f127",
  // S4 の独立レビュー（P2-1、P3-1、P3-2）: who decided each rule, DR-BSEAM-5's
  // own wording, and the validity direction (invalid → valid).
  "advisor に諮ったのは 2 つだけ",
  "別 lane への報告（未確認）",
  "invalid → valid",
  // contracts acc5ec71 の抜粋: the discovery failure is in the prep Main's
  // stderr (not the measurement Main's), with the extract as the source.
  "prep の Main の stderr",
  "acc5ec71c4af240b7455341e623f0ca9fb4df7b9",
]);
/** S3v6-P3-2: the readings integrator or builders chose after dev runs. */
const READINGS_AFTER_DEV = Object.freeze([
  "reopen-triggers",
  "sealed-then-dirty",
  "start-seal-two-reads",
  "maintenance-launch",
  "d2-variant-readings",
  "index-build-constants",
  "one-shot-measurement",
  // S4a(3)（S4 の最終関門の P2-2）: K24-G01 の聞き直しの上限 30→60（DR-CP4-O-14）
  // と、SP-P4 の ir-complete-pairs（C1〜C3）と K=6（DR-CP4-Q-1）。
  "g01-retry-limit",
  "sp-p4-ir-timeout-limit",
  // S4a'（S4 の凍結のやり直し、S2 追補 #9）: DR-CP4-T-1、T-3、T-5 の待ちと、
  // DR-CP4-T-4 (a) の V-10 READY の適用。
  "freshness-settle",
  "ready-probe-not-applicable",
  // S4a''（3 回目の凍結のやり直し、S2 追補 #10）: DR-CP4-V-3、V-4 の trace の規則
  // （最初の正式の trace と dev の稽古を見た後に integrator が決めた）。
  "trace-path-after-first-trace",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** UTF-16 length of the first non-empty line (the K2/4 excerpt rule). */
function firstLineUtf16(body) {
  const line = String(body)
    .split(/\r\n|\n|\r/u)
    .find((row) => row.trim().length > 0);
  return line === undefined ? 0 : line.length;
}

function fixtureIdErrors(errors, label, reference, fixture) {
  if (!isObject(reference)) {
    errors.push(`${label} reference is missing`);
    return;
  }
  if (reference.path !== fixture.path)
    errors.push(`${label}.path must be ${fixture.path}`);
  if (reference.sha256 !== fixture.sha256)
    errors.push(
      `${label}.sha256 must be the fixture's sha256 ${fixture.sha256}`,
    );
  if (reference.sha256 !== fixture.frozenSha256)
    errors.push(`${label}.sha256 must equal the freeze record's digest`);
  if (reference.fixtureId !== fixture.json.fixtureId)
    errors.push(`${label}.fixtureId must be ${fixture.json.fixtureId}`);
}

function freezeReferenceErrors(errors, reference, ctx) {
  if (
    !isObject(reference) ||
    reference.path !== NIR1_GRAPH_FREEZE_PATH ||
    reference.sha256 !== ctx.freeze.sha256
  )
    errors.push(
      `references.graphCaseFreeze must be ${NIR1_GRAPH_FREEZE_PATH} with its sha256 ${ctx.freeze.sha256}`,
    );
}

function contractErrors(errors, contract) {
  const k24 = CONTRACTS.k24;
  if (
    !isObject(contract) ||
    contract.draftRef !== k24.draftRef ||
    contract.path !== k24.path ||
    contract.sha256 !== k24.sha256 ||
    !same(contract.contractIds, k24.contractIds)
  )
    errors.push(
      `contract must be K2/4 (${k24.draftRef}, sha256 ${k24.sha256})`,
    );
}

function reviewErrors(errors, document, statuses, label) {
  if (!statuses.includes(document.status))
    errors.push(`${label}.status must be one of ${statuses.join(", ")}`);
  const frozen = document.status === statuses[1];
  if (!frozen) {
    if (document.review !== null)
      errors.push(`${label}.review must be null until the independent review`);
    return;
  }
  const review = document.review;
  if (
    !isObject(review) ||
    typeof review.reviewer !== "string" ||
    review.reviewer.trim() === "" ||
    typeof review.reviewedAt !== "string" ||
    !ISO_DATE.test(review.reviewedAt) ||
    typeof review.record !== "string" ||
    review.record.trim() === "" ||
    !HEX64.test(review.recordSha256 ?? "")
  )
    errors.push(
      `${label}.review must name the reviewer, date, record and record sha256 when frozen`,
    );
}

/**
 * The veto records K2/4 refuses for a declared Scene, recomputed from the
 * fixture: a secret foreshadow whose Scene fields refer to it, a POV on it, a
 * secret Chronicle (qualified IR) row on it.
 */
function vetoesFor(fixture, sceneId) {
  const vetoes = [];
  for (const foreshadow of fixture.foreshadows ?? []) {
    if (foreshadow.secret !== true) continue;
    for (const [key, value] of Object.entries(foreshadow)) {
      if (!/scene/iu.test(key)) continue;
      const values = Array.isArray(value) ? value : [value];
      if (values.includes(sceneId))
        vetoes.push(`secret foreshadow ${foreshadow.id} (${key})`);
    }
  }
  const scene = (fixture.scenes ?? []).find((row) => row.id === sceneId);
  for (const key of ["pov", "povEntityId", "storyTime", "storyTimeOrder"])
    if (scene && scene[key] !== undefined && scene[key] !== null)
      vetoes.push(`Scene ${key}`);
  for (const row of fixture.qualifiedIr ?? [])
    if (row.sceneId === sceneId && row.secret === true)
      vetoes.push("secret Chronicle event");
  for (const row of fixture.chronicleEvents ?? [])
    if (row.secret === true && JSON.stringify(row).includes(`"${sceneId}"`))
      vetoes.push(`secret Chronicle event ${row.id ?? ""}`);
  return vetoes;
}

function declarationRowErrors(errors, row, expected, fixture, excerpt) {
  const label = `${expected.caseId}/${expected.variantId}`;
  if (!isObject(row)) {
    errors.push(`declarations is missing ${label}`);
    return;
  }
  if (row.sceneId !== expected.sceneId)
    errors.push(`${label} must declare ${expected.sceneId} (K2/4 table)`);
  const scene = (fixture.scenes ?? []).find((s) => s.id === expected.sceneId);
  if (!scene) {
    errors.push(`${label}: ${expected.sceneId} is not a fixture Scene`);
    return;
  }
  if (
    row.readingOrder?.scene !== expected.scene ||
    row.readingOrder?.query !== expected.query ||
    scene.readingOrder !== expected.scene ||
    fixture.query?.readingOrder !== expected.query
  )
    errors.push(
      `${label} readingOrder must be ${expected.scene}/${expected.query}`,
    );
  if (!(scene.readingOrder < fixture.query.readingOrder))
    errors.push(`${label}: the declared Scene is not read before the query`);
  const vetoes = vetoesFor(fixture, expected.sceneId);
  if (vetoes.length > 0)
    errors.push(
      `${label}: veto records on ${expected.sceneId}: ${vetoes.join(", ")}`,
    );
  if (!Array.isArray(row.vetoRecords) || row.vetoRecords.length !== 0)
    errors.push(`${label}.vetoRecords must be empty (K2/4 table: none)`);
  const range = row.expectedExcerpt;
  if (
    range?.sceneId !== expected.sceneId ||
    range?.start !== 0 ||
    range?.end !== expected.end ||
    excerpt?.start !== 0 ||
    excerpt?.end !== expected.end ||
    firstLineUtf16(scene.body) !== expected.end
  )
    errors.push(
      `${label} expected excerpt must be [0,${expected.end}) (K2/4 table, the frozen expectation and the first non-empty line)`,
    );
}

function placeErrors(errors, place) {
  if (!isObject(place) || (place.choice !== "i" && place.choice !== "ii"))
    errors.push(
      "declarationPlace.choice must be i or ii (K2/4 測定の workspace)",
    );
  else if (typeof place.reason !== "string" || place.reason.trim() === "")
    errors.push("declarationPlace.reason is required");
}

function negativeErrors(errors, rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length) {
    errors.push(
      `diagnosticNegatives must be exactly ${expected.map((row) => row.id).join(", ")}`,
    );
    return;
  }
  expected.forEach((want, at) => {
    const row = rows[at];
    for (const [key, value] of Object.entries(want))
      if (row?.[key] !== value)
        errors.push(`diagnosticNegatives[${at}].${key} must be ${value}`);
    if (row?.countsInCaseJudgement !== false)
      errors.push(
        `diagnosticNegatives[${at}] is diagnostic only (countsInCaseJudgement false)`,
      );
    if (typeof row?.expectation !== "string" || row.expectation.trim() === "")
      errors.push(`diagnosticNegatives[${at}].expectation is required`);
    if (
      want.mutationAfterDeclaration !== null &&
      (typeof row?.measurementProcess !== "string" ||
        !row.measurementProcess.includes("nir1-graph-index-build"))
    )
      errors.push(
        `diagnosticNegatives[${at}].measurementProcess must reseal B through the journey seam (nir1-graph-index-build)`,
      );
    if (
      want.mutationAfterDeclaration !== null &&
      !same(row?.afterMutationChecks, [
        "sp-p1-recheck",
        "graph-requested-with-seed",
        "g01-mira-entity-reached",
      ])
    )
      errors.push(
        `diagnosticNegatives[${at}].afterMutationChecks must re-check the seed pin and record the seeded Graph reaching g01-mira-entity (S3v2-P3-3)`,
      );
    if (
      want.mutationAfterDeclaration !== null &&
      (typeof row?.inconclusiveWhen !== "string" ||
        row.inconclusiveWhen.trim() === "")
    )
      errors.push(`diagnosticNegatives[${at}].inconclusiveWhen is required`);
    if (
      RESTORE_MUTATIONS.has(want.mutationAfterDeclaration) &&
      row?.restorePath !== "scene-body-version"
    )
      errors.push(
        `diagnosticNegatives[${at}].restorePath must be scene-body-version (a project snapshot restore can drop the seed pin)`,
      );
    if (
      RESTORE_MUTATIONS.has(want.mutationAfterDeclaration) &&
      (typeof row?.beforeDeclaration !== "string" ||
        row.beforeDeclaration.trim() === "")
    )
      errors.push(
        `diagnosticNegatives[${at}].beforeDeclaration must prepare the body version to restore`,
      );
  });
}

/** Every key of `spec` holds the same value in `row` (key order free). */
const holds = (row, spec) =>
  isObject(row) &&
  Object.entries(spec).every(([key, value]) => same(row[key], value));

/**
 * S2 追補 #4（DR-CP4-O-6、O-14、O-15、O-5 (v)(vii)(viii)(xi)）: the reading
 * of K24-G01-N2〜N4 after the mutation — the reseal, the seed's source, the
 * control and the sample (reached / not-reached / undetermined), the re-ask
 * rule fixed before the observation, and the verdict. The limits, the gap
 * and the reseal bounds are the pinned harness's constants.
 */
function afterMutationReadingErrors(errors, addendum, ctx) {
  const readings = addendum.afterMutationReadings;
  const constants = ctx.harnessConstants;
  if (!isObject(readings)) {
    errors.push(
      "afterMutationReadings is required (S2 追補 #4、DR-CP4-O-6、O-14)",
    );
    return;
  }
  if (!isObject(constants))
    errors.push(
      "afterMutationReadings: the harness constants could not be read from the pinned bytes (HARNESS_CONSTANTS)",
    );
  const c = constants ?? {};
  if (!same(readings.appliesTo, G01_MUTATED) || !nonBlank(readings.status))
    errors.push(
      `afterMutationReadings must apply to ${G01_MUTATED.join(", ")} with its status (a proposal S3 confirms)`,
    );
  const reseal = readings.resealAfterMutation;
  if (
    !holds(reseal, G01_RESEAL) ||
    reseal.reopensMax !== c.B_SEAL_REOPENS ||
    reseal.waitMs !== c.B_SEAL_WAIT_MS ||
    !nonBlank(reseal.rule)
  )
    errors.push(
      "afterMutationReadings.resealAfterMutation must reopen the measurement Main until a new B generation is sealed and the Chronicle Index is usable, within the setup's B_SEAL_REOPENS and B_SEAL_WAIT_MS, measuring at the reopened Main's sealed generation (DR-CP4-O-3 (7)、O-9、O-17)",
    );
  const seed = readings.seedRequested;
  if (
    seed?.source !== "renderer-parent-fetch-seed" ||
    seed?.notFrom !== "native-begin-record" ||
    seed?.expected !== ctx.g01?.json?.entitySeed?.id ||
    !nonBlank(seed?.rule)
  )
    errors.push(
      "afterMutationReadings.seedRequested must read the seed from the renderer's parent fetch (never the Native begin record) and expect the fixture's seed (DR-CP4-O-5 (vii))",
    );
  const control = readings.control;
  if (
    !holds(control, G01_CONTROL) ||
    control.attemptLimit !== c.G01_CONTROL_ATTEMPTS ||
    control.gapMs !== c.G01_CONTROL_GAP_MS ||
    control.graphReadyWaitMs !== c.G01_GRAPH_READY_WAIT_MS ||
    !nonBlank(control.rule)
  )
    errors.push(
      `afterMutationReadings.control must be the same-workspace, same-seed control after the declaration and before the mutation, with the harness's limit ${c.G01_CONTROL_ATTEMPTS}, gap ${c.G01_CONTROL_GAP_MS} ms and graph-ready wait ${c.G01_GRAPH_READY_WAIT_MS} ms (DR-CP4-O-6 (1)、O-14)`,
    );
  const sample = readings.sample;
  if (
    !holds(sample, G01_SAMPLE) ||
    sample.attemptLimit !== c.G01_SAMPLE_ATTEMPTS ||
    sample.gapMs !== c.G01_CONTROL_GAP_MS ||
    !nonBlank(sample.rule)
  )
    errors.push(
      `afterMutationReadings.sample must judge reached / not-reached / undetermined by the control, the input digest, the parent's seed, the decided answer and A3, with the harness's limit ${c.G01_SAMPLE_ATTEMPTS} and gap ${c.G01_CONTROL_GAP_MS} ms (DR-CP4-O-6 (2))`,
    );
  const retry = readings.retry;
  if (
    !holds(retry, G01_RETRY) ||
    retry.gapMs !== c.G01_CONTROL_GAP_MS ||
    retry.controlLimit !== c.G01_CONTROL_ATTEMPTS ||
    retry.sampleLimit !== c.G01_SAMPLE_ATTEMPTS ||
    !nonBlank(retry.rule) ||
    !G01_RETRY_RULE_WORDS.every((word) => retry.rule.includes(word))
  )
    errors.push(
      "afterMutationReadings.retry must re-ask a neutral answer only, decide on the first decided answer (graph-ready or graph-unavailable of any reason; never a best-of), stop inconclusive at the harness's limits, disclose every try (each sample's graphTries with every try's counters and cached, and each discarded take's returnedSceneIds and declaredSceneReturned, never judged) and [precheck] on a limit or gap other than the constants (DR-CP4-O-5 (xi)、O-14、O-15、DR-CP4-Q-1 P3-2)",
    );
  if (
    !holds(readings.verdict, G01_VERDICT) ||
    !nonBlank(readings.verdict?.rule)
  )
    errors.push(
      "afterMutationReadings.verdict must be assessG01Negative's outcomes and inconclusive reasons (DR-CP4-O-6 (3))",
    );
  if (!nonBlank(readings.limits))
    errors.push(
      "afterMutationReadings.limits must disclose what the control does not observe",
    );
  for (const row of addendum.diagnosticNegatives ?? []) {
    if (!G01_MUTATED.includes(row?.id)) continue;
    if (row.afterMutationReading !== "afterMutationReadings")
      errors.push(
        `diagnosticNegatives ${row.id}.afterMutationReading must name afterMutationReadings (S2 追補 #4)`,
      );
  }
  const n3 = (addendum.diagnosticNegatives ?? []).find(
    (row) => row?.id === "K24-G01-N3",
  );
  if (
    n3?.beforeDeclarationWriter !== "createRevision" ||
    !String(n3?.beforeDeclaration ?? "").includes("createRevision")
  )
    errors.push(
      "diagnosticNegatives K24-G01-N3 must make the same-bytes version with the manual version writer createRevision (DR-CP4-O-5 (viii))",
    );
  // S2 追補 #5（S3 の 7 回目の P3-1）: N4 saves the draft body with the body
  // save writer and makes its version with createRevision, as the harness.
  const n4 = (addendum.diagnosticNegatives ?? []).find(
    (row) => row?.id === "K24-G01-N4",
  );
  const n4Text = String(n4?.beforeDeclaration ?? "");
  if (
    n4?.beforeDeclarationWriter !== "saveSceneContent-then-createRevision" ||
    !n4Text.includes("saveSceneContent") ||
    !n4Text.includes("createRevision")
  )
    errors.push(
      "diagnosticNegatives K24-G01-N4 must save the draft body with saveSceneContent and make its version with the manual version writer createRevision (S3 の 7 回目の P3-1)",
    );
}

function commonAddendumErrors(errors, addendum, ctx, schemaVersion) {
  if (!isObject(addendum)) {
    errors.push("addendum must be an object");
    return false;
  }
  if (addendum.schemaVersion !== schemaVersion)
    errors.push(`schemaVersion must be ${schemaVersion}`);
  // graphRuntimeObservedBeforeAuthoring: each addendum checks it (false, or
  // true only for rows of a case the freeze rebuilt after an observation).
  reviewErrors(errors, addendum, ADDENDUM_STATUSES, "addendum");
  contractErrors(errors, addendum.contract);
  freezeReferenceErrors(errors, addendum.references?.graphCaseFreeze, ctx);
  const values = addendum.declarationValues;
  for (const [key, value] of Object.entries(DECLARATION_VALUES))
    if (values?.[key] !== value)
      errors.push(`declarationValues.${key} must be ${value} (K2/4 v1 subset)`);
  placeErrors(errors, addendum.declarationPlace);
  for (const key of [
    "declarationTiming",
    "bSealProcedure",
    "afterDeclaration",
    "recordPreconditions",
    "cb4Inputs",
  ])
    if (typeof addendum[key] !== "string" || addendum[key].trim() === "")
      errors.push(`${key} is required`);
  if (
    typeof addendum.seedPinStepNote !== "string" ||
    !addendum.seedPinStepNote.includes(SEED_PIN_ADDENDUM_PATH)
  )
    errors.push(
      `seedPinStepNote must place the K2/4 declaration step after the SP/1 seed pin step (${SEED_PIN_ADDENDUM_PATH})`,
    );
  if (
    !Array.isArray(addendum.measurementWorkspaceCheck) ||
    addendum.measurementWorkspaceCheck.length < 3
  )
    errors.push("measurementWorkspaceCheck must list the K2/4 checks");
  return true;
}

/** G-01 addendum (K2/4 table row 1; fixture v1 unchanged). */
export function setupAddendumErrors(addendum, ctx) {
  const errors = [];
  if (
    !commonAddendumErrors(errors, addendum, ctx, "nir1-c-body-setup-addendum/1")
  )
    return errors;
  if (addendum.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  fixtureIdErrors(
    errors,
    "references.g01Fixture",
    addendum.references?.g01Fixture,
    ctx.g01,
  );
  const fixture = ctx.g01.json;
  const rows = addendum.declarations;
  if (!Array.isArray(rows) || rows.length !== 1)
    errors.push("declarations must be exactly the G-01 row of the K2/4 table");
  else {
    const expected = K24_TABLE[0];
    if (
      rows[0].caseId !== expected.caseId ||
      rows[0].variantId !== expected.variantId
    )
      errors.push("declarations[0] must be G-01/v1");
    declarationRowErrors(
      errors,
      rows[0],
      expected,
      fixture,
      fixture.expectations?.sceneExcerpt?.canonicalUtf16Range,
    );
  }
  const unchanged = addendum.unchanged;
  const expectations = fixture.expectations ?? {};
  if (
    unchanged?.querySceneId !== fixture.query?.sceneId ||
    unchanged?.seedEntityId !== fixture.entitySeed?.id ||
    !same(unchanged?.gold, { "g01-mira": 3 }) ||
    !same(unchanged?.expectations?.raw, expectations.raw) ||
    !same(unchanged?.expectations?.rPlusIr, expectations.rPlusIr) ||
    !same(
      unchanged?.expectations?.rPlusIrPlusGraph,
      expectations.rPlusIrPlusGraph,
    ) ||
    !same(
      unchanged?.expectations?.excerptRange,
      expectations.sceneExcerpt?.canonicalUtf16Range,
    ) ||
    !same(unchanged?.expectations?.metrics, expectations.metrics)
  )
    errors.push(
      "unchanged must copy the G-01 fixture v1 query, seed, Gold and expectations",
    );
  if (fixture.scenes?.find((s) => s.id === "g01-mira")?.gold !== 3)
    errors.push("the G-01 fixture no longer has g01-mira as Gold 3");
  negativeErrors(
    errors,
    addendum.diagnosticNegatives,
    G01_NEGATIVES.map(([id, declare, mutation]) => ({
      id,
      caseId: "G-01",
      variantId: "v1",
      declare,
      mutationAfterDeclaration: mutation,
    })),
  );
  afterMutationReadingErrors(errors, addendum, ctx);
  return errors;
}

/** Variants whose frozen expectations append a Graph-only Scene. */
function appendedVariants(ctx) {
  const rows = [];
  for (const caseId of Object.keys(ctx.fixtures).sort()) {
    for (const variant of ctx.fixtures[caseId].json.variants ?? []) {
      const appended =
        variant.expectations?.arms?.rPlusIrPlusGraph?.appendedSceneId ?? null;
      rows.push({
        key: `${caseId}/${variant.id}`,
        caseId,
        variant,
        appended,
      });
    }
  }
  return rows;
}

/** K2/4 :391 widened by the user's confirmation (K24_SCOPE_EXTENSION). */
function scopeExtensionErrors(errors, extension, table) {
  const want = K24_SCOPE_EXTENSION;
  const extended = table
    .filter((row) => row.extension)
    .map((row) => `${row.caseId}/${row.variantId}`);
  if (
    !isObject(extension) ||
    extension.decision !== want.decision ||
    !same(extension.variants, extended) ||
    !same(extension.variants, want.variants) ||
    extension.userConfirmation?.record !== want.userConfirmation.record ||
    extension.userConfirmation?.commit !== want.userConfirmation.commit ||
    extension.userConfirmation?.sha256 !== want.userConfirmation.sha256 ||
    typeof extension.rule !== "string" ||
    extension.rule.trim() === ""
  )
    errors.push(
      `contractScopeExtension must name ${want.decision}, the variants ${extended.join(", ")} and the user's confirmation (${want.userConfirmation.commit}, sha256 ${want.userConfirmation.sha256})`,
    );
}

/**
 * Rows of a case the freeze rebuilt after a Graph runtime observation
 * (freeze postObservationRevisions) are written after that observation: the
 * addendum says so (graphRuntimeObservedBeforeAuthoring true, the rows in
 * postObservationDeclarations) and copies every other row, the values and
 * the other negatives from the v1 addendum it supersedes, whose bytes it
 * binds (DR-CP4-G4-7). Without such rows it stays false.
 */
function postObservationAddendumErrors(errors, addendum, ctx) {
  const freeze = ctx.freeze.json ?? {};
  const rebuilt = new Set(
    freeze.graphRuntimeObservedBeforeFreeze === true
      ? (freeze.postObservationRevisions ?? []).map((row) => row.caseId)
      : [],
  );
  const rows = Array.isArray(addendum.declarations)
    ? addendum.declarations
    : [];
  const after = rows
    .filter((row) => rebuilt.has(row.caseId))
    .map((row) => `${row.caseId}/${row.variantId}`);
  if (after.length === 0) {
    if (addendum.graphRuntimeObservedBeforeAuthoring !== false)
      errors.push("graphRuntimeObservedBeforeAuthoring must be false");
    if (addendum.postObservationDeclarations !== undefined)
      errors.push(
        "postObservationDeclarations needs a row of a case the freeze rebuilt after an observation",
      );
    return;
  }
  if (addendum.graphRuntimeObservedBeforeAuthoring !== true)
    errors.push(
      `graphRuntimeObservedBeforeAuthoring must be true: ${after.join(", ")} belong to a case the freeze rebuilt after a Graph runtime observation`,
    );
  const declared = addendum.postObservationDeclarations;
  if (
    !isObject(declared) ||
    !same(declared.variants, after) ||
    typeof declared.rule !== "string" ||
    declared.rule.trim() === ""
  )
    errors.push(
      `postObservationDeclarations.variants must be ${after.join(", ")} with its rule`,
    );
  const v1 = ctx.supersededDeclarationAddendum;
  const supersedes = addendum.supersedes;
  if (
    !isObject(supersedes) ||
    supersedes.path !== DECLARATION_ADDENDUM_V1.path ||
    supersedes.sha256 !== DECLARATION_ADDENDUM_V1.sha256 ||
    !HEX40.test(String(supersedes.commit ?? "")) ||
    v1?.sha256 !== DECLARATION_ADDENDUM_V1.sha256
  ) {
    errors.push(
      `supersedes must bind ${DECLARATION_ADDENDUM_V1.path} (sha256 ${DECLARATION_ADDENDUM_V1.sha256}, its commit), whose bytes are unchanged`,
    );
    return;
  }
  const kept = (list) =>
    (Array.isArray(list) ? list : []).filter((row) => !rebuilt.has(row.caseId));
  if (!same(kept(rows), kept(v1.json.declarations)))
    errors.push(
      "declarations outside the rebuilt cases must be the v1 addendum's rows unchanged",
    );
  if (
    !same(kept(addendum.diagnosticNegatives), kept(v1.json.diagnosticNegatives))
  )
    errors.push(
      "diagnosticNegatives outside the rebuilt cases must be the v1 addendum's unchanged",
    );
}

/**
 * G-02 base, G-04 base (the widened fifth Scene), G-07 base, G-08 base-usable
 * and graph-recovered (K2/4 table).
 */
export function declarationAddendumErrors(addendum, ctx) {
  const errors = [];
  if (
    !commonAddendumErrors(
      errors,
      addendum,
      ctx,
      "nir1-c-body-declaration-addendum/1",
    )
  )
    return errors;
  const table = K24_TABLE.slice(1);
  const tableCases = [...new Set(table.map((row) => row.caseId))];
  for (const caseId of tableCases)
    fixtureIdErrors(
      errors,
      `references.fixtures.${caseId}`,
      addendum.references?.fixtures?.[caseId],
      ctx.fixtures[caseId],
    );
  if (
    !same(Object.keys(addendum.references?.fixtures ?? {}).sort(), tableCases)
  )
    errors.push(
      `references.fixtures must name exactly ${tableCases.join(", ")}`,
    );
  scopeExtensionErrors(errors, addendum.contractScopeExtension, table);
  postObservationAddendumErrors(errors, addendum, ctx);
  const rows = Array.isArray(addendum.declarations)
    ? addendum.declarations
    : [];
  const keys = rows.map((row) => `${row.caseId}/${row.variantId}`);
  const tableKeys = table.map((row) => `${row.caseId}/${row.variantId}`);
  for (const key of tableKeys)
    if (!keys.includes(key)) errors.push(`declarations is missing ${key}`);
  for (const key of keys)
    if (!tableKeys.includes(key))
      errors.push(
        `declarations has ${key}, which the K2/4 table does not declare`,
      );
  if (!same(keys, tableKeys))
    errors.push(
      `declarations must be ${tableKeys.join(", ")} in the K2/4 order`,
    );
  const appended = appendedVariants(ctx).filter(
    (row) => row.caseId !== "G-01" && row.appended !== null,
  );
  const appendedKeys = appended.map((row) => row.key);
  if (!same([...appendedKeys].sort(), [...tableKeys].sort()))
    errors.push(
      `the frozen variants that append a Scene (${appendedKeys.join(", ")}) differ from the K2/4 table`,
    );
  for (const expected of table) {
    const row = rows.find(
      (candidate) =>
        candidate.caseId === expected.caseId &&
        candidate.variantId === expected.variantId,
    );
    if (!row) continue;
    const fixture = ctx.fixtures[expected.caseId].json;
    const variant = (fixture.variants ?? []).find(
      (candidate) => candidate.id === expected.variantId,
    );
    if (
      variant?.expectations?.arms?.rPlusIrPlusGraph?.appendedSceneId !==
      expected.sceneId
    )
      errors.push(
        `${expected.caseId}/${expected.variantId}: the frozen appendedSceneId is not ${expected.sceneId}`,
      );
    declarationRowErrors(
      errors,
      row,
      expected,
      fixture,
      variant?.expectations?.addedScene?.sceneExcerpt?.canonicalUtf16Range,
    );
  }
  const without = appendedVariants(ctx)
    .filter((row) => row.caseId !== "G-01" && row.appended === null)
    .map((row) => row.key);
  if (!same(addendum.variantsWithoutDeclaration?.variants, without))
    errors.push(
      `variantsWithoutDeclaration.variants must be ${without.join(", ")}`,
    );
  const step = addendum.declarationStep;
  if (!isObject(step)) errors.push("declarationStep is required (K2/4 :407)");
  else {
    if (step.outsideSetupOrder !== true)
      errors.push("declarationStep.outsideSetupOrder must be true");
    if (step.after !== SETUP_ORDER_ANCHOR)
      errors.push(`declarationStep.after must be "${SETUP_ORDER_ANCHOR}"`);
    if (step.before !== "the first Graph arm query")
      errors.push("declarationStep.before must be the first Graph arm query");
    for (const key of [
      "setupTimelineStep",
      "measurementPoint",
      "fixtureChanged",
      "setupOrderChanged",
    ])
      if (step[key] !== false)
        errors.push(`declarationStep.${key} must be false`);
  }
  for (const caseId of tableCases) {
    const order = ctx.fixtures[caseId].json.measurementBoundary?.setupOrder;
    if (typeof order !== "string" || !order.includes(SETUP_ORDER_ANCHOR))
      errors.push(`${caseId} setupOrder no longer has the declaration anchor`);
  }
  if (
    addendum.graphRecovered
      ?.noDeclarationWriteBetweenMutationAndMeasurementPoint !== true
  )
    errors.push(
      "graphRecovered.noDeclarationWriteBetweenMutationAndMeasurementPoint must be true",
    );
  negativeErrors(
    errors,
    addendum.diagnosticNegatives,
    GRAPH_NEGATIVES.map(([id, caseId, variantId]) => ({
      id,
      caseId,
      variantId,
      declare: false,
      mutationAfterDeclaration: null,
    })),
  );
  return errors;
}

/** The operation list a trace's declared pattern expands to. */
export function expandTraceOperations(trace) {
  const counted = (index) => ({
    index,
    counted: true,
    querySceneId: trace.querySceneId,
    seed: trace.seed?.entityId,
    expectedMaterials: (trace.expectedMaterials ?? []).map(
      (row) => row.revisionId,
    ),
  });
  const ops = [
    {
      op: "open-scene",
      sceneId: trace.querySceneId,
      until: "cycle-end",
      query: counted(0),
    },
  ];
  for (let cycle = 1; cycle <= trace.cycles; cycle++) {
    if (trace.kind === "editing") {
      ops.push({
        op: "edit",
        via: "product-editor",
        sceneId: trace.querySceneId,
        action: cycle % 2 === 1 ? "append-suffix" : "remove-suffix",
      });
      ops.push({ op: "confirm-autosave-commit", sceneId: trace.querySceneId });
      ops.push({
        op: "product-query",
        trigger: "autosave-commit",
        until: "cycle-end",
        query: counted(cycle),
      });
    } else {
      ops.push({
        op: "navigate",
        sceneId: trace.browse?.otherSceneId,
        until: "query-published",
        query: {
          counted: false,
          querySceneId: trace.browse?.otherSceneId,
          seed: null,
          expectedMaterials: [],
        },
      });
      ops.push({
        op: "navigate",
        sceneId: trace.querySceneId,
        until: "cycle-end",
        query: counted(cycle),
      });
    }
  }
  return ops.map((op, seq) => ({ seq, ...op }));
}

const ALLOWED_OPS = Object.freeze({
  editing: new Set([
    "open-scene",
    "edit",
    "confirm-autosave-commit",
    "product-query",
  ]),
  browsing: new Set(["open-scene", "navigate"]),
});

/** K6/2 step 4 density and the forbidden operations, from the list itself. */
function operationErrors(errors, trace) {
  const ops = Array.isArray(trace.operations) ? trace.operations : [];
  const allowed = ALLOWED_OPS[trace.kind] ?? new Set();
  let since = [];
  let queries = 0;
  ops.forEach((op, at) => {
    if (op?.seq !== at) errors.push(`operations[${at}].seq must be ${at}`);
    if (/approv|prepare|decision|reject/iu.test(String(op?.op)))
      errors.push(
        `operations[${at}] is an approval operation (${op.op}); a trace never approves`,
      );
    else if (!allowed.has(op?.op))
      errors.push(
        `operations[${at}].op ${op?.op} is not a ${trace.kind} trace operation`,
      );
    if (op?.op === "edit" && op.via !== "product-editor")
      errors.push(`operations[${at}] edit must go through the product-editor`);
    if (trace.kind === "browsing" && /edit|commit|save/iu.test(String(op?.op)))
      errors.push(`operations[${at}]: a browsing trace must not edit or save`);
    if (op?.query?.counted === true) {
      if (trace.kind === "editing" && queries > 0) {
        const lastCommit = since.findLastIndex(
          (row) => row.op === "confirm-autosave-commit",
        );
        const edit = since.findIndex((row) => row.op === "edit");
        if (lastCommit < 0 || edit < 0 || edit > lastCommit)
          errors.push(
            `density: query ${queries} lacks an edit and its autosave commit before it`,
          );
        else if (lastCommit !== since.length - 1)
          errors.push(
            `density: query ${queries} has ${since
              .slice(lastCommit + 1)
              .map((row) => row.op)
              .join(",")} between its commit and the query`,
          );
        if (op.op !== "product-query" || op.trigger !== "autosave-commit")
          errors.push(
            `density: query ${queries} must be the product's own query on the autosave commit`,
          );
      }
      queries += 1;
      since = [];
      return;
    }
    since.push(op ?? {});
  });
  return queries;
}

function triggerValueErrors(errors, trace, ctx) {
  const triggers = trace.productTriggers ?? {};
  const settings = ctx.productSources?.[PRODUCT_SOURCES.settings] ?? "";
  const hook = ctx.productSources?.[PRODUCT_SOURCES.hook] ?? "";
  const autosave = /"editor\.autoSaveDelay":\s*"(\d+)"/u.exec(settings);
  if (
    triggers.autoSaveDelayMs?.source?.path !== PRODUCT_SOURCES.settings ||
    !autosave ||
    Number(autosave[1]) !== triggers.autoSaveDelayMs?.value
  )
    errors.push(
      `productTriggers.autoSaveDelayMs must be the product default editor.autoSaveDelay (${autosave?.[1] ?? "unreadable"})`,
    );
  const debounce = /const FETCH_DEBOUNCE_MS = (\d+);/u.exec(hook);
  if (
    triggers.fetchDebounceMs?.source?.path !== PRODUCT_SOURCES.hook ||
    !debounce ||
    Number(debounce[1]) !== triggers.fetchDebounceMs?.value
  )
    errors.push(
      `productTriggers.fetchDebounceMs must be the product FETCH_DEBOUNCE_MS (${debounce?.[1] ?? "unreadable"})`,
    );
  const expression = triggers.graphReadyFirstRefreshMs?.source?.expression;
  if (
    triggers.graphReadyFirstRefreshMs?.value !== 0 ||
    typeof expression !== "string" ||
    !hook.includes(expression)
  )
    errors.push(
      "productTriggers.graphReadyFirstRefreshMs must be the product's 0 ms first graph-ready refresh (DR-RSJ-6)",
    );
  if (!HEX40.test(triggers.build?.authoredAtBaseCommit ?? ""))
    errors.push("productTriggers.build.authoredAtBaseCommit must be a commit");
}

const nonBlank = (value) =>
  typeof value === "string" && value.trim().length > 0;

/** S2 追補: the runner's reading of a counted query (A3 and the start seal). */
function countedReadingErrors(errors, label, row) {
  if (
    !isObject(row) ||
    row.counted !== true ||
    row.a3Read !== A3_READ ||
    !nonBlank(row.startSeal)
  )
    errors.push(
      `${label} must be a counted query read with A3 ${A3_READ} and its start seal reads`,
    );
}

/**
 * S2 追補（DR-CP4-TR-8〜TR-10、TR-13）: the trace runner's reading of each
 * operation, the A3 timing, the start seal and the maintenance launch. The
 * operations themselves (and Q) stay as the template; a change to them is a
 * contentProposals entry awaiting S3, never applied here.
 */
function traceRunnerErrors(errors, trace) {
  const readings = trace.runnerReadings;
  if (!isObject(readings)) {
    errors.push("runnerReadings is required (S2 追補、TR-8〜TR-10)");
    return;
  }
  const ops = isObject(readings.operations) ? readings.operations : {};
  const expected = [...(ALLOWED_OPS[trace.kind] ?? [])].sort();
  if (!same(Object.keys(ops).sort(), expected))
    errors.push(
      `runnerReadings.operations must read exactly the ${trace.kind} operations ${expected.join(", ")}`,
    );
  countedReadingErrors(
    errors,
    "runnerReadings.operations.open-scene",
    ops["open-scene"],
  );
  if (trace.kind === "editing") {
    countedReadingErrors(
      errors,
      "runnerReadings.operations.product-query",
      ops["product-query"],
    );
    const edit = ops.edit ?? {};
    if (
      edit.via !== "product-editor" ||
      edit.caret !== "focus-editor-then-Control+End" ||
      edit.input !== "playwright-keyboard"
    )
      errors.push(
        "runnerReadings.operations.edit must type in the product editor after focus and Control+End (TR-8 (iv))",
      );
    const commit = ops["confirm-autosave-commit"] ?? {};
    if (
      commit.observe !== "subscribeSceneBodyCommits" ||
      commit.version !== "contentVersion" ||
      commit.initialVersion !== "getSceneVersion-before-trace" ||
      commit.harnessReadsDb !== false
    )
      errors.push(
        "runnerReadings.operations.confirm-autosave-commit must observe the product's body commit notification (contentVersion) without reading the DB (TR-8 (i))",
      );
  } else {
    const navigate = ops.navigate ?? {};
    countedReadingErrors(
      errors,
      "runnerReadings.operations.navigate.counted",
      navigate.counted,
    );
    const outside = navigate.outsideQ ?? {};
    if (
      outside.counted !== false ||
      outside.until !== "query-published" ||
      outside.onNonCompleted !== "return-without-waiting-for-publication" ||
      outside.receiptCountByReason !== true ||
      !nonBlank(outside.receiptRule)
    )
      errors.push(
        "runnerReadings.operations.navigate.outsideQ must end the seedless stay on publication, or return when the query ends other than completed (TR-8 (iii))",
      );
  }
  if (readings.a3?.readAt !== A3_READ)
    errors.push(`runnerReadings.a3.readAt must be ${A3_READ} (TR-8 (ii))`);
  const seal = readings.startSeal ?? {};
  if (
    !same(
      (seal.reads ?? []).map((row) => row?.id),
      ["before", "after"],
    ) ||
    (seal.reads ?? []).some((row) => !nonBlank(row?.at)) ||
    !same(seal.states, START_SEAL_STATES) ||
    !same(seal.usableStates, ["current"]) ||
    seal.onDisagreement !== "unknown" ||
    !nonBlank(seal.rule) ||
    seal.connection?.readOnly !== true ||
    seal.connection?.busyTimeoutMs !== 0 ||
    seal.insideTimingWindow !== false ||
    seal.receipt?.sealReadTimes !== true ||
    seal.receipt?.sealReadCount !== true ||
    seal.receipt?.cdpNow !== "disclose"
  )
    errors.push(
      "runnerReadings.startSeal must read the B seal twice (before the parent begin, after the parent is observed) on a read-only connection with busy timeout 0 outside the timing window, and count only current as U (disagreement is unknown) (TR-9, TR-13)",
    );
  // S3v6-P2-3: a setup that does not complete leaves (b) unmeasured; this
  // version never swaps the project.
  const failure = trace.setupFailure ?? {};
  if (
    failure.project !== TRACE_PROJECT ||
    `${trace.project?.caseId}/${trace.project?.variantId}` !== TRACE_PROJECT ||
    failure.projectSwapAllowed !== false ||
    failure.onNotSetupComplete?.b !== "未測定" ||
    failure.onNotSetupComplete?.cp4Availability !== "HOLD" ||
    !nonBlank(failure.rule)
  )
    errors.push(
      "setupFailure must leave (b) unmeasured and CP-4's availability HOLD when the project's setup does not complete, without swapping the project (S3v6-P2-3)",
    );
  // S2 追補 #4（DR-CP4-O-5 (vi)(x)、O-2 (d)(e)、O-10 P2-2）.
  if (failure.acceptsOnly !== "blocked-with-harness-id")
    errors.push(
      "setupFailure.acceptsOnly must be blocked-with-harness-id (a failure without the harness's blocked name is [precheck]; DR-CP4-O-5 (vi))",
    );
  if (
    !holds(readings.setupReceipt, TRACE_SETUP_RECEIPT) ||
    !nonBlank(readings.setupReceipt?.rule)
  )
    errors.push(
      "runnerReadings.setupReceipt must accept only the G-02 base complete setup run on the candidate's commit and tree, rejecting the R5 check run's and the SP-P4 branch's receipts (DR-CP4-O-5 (x))",
    );
  if (
    !holds(readings.r5Check, TRACE_R5_CHECK) ||
    !nonBlank(readings.r5Check?.rule)
  )
    errors.push(
      "runnerReadings.r5Check must be SP-P1's one-row check on the trace's measurement copy, [precheck] unless it matches (DR-CP4-O-5 (vi))",
    );
  if (String(trace.fixedBeforeObservation).includes("setup の検証を通らない"))
    errors.push(
      "fixedBeforeObservation must not rebuild the trace because the setup does not pass (S3v6-P2-3; setupFailure)",
    );
  const launch = readings.maintenanceLaunch ?? {};
  const forbidden = trace.maintenance?.forbiddenSeamOptions ?? [];
  if (!same(forbidden, FORBIDDEN_SEAM_OPTIONS))
    errors.push(
      `maintenance.forbiddenSeamOptions must be ${FORBIDDEN_SEAM_OPTIONS.join(", ")}`,
    );
  if (
    !same([...(launch.env ?? [])].sort(), [...MAINTENANCE_LAUNCH_ENV].sort()) ||
    launch.trigger !== "nir1-graph-index-build" ||
    launch.scope !== "trace-measurement-launch-only" ||
    launch.onForbiddenOption !== "[precheck]" ||
    !nonBlank(launch.record)
  )
    errors.push(
      `runnerReadings.maintenanceLaunch must add ${MAINTENANCE_LAUNCH_ENV.join(", ")} (trigger nir1-graph-index-build) to the trace measurement launch only, [precheck] on a forbidden seam option (TR-10)`,
    );
  if (!Array.isArray(trace.contentProposals))
    errors.push("contentProposals must be a list (empty when none)");
  for (const [at, row] of (trace.contentProposals ?? []).entries())
    if (
      !isObject(row) ||
      !nonBlank(row.id) ||
      !nonBlank(row.proposal) ||
      row.status !== CONTENT_PROPOSAL_STATUS
    )
      errors.push(
        `contentProposals[${at}] must be a proposal (${CONTENT_PROPOSAL_STATUS}) that S3 decides; the trace body stays unchanged`,
      );
}

/** One (b) trace file (K6/2 step 4 and (b) rule 1; K6/4 変える点 15). */
export function traceErrors(trace, ctx) {
  const errors = [];
  if (!isObject(trace)) return ["trace must be an object"];
  if (trace.schemaVersion !== "nir1-cp4-trace/1")
    errors.push("schemaVersion must be nir1-cp4-trace/1");
  if (!Object.hasOwn(TRACE_KINDS, trace.kind))
    return [...errors, "kind must be editing or browsing"];
  if (trace.traceId !== `nir1-cp4-trace-${trace.kind}/1`)
    errors.push(`traceId must be nir1-cp4-trace-${trace.kind}/1`);
  if (trace.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  reviewErrors(errors, trace, ADDENDUM_STATUSES, "trace");
  if (
    trace.contract?.k62?.sha256 !== CONTRACTS.k62.sha256 ||
    trace.contract?.k64?.sha256 !== CONTRACTS.k64.sha256
  )
    errors.push("contract must name the K6/2 and K6/4 bytes");
  const project = trace.project ?? {};
  const fixture = ctx.fixtures[project.caseId];
  if (!fixture) errors.push(`project.caseId ${project.caseId} is not a G-case`);
  else {
    if (project.fixturePath !== fixture.path)
      errors.push(`project.fixturePath must be ${fixture.path}`);
    if (
      project.fixtureSha256 !== fixture.sha256 ||
      project.fixtureSha256 !== fixture.frozenSha256
    )
      errors.push("project.fixtureSha256 must be the frozen fixture sha256");
    const variant = (fixture.json.variants ?? []).find(
      (row) => row.id === project.variantId,
    );
    if (!variant || variant.expectations?.graph?.status !== "available")
      errors.push(
        "project must be a variant whose Graph is expected available",
      );
    if (trace.querySceneId !== fixture.json.query?.sceneId)
      errors.push(
        `querySceneId must be the fixture query ${fixture.json.query?.sceneId}`,
      );
    if (trace.seed?.entityId !== fixture.json.manualSeed?.entityId)
      errors.push(
        `seed.entityId must be the fixture manual seed ${fixture.json.manualSeed?.entityId}`,
      );
    const materials = trace.expectedMaterials;
    if (!Array.isArray(materials) || materials.length === 0)
      errors.push("expectedMaterials must list at least one Revision");
    const graph = variant?.expectations?.graph ?? {};
    for (const material of materials ?? []) {
      const revision = (fixture.json.revisions ?? []).find(
        (row) => row.id === material.revisionId,
      );
      const qualified = (graph.qualifiedRevisionIds ?? []).includes(
        material.revisionId,
      );
      const edges = (material.edgeIds ?? []).filter(
        (edge) =>
          (graph.edgeIds ?? []).includes(edge) &&
          (revision?.relationIds ?? []).includes(edge),
      );
      if (
        !revision ||
        !qualified ||
        edges.length === 0 ||
        edges.length !== (material.edgeIds ?? []).length
      )
        errors.push(
          `expectedMaterials ${material.revisionId} must be a qualified Revision whose relations are expected Graph edges`,
        );
    }
    if (trace.kind === "browsing") {
      const other = trace.browse?.otherSceneId;
      if (!(fixture.json.scenes ?? []).some((row) => row.id === other))
        errors.push("browse.otherSceneId must be a fixture Scene");
      if ((fixture.json.pins ?? []).some((pin) => pin.sceneId === other))
        errors.push(
          "browse.otherSceneId must have no pin (its query carries no seed and is outside Q)",
        );
    }
  }
  if (project.seedPinAddendum !== SEED_PIN_ADDENDUM_PATH)
    errors.push(
      `project.seedPinAddendum must be ${SEED_PIN_ADDENDUM_PATH} (the product's seed comes from the SP/1 seed pin)`,
    );
  triggerValueErrors(errors, trace, ctx);
  if (
    trace.maintenance?.gate === undefined ||
    !String(trace.maintenance.gate).includes("nir1-graph-index-build")
  )
    errors.push(
      "maintenance.gate must open the B route through the B-ROUTE journey seam (trigger nir1-graph-index-build)",
    );
  if (!Number.isInteger(trace.cycles) || trace.cycles < 1)
    errors.push("cycles must be a positive integer");
  if (
    trace.stall?.attemptLimit !== STALL_ATTEMPT_LIMIT ||
    typeof trace.stall?.attemptRule !== "string" ||
    !trace.stall.attemptRule.includes("[precheck]")
  )
    errors.push(
      `stall.attemptLimit must be ${STALL_ATTEMPT_LIMIT} with a disclosed attempt rule ending in [precheck] (S3-P3-3)`,
    );
  if (
    trace.kind === "browsing" &&
    (typeof trace.browse?.stayEnd !== "string" ||
      trace.browse.stayEnd.trim() === "")
  )
    errors.push("browse.stayEnd must fix the end of the other Scene's stay");
  traceRunnerErrors(errors, trace);
  const queries = operationErrors(errors, trace);
  if (queries < TRACE_MIN_QUERIES)
    errors.push(`the trace has Q=${queries}, fewer than ${TRACE_MIN_QUERIES}`);
  if (trace.plannedQ !== queries)
    errors.push(`plannedQ must be the counted queries ${queries}`);
  if (!same(trace.operations, expandTraceOperations(trace)))
    errors.push(
      "operations differ from the declared template (open, then cycles of the fixed pattern)",
    );
  return errors;
}

/** The K6/4 procedure file draft (mirrors procedure-file.mjs of claude/nir1-cp4). */
export function procedureDraftErrors(procedure) {
  const errors = [];
  const top = [
    "schema",
    "version",
    "draft",
    "contract",
    "values",
    "conditions",
    "review",
  ];
  if (!isObject(procedure)) return ["procedure must be an object"];
  if (!same(Object.keys(procedure).sort(), [...top].sort()))
    errors.push(`procedure keys must be exactly ${top.join(", ")}`);
  if (procedure.schema !== "nir1-cp4-k64-procedure/1")
    errors.push("schema must be nir1-cp4-k64-procedure/1");
  if (procedure.version !== "draft-2" || procedure.draft !== true)
    errors.push("this file is the draft-2 version (draft true)");
  if (
    !same(procedure.contract, {
      draftRef: CONTRACTS.k64.draftRef,
      contractId: CONTRACTS.k64.contractId,
      sha256: CONTRACTS.k64.sha256,
    })
  )
    errors.push(`contract must be K6/4 (sha256 ${CONTRACTS.k64.sha256})`);
  const values = procedure.values ?? {};
  const keys = [...Object.keys(K64_VALUES), "r1r4WaitMs"];
  if (!same(Object.keys(values).sort(), [...keys].sort()))
    errors.push(`values keys must be exactly ${keys.join(", ")}`);
  for (const [key, value] of Object.entries(K64_VALUES))
    if (values[key] !== value)
      errors.push(`values.${key} must be the contract's ${value}`);
  if (
    !Number.isInteger(values.r1r4WaitMs) ||
    values.r1r4WaitMs <= 0 ||
    values.r1r4WaitMs > K64_WAIT_CEILING_MS
  )
    errors.push(
      `values.r1r4WaitMs must be a positive integer of at most ${K64_WAIT_CEILING_MS} ms (技術点 2)`,
    );
  if (
    !same(procedure.conditions, {
      follow: K64_FOLLOW,
      exclusions: K64_EXCLUSIONS,
    })
  )
    errors.push(
      "conditions must be F1..F7 and X1..X13 in the contract's order",
    );
  if (procedure.review !== null)
    errors.push("review must be null for a draft (it is never reviewed)");
  return errors;
}

function placeholderTokens(value, out = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("S4:")) out.add(value);
  } else if (Array.isArray(value))
    value.forEach((row) => placeholderTokens(row, out));
  else if (isObject(value))
    for (const inner of Object.values(value)) placeholderTokens(inner, out);
  return out;
}

function referenceErrors(errors, label, value, kind, frozen, expectedSha) {
  const placeholder = typeof value === "string" && PLACEHOLDER.test(value);
  const pattern = kind === "commit" ? HEX40 : HEX64;
  if (placeholder) {
    if (frozen) errors.push(`${label} is still the placeholder ${value}`);
    return;
  }
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(
      `${label} must be a ${kind === "commit" ? "40-hex commit" : "sha256"} or an S4 placeholder`,
    );
    return;
  }
  if (kind === "sha256" && expectedSha !== undefined && value !== expectedSha)
    errors.push(`${label} differs from the file's sha256 ${expectedSha}`);
}

/**
 * S2 追補（DR-CP4-L-4、frozen-setup-plan.mjs の段の組み立て）: each plan
 * variant's sessions, derived from the frozen fixture. Steps before the IR run
 * in `author`, the IR in `ir`, the B seal and the C build in `seal`; mutations
 * after the IR commit in `hold`, a usable declared graph adds `reseal` (B), a
 * usable declared chronicle a C query after the mutations.
 */
export function expectedVariantSessions(ctx) {
  return PLAN_VARIANTS.map((key) => {
    const [caseId, variantId] = key.split("/");
    const row = {
      variant: key,
      measurementPoint: STEADY_POINT,
      specKind: MEASUREMENT_SPECS[STEADY_POINT].kind,
      sessions: ["author", "ir", "seal"],
      measurementSession: "seal",
      bSealIn: ["seal"],
      chronicleQueryIn: ["seal"],
      mutations: [],
    };
    if (caseId === "G-01") return { ...row, measurementPoint: null };
    const fixture = ctx.fixtures?.[caseId]?.json ?? {};
    const variant =
      (fixture.variants ?? []).find((entry) => entry.id === variantId) ?? {};
    const point = variant.measurementPoint ?? STEADY_POINT;
    row.measurementPoint = point;
    row.specKind = MEASUREMENT_SPECS[point]?.kind ?? null;
    const mutations = new Map(
      (fixture.mutations ?? []).map((entry) => [entry.id, entry]),
    );
    const applies = (entry) =>
      !Array.isArray(entry?.onlyInVariants) ||
      entry.onlyInVariants.includes(variantId);
    const timeline = (fixture.setupTimeline ?? []).filter(
      (step) => step.kind !== "mutation" || applies(mutations.get(step.id)),
    );
    const irAt = timeline.findIndex((step) => step.kind === "qualified-ir");
    const mutationRows = (steps, session) =>
      steps
        .filter((step) => step.kind === "mutation")
        .map((step) => ({
          id: step.id,
          kind: mutations.get(step.id)?.kind ?? null,
          session,
        }));
    const after = mutationRows(timeline.slice(irAt + 1), "hold");
    row.mutations = [
      ...mutationRows(timeline.slice(0, Math.max(irAt, 0)), "author"),
      ...after,
    ];
    if (after.length > 0) {
      const state = variant.indexState ?? {};
      row.sessions.push("hold");
      if (state.graph === "usable") {
        row.sessions.push("reseal");
        row.bSealIn.push("reseal");
      }
      if (state.chronicle === "usable")
        row.chronicleQueryIn.push(state.graph === "usable" ? "reseal" : "hold");
      row.measurementSession = row.sessions.at(-1);
    }
    return row;
  });
}

function fixtureMutationIds(ctx, caseId, kind) {
  return (ctx.fixtures?.[caseId]?.json?.mutations ?? [])
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.id);
}

/** S2 追補: setupReadings (DR-CP4-L-11 (1)〜(10) and L-12). */
function setupReadingErrors(errors, readings, ctx) {
  if (!isObject(readings)) {
    errors.push("setupReadings is required (S2 追補、DR-CP4-L-11)");
    return;
  }
  const items = Array.isArray(readings.items) ? readings.items : [];
  if (
    !same(
      items.map((row) => [row?.id, row?.l11]),
      SETUP_READING_ITEMS,
    ) ||
    items.some((row) => !nonBlank(row?.reading) || !nonBlank(row?.decision))
  )
    errors.push(
      `setupReadings.items must be ${SETUP_READING_ITEMS.map(([id, l11]) => `${id} ${l11}`).join(", ")}, each with its decision and reading`,
    );
  if (!same(readings.sessions, SETUP_SESSIONS))
    errors.push(
      "setupReadings.sessions must be author/ir/seal/hold/reseal with their Main and seam (DR-CP4-L-4)",
    );
  const setupIrSessions = Object.entries(SETUP_SESSIONS)
    .filter(([, row]) => row.main === "setup-ir")
    .map(([label]) => label);
  const main = readings.setupMain ?? {};
  if (
    main.output !== "dist-electron/main-setup-ir.cjs" ||
    main.tableLanguage !== "cp4-setup-ir" ||
    !same(main.env, { GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1" }) ||
    !same(main.sessions, setupIrSessions) ||
    main.shaPerRun !== false ||
    main.receiptField !== "setupMain" ||
    !Array.isArray(main.admission) ||
    main.admission.length === 0
  )
    errors.push(
      "setupMain: setupReadings.setupMain must be the setup-only Main of the ir session only, with its admission and run-independent bytes (DR-CP4-L-1, L-18 P3 (a))",
    );
  const ir = readings.irPath ?? {};
  if (
    !same(ir.mainSessions, setupIrSessions) ||
    !same(ir.aiSettings, SETUP_IR_AI_SETTINGS) ||
    ir.contextSetCount !== 2 ||
    !same(ir.contextSet, ["cluster", "observation"]) ||
    !nonBlank(ir.activeWorkspacePath)
  )
    errors.push(
      "setupReadings.irPath must run in the ir session with the 24-case AI settings, set the active workspace path and check the two-item contextSet (DR-CP4-L-2)",
    );
  const typeEdit = readings.typeEdit ?? {};
  if (
    !same(
      [typeEdit.mutation],
      fixtureMutationIds(ctx, "G-02", "codex-relation-type-edit"),
    ) ||
    typeEdit.executor !== "codex-relation-type-edit" ||
    typeEdit.firstMode !== "same-id" ||
    typeEdit.fallbackMode !== "new-id" ||
    typeEdit.receiptField !== "logicalToRuntime.relationRecreations"
  )
    errors.push(
      "setupReadings.typeEdit must delete and recreate the G-02 Relation with the same runtime ID first (new ID when refused) (DR-CP4-L-3)",
    );
  const withdrawal = readings.irWithdrawal ?? {};
  if (
    !same(
      [withdrawal.mutation],
      fixtureMutationIds(ctx, "G-08", "ir-approval-withdrawal"),
    ) ||
    withdrawal.decision !== "deferred" ||
    withdrawal.receiptField !== "logicalToRuntime.decisions"
  )
    errors.push(
      "setupReadings.irWithdrawal must withdraw the G-08 IR approval with a deferred Decision (DR-CP4-L-5)",
    );
  const rows = Array.isArray(readings.variantSessions)
    ? readings.variantSessions
    : [];
  const expected = expectedVariantSessions(ctx);
  if (rows.length !== expected.length)
    errors.push(
      `setupReadings.variantSessions must list the ${expected.length} plan variants`,
    );
  for (const want of expected) {
    const row = rows.find((entry) => entry?.variant === want.variant);
    if (!same(row, want))
      errors.push(
        `setupReadings.variantSessions ${want.variant} must be ${JSON.stringify(want)} (derived from the frozen fixture)`,
      );
  }
  const probe = readings.probe ?? {};
  if (
    !same(probe.sources, PROBE_SOURCES) ||
    probe.readOnly !== true ||
    !same(probe.defaultDeclared, DECLARED_DEFAULT) ||
    !nonBlank(probe.graph) ||
    !nonBlank(probe.chronicle)
  )
    errors.push(
      "setupReadings.probe must be the read-only Index metadata and the query's initialSnapshot.indexUsable (DR-CP4-L-4)",
    );
  const blocked = (readings.blocked ?? []).map((row) => row?.name);
  if (
    !same([...blocked].sort(), [...SETUP_BLOCKED].sort()) ||
    (readings.blocked ?? []).some((row) => !nonBlank(row?.when))
  )
    errors.push(
      `setupReadings.blocked must name ${SETUP_BLOCKED.join(", ")} with when each applies`,
    );
  if (!same(readings.measurementSpecs, MEASUREMENT_SPECS))
    errors.push(
      "setupReadings.measurementSpecs must be steady-state, graph-held-unusable and one-shot (fresh cold copy, one query, no warm-up, no seam) per measurementPoint (DR-CP4-L-4)",
    );
  reopenErrors(errors, readings);
  freshnessSettleErrors(errors, readings, ctx);
  readyProbeErrors(errors, readings, ctx);
  const pins = readings.source?.pins ?? [];
  // S2 追補 #4: role, commit, check and the exact paths of each pin.
  const heldPaths = pins.flatMap((row) =>
    (row?.files ?? []).map((file) => file?.path),
  );
  if (
    !same(
      pins.map((row) => [
        row?.role,
        row?.commit,
        row?.check,
        (row?.files ?? []).map((file) => file?.path),
      ]),
      SOURCE_PINS.map((pin) => [pin.role, pin.commit, pin.check, pin.paths]),
    ) ||
    pins.some((row) =>
      (row.files ?? []).some(
        (file) => !nonBlank(file?.path) || !HEX64.test(file?.sha256 ?? ""),
      ),
    ) ||
    new Set(heldPaths).size !== heldPaths.length ||
    !nonBlank(readings.source?.pinRule)
  )
    errors.push(
      `setupReadings.source.pins must be the master commits ${SOURCE_PINS.map((pin) => `${pin.role} ${pin.commit.slice(0, 8)} (${pin.check}${pin.paths.length > 0 ? `, ${pin.paths.length} files` : ""})`).join(", ")} with their files' sha256, no path held twice (S3v6-P2-1、S2 追補 #4)`,
    );
  // S2 追補 #7: the closure files no pin holds are exactly the shared CI and
  // product files, each with its reason, and none of them is pinned.
  const exclusions = readings.source?.closureExclusions;
  if (
    !Array.isArray(exclusions) ||
    !same(
      exclusions.map((row) => row?.path),
      EVAL_CLOSURE_EXCLUSIONS,
    ) ||
    exclusions.some(
      (row) => !nonBlank(row?.reason) || !isSharedClosureBoundary(row.path),
    ) ||
    heldPaths.some((file) => EVAL_CLOSURE_EXCLUSIONS.includes(file))
  )
    errors.push(
      `setupReadings.source.closureExclusions must be ${EVAL_CLOSURE_EXCLUSIONS.join(", ")} (shared CI and product files, each with its reason, none pinned; S2 追補 #7)`,
    );
  // S2 追補 #4: each bytes pin's sha256 is the pinned commit's bytes and
  // every pin's commit is an ancestor of the record's HEAD (git; skipped in
  // a shallow clone, always checked by the formal gate).
  if (ctx.sourcePinGit)
    errors.push(
      ...sourcePinGitErrors(pins, ctx.sourcePinGit.head, ctx.sourcePinGit),
    );
  // S2 追補 #4／#6: the harness constants S2 copies are read from the pinned
  // bytes of the pin that holds each file (S4 の最終関門の P3-3: and the
  // K64_FREEZE.freezeCommit source).
  // S2 追補 #9: and the readyProbeOf source (frozen-k64-plan.mjs).
  for (const source of [
    ...(ctx.harnessConstantSources ?? []),
    ...(ctx.harnessK64Freeze ? [ctx.harnessK64Freeze.source] : []),
    ...(ctx.harnessReadyProbe ? [ctx.harnessReadyProbe.source] : []),
  ]) {
    const role = harnessPinOf(source.path)?.role;
    const held = pins
      .find((row) => row?.role === role)
      ?.files?.find((file) => file?.path === source.path);
    if (held?.sha256 !== source.sha256)
      errors.push(
        `setupReadings.source.pins ${String(role)}: ${source.path} must be the bytes the harness constants were read from (${source.sha256})`,
      );
  }
  const build = readings.indexBuild ?? {};
  if (Object.entries(INDEX_BUILD).some(([key, value]) => build[key] !== value))
    errors.push(
      `setupReadings.indexBuild must poll every ${INDEX_BUILD.intervalMs} ms for ${INDEX_BUILD.waitMs} ms, never reopen, then ${INDEX_BUILD.onExhausted} (DR-CP4-L-27)`,
    );
  const fields = readings.receiptFields ?? {};
  if (
    !same(Object.keys(fields).sort(), Object.keys(RECEIPT_FIELDS).sort()) ||
    Object.entries(RECEIPT_FIELDS).some(
      ([key, outcomes]) =>
        outcomes !== null && !same(fields[key]?.outcomes, outcomes),
    ) ||
    !same(fields.blocked?.fields, RECEIPT_BLOCKED_FIELDS)
  )
    errors.push(
      `setupReadings.receiptFields must be ${Object.keys(RECEIPT_FIELDS).join(", ")} with the closed outcome sets (DR-CP4-L-24)`,
    );
  const judgement = readings.blockedCaseJudgement ?? {};
  const judged = (judgement.rows ?? []).map((row) => [
    row?.harnessId,
    row?.condition,
    row?.g01,
    row?.graphCases,
  ]);
  // S2 追補 #3（DR-CP4-L-28）: the table is the pinned harness's
  // BLOCKED_CONTRACT_TABLE, row by row; maintenance-enabled only from P-5.
  const harness = ctx.harnessBlockedTable;
  const source = ctx.harnessBlockedTableSource;
  const pinned = pins
    .find((row) => row?.role === BLOCKED_TABLE_SOURCE.role)
    ?.files?.find((file) => file?.path === BLOCKED_TABLE_SOURCE.path);
  if (!Array.isArray(harness) || !source)
    errors.push(
      `setupReadings.blockedCaseJudgement: the harness's BLOCKED_CONTRACT_TABLE could not be read from ${BLOCKED_TABLE_SOURCE.path} at ${BLOCKED_TABLE_SOURCE.commit}`,
    );
  else if (pinned?.sha256 !== source.sha256)
    errors.push(
      `setupReadings.source.pins ${BLOCKED_TABLE_SOURCE.role}: ${BLOCKED_TABLE_SOURCE.path} must be the bytes the BLOCKED_CONTRACT_TABLE was read from (${source.sha256})`,
    );
  const wanted = (harness ?? []).map((row) => [
    row.harnessId,
    row.condition,
    row.g01,
    row.graphCases,
  ]);
  const toMaintenance = judged
    .filter((row) => row.includes("blocked:maintenance-enabled"))
    .map((row) => `${row[0]}/${row[1]}`);
  if (
    judgement.receiptName !== "harness-id" ||
    !Array.isArray(harness) ||
    !same(judged, wanted) ||
    !same(toMaintenance, ["maintenance-enabled/maintenance-wait-exhausted"]) ||
    (judgement.rows ?? []).some(
      (row) =>
        row?.harnessAgrees !== true ||
        !nonBlank(row?.harnessContractBlockedId) ||
        !nonBlank(row?.source),
    )
  )
    errors.push(
      "setupReadings.blockedCaseJudgement must equal the pinned harness's BLOCKED_CONTRACT_TABLE row by row (DR-CP4-L-28; harness names in the receipt, the maintenance-enabled precondition only from the P-5 maintenance wait), every row harnessAgrees true",
    );
  if (!same(readings.switchingRetry, SWITCHING_RETRY))
    errors.push(
      "setupReadings.switchingRetry must retry WORKSPACE_SWITCHING for 30 s in a complete setup only (not in the R5 check run)",
    );
  if (
    readings.invariantCheck?.after !== "first-typed-revision" ||
    readings.invariantCheck?.checkedAt !== "last-session-end"
  )
    errors.push(
      "setupReadings.invariantCheck must compare the invariants after the first typed Revision at the last session's end",
    );
}

/**
 * S2 追補 #2（S3v6 の P-4 (b)、C1〜C5）: the one-shot variants keep warm-up 5
 * and 30 measured per arm, as fresh processes; only they are listed, and the
 * one-shot variants are exactly those the fixtures' measurementPoint make
 * one-shot.
 */
function oneShotPlanErrors(errors, prep, ctx) {
  const derived = expectedVariantSessions(ctx)
    .filter((row) => row.specKind === "one-shot")
    .map((row) => row.variant);
  if (!same(derived, ONE_SHOT_VARIANTS))
    errors.push(
      `the one-shot variants derived from the fixtures must be ${ONE_SHOT_VARIANTS.join(", ")}`,
    );
  const exceptions = prep.samplePlan?.variantExceptions;
  const row = Array.isArray(exceptions) ? exceptions[0] : undefined;
  if (
    !Array.isArray(exceptions) ||
    exceptions.length !== 1 ||
    !same(row?.variants, ONE_SHOT_VARIANTS) ||
    row.kind !== "one-shot" ||
    row.warmupProcessesPerArm !== WARMUP_PER_ARM ||
    row.warmupUsed !== false ||
    row.measuredProcessesPerArm !== MEASURED_PER_ARM ||
    row.queriesPerProcess !== 1 ||
    row.freshColdCopyPerProcess !== true ||
    row.maintenanceSeam !== false ||
    row.receiptLabel !== "one-shot（index-state-holding）" ||
    row.excludeFromDefaultPools !== false ||
    row.preMeasurementQueries !== false ||
    !same(row.conditions, ["C1", "C2", "C3", "C4", "C5"]) ||
    ["order", "receiptLabelRule", "poolsRule", "preMeasurementRule"].some(
      (key) => !nonBlank(row[key]),
    )
  )
    errors.push(
      `samplePlan.variantExceptions must list only ${ONE_SHOT_VARIANTS.join(", ")} as one-shot processes (warm-up ${WARMUP_PER_ARM} unused and ${MEASURED_PER_ARM} measured per arm, one query on a fresh cold copy, AB/BA over processes, labelled one-shot（index-state-holding）, kept in the default pools, no query before the measurement) (S3v6 P-4 C1〜C5)`,
    );
  const parity = prep.d10?.parity?.oneShot ?? {};
  if (
    !same(parity.variants, ONE_SHOT_VARIANTS) ||
    parity.warmupProcessesPerArm !== WARMUP_PER_ARM ||
    parity.measuredProcessesPerArm !== MEASURED_PER_ARM ||
    parity.queriesPerProcess !== 1 ||
    parity.freshColdCopyPerProcess !== true ||
    !nonBlank(parity.run)
  )
    errors.push(
      "d10.parity.oneShot must take the unrestricted run of the one-shot variants in the same one-shot form (S3v6 P-4 C4)",
    );
}

/**
 * S2 追補 #9（DR-CP4-T-1、T-3、T-5）: the Freshness waits — the settled
 * condition, the complete setup's points (and the maintenance stillness),
 * the measurement process's point and its mapping to the blocked table, with
 * the limits and intervals the pinned harness's constants.
 */
function freshnessSettleErrors(errors, readings, ctx) {
  const settle = readings.freshnessSettle;
  const c = ctx.harnessConstants ?? {};
  const setup = settle?.setup ?? {};
  const measurement = settle?.measurement ?? {};
  const fixed = (row, spec) =>
    Object.entries(spec).every(([key, value]) => same(row?.[key], value));
  const {
    setup: setupSpec,
    measurement: measurementSpec,
    ...top
  } = FRESHNESS_SETTLE;
  if (
    !isObject(settle) ||
    !fixed(settle, top) ||
    !nonBlank(settle.decision) ||
    !nonBlank(settle.settledRule) ||
    !fixed(setup, setupSpec) ||
    !Number.isInteger(c.FRESHNESS_SETTLE_WAIT_MS) ||
    !Number.isInteger(c.FRESHNESS_SETTLE_INTERVAL_MS) ||
    setup.waitMs !== c.FRESHNESS_SETTLE_WAIT_MS ||
    setup.intervalMs !== c.FRESHNESS_SETTLE_INTERVAL_MS ||
    !same(setup.harnessConstants, [
      "FRESHNESS_SETTLE_WAIT_MS",
      "FRESHNESS_SETTLE_INTERVAL_MS",
    ]) ||
    !nonBlank(setup.rule) ||
    !fixed(measurement, measurementSpec) ||
    !Number.isInteger(c.RUN_FRESHNESS_SETTLE_LIMIT_MS) ||
    !Number.isInteger(c.RUN_FRESHNESS_SETTLE_INTERVAL_MS) ||
    measurement.waitMs !== c.RUN_FRESHNESS_SETTLE_LIMIT_MS ||
    measurement.intervalMs !== c.RUN_FRESHNESS_SETTLE_INTERVAL_MS ||
    !same(measurement.harnessConstants, [
      "FRESHNESS_SETTLE_LIMIT_MS",
      "FRESHNESS_SETTLE_INTERVAL_MS",
    ]) ||
    !nonBlank(measurement.rule)
  )
    errors.push(
      `setupReadings.freshnessSettle must wait read-only for the product's Freshness (cursor at the feed head, no run, no reservation) in a complete setup before chronicle-index and measurement-point and at each session's end (maintenance still before measurement-point and at the end; ${String(c.FRESHNESS_SETTLE_WAIT_MS)} ms / ${String(c.FRESHNESS_SETTLE_INTERVAL_MS)} ms, [precheck] when the Freshness runs out, the maintenance disclosed) and in each measurement process before the declaration step (${String(c.RUN_FRESHNESS_SETTLE_LIMIT_MS)} ms / ${String(c.RUN_FRESHNESS_SETTLE_INTERVAL_MS)} ms, index-build-timeout when it runs out), with the pinned harness's constants (DR-CP4-T-1、T-3、T-5)`,
    );
  // The measurement's exhaustion is the existing index-build-timeout rows of
  // the blocked table (DR-CP4-L-28 (8)(9)); the table gains no row.
  for (const [condition, judged] of Object.entries(
    FRESHNESS_SETTLE.measurement.onExhaustedConditions,
  )) {
    const row = (ctx.harnessBlockedTable ?? []).find(
      (entry) =>
        entry.harnessId === "index-build-timeout" &&
        entry.condition === condition,
    );
    if (row?.graphCases !== judged)
      errors.push(
        `setupReadings.freshnessSettle.measurement: the blocked table's index-build-timeout/${condition} must be ${judged} (DR-CP4-L-28)`,
      );
  }
}

/**
 * S2 追補 #9（DR-CP4-T-4 (a)）: V-10 READY applies to the kinds the pinned
 * harness plan's readyProbeOf names (the steady state); graph-held-unusable
 * and one-shot disclose the non-application, never judged.
 */
function readyProbeErrors(errors, readings, ctx) {
  const ready = readings.readyProbe;
  const kinds = ctx.harnessReadyProbe?.kinds ?? null;
  const specs = Object.values(MEASUREMENT_SPECS);
  const applies = [
    ...new Set(specs.filter((s) => s.readyProbe).map((s) => s.kind)),
  ];
  const notApplicable = [
    ...new Set(specs.filter((s) => !s.readyProbe).map((s) => s.kind)),
  ];
  if (
    !Array.isArray(kinds) ||
    !same(kinds, applies) ||
    !isObject(ready) ||
    !same(ready.appliesTo, applies) ||
    !same(ready.notApplicable, notApplicable) ||
    Object.entries(READY_PROBE).some(
      ([key, value]) => !same(ready[key], value),
    ) ||
    !nonBlank(ready.decision) ||
    READY_PROBE_WORDS.some((word) => !String(ready.rule ?? "").includes(word))
  )
    errors.push(
      `setupReadings.readyProbe must apply V-10 READY to ${applies.join(", ")} only (the pinned harness plan's readyProbeOf: ${JSON.stringify(kinds)}), disclose ${READY_PROBE.skipped} and the prepare diagnostics in ${READY_PROBE.receiptField} for ${notApplicable.join(", ")} without judging them, and keep the Graph arm's fallback, the at-query probe and the thresholds (DR-CP4-T-4 (a))`,
    );
}

/** S2 追補 #2（DR-CP4-L-24）: the closed set of reopen triggers and the limits. */
function reopenErrors(errors, readings) {
  const reopen = readings.reopen ?? {};
  const triggers = (reopen.triggers ?? []).map((row) => [
    row?.id,
    row?.sessions,
    row?.waitMs,
    row?.resumeFrom,
    row?.onExhausted,
  ]);
  if (
    reopen.closedSet !== true ||
    !same(triggers, REOPEN_TRIGGERS) ||
    (reopen.triggers ?? []).some((row) => !nonBlank(row?.condition)) ||
    !same(reopen.limits, REOPEN_LIMITS) ||
    reopen.totalReopenableOpenings !== REOPEN_TOTAL ||
    REOPEN_TOTAL !==
      ["author", "seal", "reseal"].reduce(
        (sum, label) => sum + REOPEN_LIMITS[label].openings,
        0,
      ) ||
    reopen.newDirectoryAndNonce !== true ||
    !nonBlank(reopen.otherFailures)
  )
    errors.push(
      `setupReadings.reopen must be L-24's closed set (${REOPEN_TRIGGERS.map(([id]) => id).join(", ")}), author/seal/reseal 3 openings each (${REOPEN_TOTAL} in all), ir and hold never reopened`,
    );
}

/** S2 追補（P-3、DR-CP4-L-11）: d2 is read as the index-state probe for the unusable variants only. */
function d2ReadingErrors(errors, readings, ctx) {
  if (!isObject(readings)) {
    errors.push("d2.variantReadings is required (S2 追補、P-3)");
    return;
  }
  const rows = expectedVariantSessions(ctx);
  const holding = rows.filter((row) =>
    String(row.measurementPoint ?? "").startsWith("while-"),
  );
  const unchanged = rows
    .filter((row) => !holding.includes(row))
    .map((row) => row.variant);
  const want = holding.map((row) => {
    const [caseId, variantId] = row.variant.split("/");
    const state =
      (ctx.fixtures?.[caseId]?.json?.variants ?? []).find(
        (entry) => entry.id === variantId,
      )?.indexState ?? {};
    return {
      variant: row.variant,
      b: state.graph === "usable" ? "current" : "not-current",
      chronicle: state.chronicle,
      maintenanceSeam: false,
      oneShot: row.specKind === "one-shot",
    };
  });
  const readAs = (readings.readAs ?? []).map((row) => ({
    variant: row?.variant,
    b: row?.b,
    chronicle: row?.chronicle,
    maintenanceSeam: row?.maintenanceSeam,
    oneShot: row?.oneShot,
  }));
  if (
    !same(readings.unchanged, unchanged) ||
    !same(readAs, want) ||
    (readings.readAs ?? []).some(
      (row) => !nonBlank(row?.bCheck) || !nonBlank(row?.chronicleCheck),
    ) ||
    // S2 追補 #9（DR-CP4-T-3）: graph-index-unusable's C is rebuilt after the
    // Freshness processed the feed (the Freshness's invalidation lands first).
    !String(
      (readings.readAs ?? []).find(
        (row) => row?.variant === "G-08/graph-index-unusable",
      )?.readmeNote ?? "",
    ).includes("DR-CP4-T-3") ||
    !same(readings.checkedAt, ["before-measurement", "at-query"]) ||
    readings.onMismatch !== INDEX_STATE_HOLDING ||
    readings.notBlockedAs !== "blocked:b-sealed-binding" ||
    !nonBlank(readings.rule)
  )
    errors.push(
      `d2.variantReadings must keep d2 for ${unchanged.join(", ")} and read it as the declared indexState probe (before the measurement and at the query, ${INDEX_STATE_HOLDING} on mismatch) for ${want.map((row) => row.variant).join(", ")}`,
    );
}

/**
 * S2 追補 #5: S3's P-S2-6 decision lets ir-complete-pairs come into force
 * only with a switch choice; the conditional one also needs its conditions
 * recorded and the rule's C1〜C3 body.
 */
function spP4SwitchDecided(decided, proposed) {
  const kind = Object.hasOwn(SP_P4_SWITCH_CHOICES, decided?.choice ?? "")
    ? SP_P4_SWITCH_CHOICES[decided.choice]
    : null;
  if (kind === "as-proposed") return true;
  return (
    kind === "conditional" &&
    nonBlank(decided?.conditions) &&
    isObject(proposed?.conditions) &&
    same(Object.keys(proposed.conditions), SP_P4_CONDITIONS) &&
    SP_P4_CONDITIONS.every(
      (id) =>
        nonBlank(proposed.conditions[id]) &&
        SP_P4_CONDITION_WORDS[id].every((word) =>
          proposed.conditions[id].includes(word),
        ),
    )
  );
}

/**
 * S2 追補 #4（DR-CP4-O-5 (ii)(iii)(iv)(ix)、O-7）: SP-P4's sparse re-read,
 * the supplement slot, the retake scope and the comparison rule. The rule
 * in force is the pinned harness's SP_P4_COMPARISON_RULE; S2 追補 #6 puts
 * ir-complete-pairs in force on S3's P-S2-6 decision e (C1〜C3 in #757).
 */
function spP4ReadingErrors(errors, p4, prep, ctx) {
  if (!isObject(p4)) return;
  const sparse = p4.sparseReading;
  if (
    sparse?.when !== "after-product-fetch" ||
    sparse?.query !== "same-saved-body" ||
    sparse?.via !== "product-functions" ||
    !nonBlank(sparse?.rule)
  )
    errors.push(
      "diagnosticRuns SP-P4.sparseReading must re-read the sparse Scenes after the product fetch from the same saved body through the product's functions (DR-CP4-O-2 (a)、O-5 (ii))",
    );
  if (
    p4.supplementSlot?.definition !== "r-plus-ir-minus-r" ||
    p4.supplementSlot?.maxScenes !== 1 ||
    !nonBlank(p4.supplementSlot?.rule)
  )
    errors.push(
      "diagnosticRuns SP-P4.supplementSlot must be R+IR − R, at most one Scene (DR-CP4-O-5 (ii))",
    );
  if (!String(p4.countReason ?? "").includes("G-08/graph-recovered"))
    errors.push(
      "diagnosticRuns SP-P4.countReason must give the reason G-08/graph-recovered is not measured (DR-CP4-O-3 (4)、O-5 (iii))",
    );
  if (
    p4.retakeScope !== "measurement-only" ||
    !String(p4.attemptRule ?? "").includes("setup")
  )
    errors.push(
      "diagnosticRuns SP-P4 retakes the measurement only, never the setup (retakeScope measurement-only; DR-CP4-O-5 (ix))",
    );
  const rule = p4.comparisonRule;
  const rows = Array.isArray(rule?.rules) ? rule.rules : [];
  const harness = ctx.harnessConstants?.SP_P4_COMPARISON_RULE;
  const limit = ctx.harnessConstants?.SP_P4_IR_TIMEOUT_LIMIT;
  const decided = (prep.reviewerQuestions ?? []).find(
    (row) => row?.id === "P-S2-6",
  )?.decision;
  const pairs = rows.find((row) => row?.id === "ir-complete-pairs");
  const inForce = rows.find((row) => row?.id === rule?.inForce);
  // S2 追補 #6（DR-CP4-P-3）: ir-complete-pairs is in force, as the pinned
  // harness's SP_P4_COMPARISON_RULE is; current stays, not in force.
  if (
    !isObject(rule) ||
    !same(
      rows.map((row) => row?.id),
      SP_P4_RULE_IDS,
    ) ||
    rule.inForce !== "ir-complete-pairs" ||
    rule.inForce !== harness ||
    inForce?.status !== "in-force" ||
    rows.some((row) => row !== inForce && row?.status !== "not-in-force") ||
    rows.some((row) => !nonBlank(row?.text)) ||
    rows.some((row) => Object.hasOwn(row ?? {}, "awaits")) ||
    !spP4SwitchDecided(decided, pairs) ||
    !nonBlank(rule.switchRule) ||
    !String(rule.harnessConstant ?? "").includes("SP_P4_IR_TIMEOUT_LIMIT")
  )
    errors.push(
      `diagnosticRuns SP-P4.comparisonRule must put ir-complete-pairs in force as the pinned harness's SP_P4_COMPARISON_RULE (${String(harness)}) does, keep current as not-in-force, and rest on S3's P-S2-6 decision e with the C1〜C3 bodies (DR-CP4-Q-1、DR-CP4-P-3)`,
    );
  // C1〜C3 as the harness implements them, the limit K read from the pinned
  // bytes, and "no threshold" withdrawn.
  if (
    !holds(pairs, SP_P4_IR_COMPLETE_PAIRS) ||
    !Number.isInteger(limit) ||
    pairs.timeoutLimit !== limit ||
    !String(pairs.conditions?.C2 ?? "").includes(`${String(limit)}`) ||
    Object.hasOwn(pairs, "threshold") ||
    String(pairs.text ?? "").includes("足さない") ||
    !String(pairs.withdrawn ?? "").includes("しきい値") ||
    !String(pairs.text ?? "").includes("SP_P4_IR_TIMEOUT_LIMIT")
  )
    errors.push(
      `diagnosticRuns SP-P4.comparisonRule ir-complete-pairs must be C1 (exclude the IR fields only for a timeout with deadlineExceeded true, R+IR equal to R and no supplement; either side excludes the pair; other non-ready samples compared as current), C2 (more than the harness's SP_P4_IR_TIMEOUT_LIMIT ${String(limit)} excluded measured samples on a side of a variant, or none compared, is [precheck]) and C3, with "no threshold" withdrawn (DR-CP4-Q-1)`,
    );
  // S2 追補 #8（DR-CP4-Q-2）: the pair limit read from the pinned bytes — more
  // pairs of a variant without their IR than it is [precheck] (S3's C2: at
  // least 24 IR-compared pairs of the measured 30).
  const pairLimit = ctx.harnessConstants?.SP_P4_IR_TIMEOUT_PAIR_LIMIT;
  if (
    !Number.isInteger(pairLimit) ||
    pairs?.timeoutPairLimit !== pairLimit ||
    !String(pairs?.conditions?.C2 ?? "").includes(
      `SP_P4_IR_TIMEOUT_PAIR_LIMIT（${String(pairLimit)}）`,
    ) ||
    !String(pairs?.text ?? "").includes("SP_P4_IR_TIMEOUT_PAIR_LIMIT") ||
    !String(pairs?.text ?? "").includes("ir-timeout-pair-limit") ||
    !String(rule?.harnessConstant ?? "").includes("SP_P4_IR_TIMEOUT_PAIR_LIMIT")
  )
    errors.push(
      `diagnosticRuns SP-P4.comparisonRule ir-complete-pairs must carry the pair limit: more than the harness's SP_P4_IR_TIMEOUT_PAIR_LIMIT ${String(pairLimit)} measured pairs of a variant left without their IR is [precheck] (ir-timeout-pair-limit; S3's C2, at least 24 IR-compared pairs; DR-CP4-Q-2)`,
    );
  const reading = rule?.receiptReading;
  if (
    !holds(reading, SP_P4_RECEIPT_READING) ||
    !nonBlank(reading.rule) ||
    !nonBlank(rule.disclosure) ||
    !String(rule.disclosure).includes("explainedByIrDeadline")
  )
    errors.push(
      `diagnosticRuns SP-P4.comparisonRule.receiptReading must read the receipt's design (${SP_P4_RECEIPT_READING.design.join(", ")}), each attempt's ir.measured (${SP_P4_RECEIPT_READING.attemptIrMeasured.join(", ")}), the side's stability and the comparison as the harness writes them, and the disclosure must say explainSpP4Instability's explainedByIrDeadline is disclosure only (DR-CP4-Q-1)`,
    );
}

/**
 * S2 追補 #4（DR-CP4-N-14 (2)(3)）: the parity a Gold run uses is the one
 * completed parity finished before its start; the fallback is not wired.
 */
function parityReadingErrors(errors, parity) {
  if (
    parity.fallbackWired !== false ||
    !String(parity.fallback ?? "").includes("[precheck]")
  )
    errors.push(
      "d10.parity.fallback is not wired (fallbackWired false): a parity attempt with a blocked variant never completes and the Gold run stops at [precheck] (DR-CP4-N-14 (3))",
    );
  const selection = parity.selection;
  if (
    selection?.completedOnly !== true ||
    selection?.finishedBeforeGoldStart !== true ||
    selection?.onNone !== "[precheck]" ||
    selection?.onTwoOrMore !== "[precheck]" ||
    selection?.blockedAttempt !== "incomplete-blocked" ||
    !nonBlank(selection?.rule)
  )
    errors.push(
      "d10.parity.selection must use the one completed parity of the candidate and S4 commit finished before the Gold run's start ([precheck] with none or with two or more completed; DR-CP4-N-14 (2))",
    );
  if (!holds(parity.receipt, PRIOR_ATTEMPTS) || !nonBlank(parity.receipt?.rule))
    errors.push(
      `d10.parity.receipt.priorAttempts must be ${PRIOR_ATTEMPTS.priorAttempts.join(", ")} with every attempt's row and this attempt's sha256 at start (DR-CP4-N-14 (2)(5))`,
    );
}

/**
 * S2 追補 #4: each pin against git — a bytes pin's sha256 is the pinned
 * commit's bytes of that path, and every pin's commit is an ancestor of
 * `head` (an orphaned commit a rebase left is not). `git` has `blobSha` and
 * `isAncestor`.
 */
export function sourcePinGitErrors(pins, head, git) {
  const errors = [];
  for (const pin of pins ?? []) {
    if (!git.isAncestor(pin?.commit, head))
      errors.push(
        `setupReadings.source.pins ${pin?.role}: ${pin?.commit} is not an ancestor of ${head} (a master commit only; S3v6-P2-1)`,
      );
    for (const file of pin?.files ?? [])
      if (git.blobSha(pin.commit, file?.path) !== file?.sha256)
        errors.push(
          `setupReadings.source.pins ${pin.role}: ${file?.path} at ${pin.commit} is not the pinned bytes ${file?.sha256}`,
        );
  }
  return errors;
}

/**
 * S2 追補 #10（DR-CP4-P-6）: the trace runner's readings of the trace path fix
 * (DR-CP4-V-2〜V-4) — each item with its decision rows and reading, the rule
 * naming the four pins, and the limits (editing's lapse (i), the rules chosen
 * after the first trace, the observation before this freeze).
 */
function traceRunnerReadingErrors(errors, readings) {
  if (!isObject(readings)) {
    errors.push("traceRunnerReadings is required (S2 追補 #10、DR-CP4-P-6)");
    return;
  }
  const items = Array.isArray(readings.items) ? readings.items : [];
  if (
    !same(
      items.map((row) => row?.id),
      TRACE_RUNNER_READING_ITEMS.map(([id]) => id),
    ) ||
    items.some(
      (row, at) =>
        !nonBlank(row?.reading) ||
        !nonBlank(row?.topic) ||
        TRACE_RUNNER_READING_ITEMS[at][1].some(
          (id) => !String(row?.decision ?? "").includes(id),
        ),
    )
  )
    errors.push(
      `traceRunnerReadings.items must be ${TRACE_RUNNER_READING_ITEMS.map(([id, rows]) => `${id} (${rows.join(", ")})`).join(", ")}, each with its topic and reading`,
    );
  const pinRoles = TRACE_PATH_PIN_ROLES.filter(
    (role) => !String(readings.rule ?? "").includes(role),
  );
  if (!nonBlank(readings.status) || pinRoles.length > 0)
    errors.push(
      `traceRunnerReadings.rule must bind the trace runner to the pins ${TRACE_PATH_PIN_ROLES.join(", ")} (S2 追補 #10)`,
    );
  const missing = TRACE_RUNNER_LIMIT_WORDS.filter(
    (word) => !String(readings.limits ?? "").includes(word),
  );
  if (missing.length > 0)
    errors.push(
      `traceRunnerReadings.limits must disclose ${missing.join(", ")} (S2 追補 #10、DR-CP4-P-6)`,
    );
}

/** S2 追補: the points S2 hands to S3 (undecided in a draft, decided when frozen). */
function reviewerQuestionErrors(errors, questions, frozen) {
  const rows = Array.isArray(questions) ? questions : [];
  if (
    !same(
      rows.map((row) => row?.id),
      REVIEWER_QUESTIONS,
    )
  )
    errors.push(`reviewerQuestions must be ${REVIEWER_QUESTIONS.join(", ")}`);
  for (const row of rows) {
    const options = Array.isArray(row?.options) ? row.options : [];
    const ids = options.map((option) => option?.id);
    if (
      !nonBlank(row?.topic) ||
      !nonBlank(row?.issue) ||
      !Array.isArray(row?.grounds) ||
      row.grounds.length === 0 ||
      row.grounds.some((ground) => !nonBlank(ground)) ||
      options.length < 2 ||
      options.some(
        (option) => !nonBlank(option?.id) || !nonBlank(option?.text),
      ) ||
      new Set(ids).size !== ids.length ||
      !nonBlank(row?.decidedBy)
    )
      errors.push(
        `reviewerQuestions ${row?.id} must state the issue, its grounds, two or more options and who decides`,
      );
    // S2 never decides: a question is open (null) until S3's record decides it,
    // and every question is decided when frozen.
    const decision = row?.decision;
    if (decision === null) {
      if (frozen)
        errors.push(
          `reviewerQuestions ${row?.id} must carry S3's decision (choice, by, record) when frozen`,
        );
    } else if (
      !isObject(decision) ||
      !ids.includes(decision.choice) ||
      !nonBlank(decision.by) ||
      !nonBlank(decision.record)
    )
      errors.push(
        `reviewerQuestions ${row?.id}: a decision must be S3's (a listed choice, by, record); S2 does not decide`,
      );
  }
}

/** The observation-prep record (D1, D2, D10, plan, traces, procedure, diagnostics). */
export function observationPrepErrors(prep, ctx) {
  const errors = [];
  if (!isObject(prep)) return ["observation prep must be an object"];
  if (prep.schemaVersion !== "nir1-cp4-observation-prep/1")
    errors.push("schemaVersion must be nir1-cp4-observation-prep/1");
  if (prep.status !== PREP_DRAFT && prep.status !== PREP_FROZEN)
    errors.push(`status must be ${PREP_DRAFT} or ${PREP_FROZEN}`);
  const frozen = prep.status === PREP_FROZEN;
  if (prep.graphRuntimeObservedBeforeAuthoring !== false)
    errors.push("graphRuntimeObservedBeforeAuthoring must be false");
  const { k24, k62, k64 } = prep.contracts ?? {};
  if (k24?.sha256 !== CONTRACTS.k24.sha256 || k24?.path !== CONTRACTS.k24.path)
    errors.push("contracts.k24 must be the K2/4 bytes");
  if (
    k62?.sha256 !== CONTRACTS.k62.sha256 ||
    k62?.freezeCommit !== CONTRACTS.k62.freezeCommit
  )
    errors.push("contracts.k62 must be the K6/2 bytes and freeze commit");
  if (
    k64?.sha256 !== CONTRACTS.k64.sha256 ||
    k64?.draftRef !== CONTRACTS.k64.draftRef ||
    k64?.confirmedCommit !== CONTRACTS.k64.confirmedCommit
  )
    errors.push("contracts.k64 must be the K6/4 bytes");
  const sp1 = prep.contracts?.sp1;
  if (
    sp1?.draftRef !== SP1.draftRef ||
    sp1?.contractId !== SP1.contractId ||
    sp1?.sha256 !== SP1.sha256
  )
    errors.push("contracts.sp1 must be the SP/1 bytes");
  referenceErrors(
    errors,
    "contracts.k64.freezeCommit",
    k64?.freezeCommit,
    "commit",
    frozen,
  );
  // S4 の最終関門の P3-3: a filled K6/4 freeze commit is the pinned harness's
  // K64_FREEZE.freezeCommit (constants.mjs read from its pin's bytes, as the
  // harness constants are), never only a 40-hex.
  if (
    HEX40.test(String(k64?.freezeCommit ?? "")) &&
    k64.freezeCommit !== ctx.harnessK64Freeze?.commit
  )
    errors.push(
      `contracts.k64.freezeCommit must be the pinned harness's K64_FREEZE.freezeCommit (${String(ctx.harnessK64Freeze?.commit ?? "unreadable")}, ${K64_FREEZE_SOURCE.path} at its pin)`,
    );
  if (
    prep.references?.g01Fixture?.sha256 !== ctx.g01.sha256 ||
    prep.references?.g01Fixture?.sha256 !== ctx.g01.frozenSha256
  )
    errors.push("references.g01Fixture must be the frozen G-01 fixture sha256");
  freezeReferenceErrors(errors, prep.references?.graphCaseFreeze, ctx);
  // The CP-4 candidate descends from S4, so it is decided in the S5 ledger
  // (integrator), never an S4 placeholder.
  if (
    !isObject(prep.candidate) ||
    prep.candidate.commit !== null ||
    prep.candidate.decidedIn !== "S5-ledger" ||
    typeof prep.candidate.rule !== "string"
  )
    errors.push(
      "candidate.commit must stay null and be decided in the S5 ledger (decidedIn S5-ledger)",
    );
  // SP/1 bytes bound in the repository once frozen (S3v3-P3-1).
  referenceErrors(
    errors,
    "contracts.sp1.bytesCommit",
    sp1?.bytesCommit,
    "commit",
    frozen,
  );
  if (frozen && ctx.sp1Sha256 !== SP1.sha256)
    errors.push(
      `contracts.sp1: a frozen record needs the SP/1 bytes at ${SP1.path} with sha256 ${SP1.sha256}`,
    );

  // D1: the same declaration place as both addenda.
  const choices = [
    ctx.setupAddendum?.declarationPlace?.choice,
    ctx.declarationAddendum?.declarationPlace?.choice,
  ];
  if (
    prep.d1?.choice !== "ii" ||
    choices.some((choice) => choice !== prep.d1?.choice)
  )
    errors.push(
      "d1.choice must be ii and equal both addenda's declarationPlace",
    );
  if (
    !same(
      prep.d1?.runs,
      K24_TABLE.map((row) => `${row.caseId}/${row.variantId}`),
    )
  )
    errors.push(
      `d1.runs must be the ${K24_TABLE.length} K2/4 declaration runs (${K24_TABLE.map((row) => `${row.caseId}/${row.variantId}`).join(", ")})`,
    );
  if (
    typeof prep.d2?.rule !== "string" ||
    !prep.d2.rule.includes("nir1-graph-index-build")
  )
    errors.push(
      "d2.rule must establish the B seal through the B-ROUTE journey seam",
    );
  d2ReadingErrors(errors, prep.d2?.variantReadings, ctx);
  setupReadingErrors(errors, prep.setupReadings, ctx);
  traceRunnerReadingErrors(errors, prep.traceRunnerReadings);
  reviewerQuestionErrors(errors, prep.reviewerQuestions, frozen);

  // D10: modes and parity.
  const arms = prep.d10?.arms ?? {};
  if (arms.graph !== "restricted")
    errors.push(
      "d10.arms.graph must be restricted (Graph appears only restricted)",
    );
  for (const arm of ["raw", "hybrid"])
    if (arms[arm] !== "restricted" && arms[arm] !== "unrestricted")
      errors.push(`d10.arms.${arm} must be a D2a mode`);
  if (arms.raw !== arms.hybrid)
    errors.push(
      "d10.arms.raw must equal d10.arms.hybrid (R is the hybrid arm's Raw)",
    );
  const record = prep.d10?.g01?.da1AcceptanceRecord;
  const mode = prep.d10?.g01?.rAndRirMode;
  const recordPlaceholder =
    typeof record === "string" && PLACEHOLDER.test(record);
  if (recordPlaceholder) {
    if (typeof mode !== "string" || !PLACEHOLDER.test(mode))
      errors.push(
        "d10.g01.rAndRirMode must stay a placeholder until da1AcceptanceRecord is filled (S3-P2-4)",
      );
  } else {
    const expectedMode = record === "none" ? "unrestricted" : "restricted";
    if (mode !== expectedMode)
      errors.push(
        `d10.g01.rAndRirMode must be ${expectedMode} when da1AcceptanceRecord is ${record === "none" ? "none" : "a record"} (K6/2 CP-0 (a)/(d))`,
      );
  }
  if (
    prep.d10?.g01?.rAndRirModeRule?.recordPath !== "restricted" ||
    prep.d10?.g01?.rAndRirModeRule?.none !== "unrestricted"
  )
    errors.push(
      "d10.g01.rAndRirModeRule must map a record to restricted and none to unrestricted",
    );
  if (
    typeof record !== "string" ||
    record.trim() === "" ||
    (record.startsWith("S4:") && (!PLACEHOLDER.test(record) || frozen))
  )
    errors.push(
      "d10.g01.da1AcceptanceRecord must be filled (a record path or none) when frozen",
    );
  if (typeof prep.d10?.g01?.fallback !== "string")
    errors.push("d10.g01.fallback is required (K6/2 CP-0 (d))");
  const parity = prep.d10?.parity ?? {};
  if (
    !Number.isInteger(parity.unrestrictedRunsPerVariant) ||
    parity.unrestrictedRunsPerVariant < 1
  )
    errors.push("d10.parity.unrestrictedRunsPerVariant must be at least 1");
  if (!same(parity.variants, PARITY_VARIANTS))
    errors.push(`d10.parity.variants must be ${PARITY_VARIANTS.join(", ")}`);
  for (const key of [
    "run",
    "comparison",
    "countReason",
    "mismatch",
    "fallback",
  ])
    if (typeof parity[key] !== "string" || parity[key].trim() === "")
      errors.push(`d10.parity.${key} is required`);
  parityReadingErrors(errors, parity);

  // Sample plan (K6/2 step 2).
  const plan = prep.samplePlan ?? {};
  if (
    plan.warmupPerArm !== WARMUP_PER_ARM ||
    plan.measuredPerArm !== MEASURED_PER_ARM ||
    !same(plan.arms, ["hybrid", "graph"]) ||
    plan.order !== "AB/BA" ||
    !same(plan.variants, PLAN_VARIANTS)
  )
    errors.push(
      "samplePlan must be warm-up 5, measured 30, hybrid/graph AB/BA over the 13 variants",
    );
  if (plan.rFrom !== "hybrid-arm-raw" || typeof plan.rRule !== "string")
    errors.push(
      "samplePlan.rFrom must be hybrid-arm-raw with its rRule (S3-P3-5)",
    );
  oneShotPlanErrors(errors, prep, ctx);

  // R5 gate (S3-P1-1; K6/4 R5 and :317, K2/4 :418-420).
  const gate = prep.r5Gate;
  if (!isObject(gate)) errors.push("r5Gate is required (S3-P1-1)");
  else {
    if (!same([...(gate.blockedUntilMatch ?? [])].sort(), [...R5_GATED].sort()))
      errors.push(`r5Gate.blockedUntilMatch must be ${R5_GATED.join(", ")}`);
    const exempt = Array.isArray(gate.exempt) ? gate.exempt : [];
    if (
      !same(exempt.map((row) => row?.run).sort(), [...R5_EXEMPT].sort()) ||
      exempt.some((row) => R5_GATED.includes(row?.run)) ||
      exempt.some((row) => typeof row?.reason !== "string")
    )
      errors.push(
        `r5Gate.exempt must be exactly ${R5_EXEMPT.join(", ")} (no Graph arm), each with its reason`,
      );
    if (
      !same(
        [...(gate.matchRequires ?? [])].sort(),
        [...R5_MATCH_REQUIRES].sort(),
      )
    )
      errors.push(
        `r5Gate.matchRequires must be ${R5_MATCH_REQUIRES.join(", ")} (SP/1 批准 6)`,
      );
    if (
      !same(gate.beforeFirstGatedRun, [
        "sp-p4-seed-pin-parity",
        "sp-negative-synthetic",
      ])
    )
      errors.push(
        "r5Gate.beforeFirstGatedRun must be the SP-P4 diagnostic and the synthetic detection (SP-N7 and SP/1 :178 before any Graph arm run)",
      );
    const synthetic = gate.syntheticDetection ?? {};
    const syntheticRecord = synthetic.record;
    if (
      !same(synthetic.negatives, SYNTHETIC_NEGATIVES) ||
      typeof synthetic.rule !== "string" ||
      typeof synthetic.owner !== "string" ||
      typeof syntheticRecord !== "string" ||
      syntheticRecord.trim() === "" ||
      (syntheticRecord.startsWith("S4:") &&
        (!PLACEHOLDER.test(syntheticRecord) || frozen))
    )
      errors.push(
        `r5Gate.syntheticDetection must list ${SYNTHETIC_NEGATIVES.join(", ")} with its rule, owner and record (SP/1 :178)`,
      );
    if (gate.k64FreezeAfterMatch !== true)
      errors.push("r5Gate.k64FreezeAfterMatch must be true (K6/4 :317)");
    if (
      typeof gate.onFixtureRevision !== "string" ||
      !gate.onFixtureRevision.includes("レビュー")
    )
      errors.push(
        "r5Gate.onFixtureRevision must require new addendum and trace versions and a new review",
      );
    if (typeof gate.rule !== "string" || typeof gate.check !== "string")
      errors.push("r5Gate.rule and r5Gate.check are required");
  }
  if (
    !Array.isArray(prep.preconditions) ||
    !String(prep.preconditions[0] ?? "").startsWith("r5Gate")
  )
    errors.push("preconditions must start with the r5Gate (S3-P1-1)");

  // Phases (integrator; K6/4 :317, K2/4 :418, SP/1).
  if (!same(prep.stepOrder?.phases, PHASES))
    errors.push(`stepOrder.phases must be ${PHASES.join(" -> ")}`);
  if (prep.contracts?.k64?.decidedIn !== "k64-freeze-before-s4")
    errors.push(
      "contracts.k64.decidedIn must be k64-freeze-before-s4 (phase ②; S4 fills the existing freeze commit)",
    );
  const r5Check = (prep.r5Gate?.exempt ?? []).find(
    (row) => row?.run === "r5-seed-pin-check",
  );
  if (
    r5Check &&
    (!same(r5Check.scope, R5_CHECK_SCOPE) ||
      !same([...(r5Check.forbids ?? [])].sort(), [...R5_CHECK_FORBIDS].sort()))
  )
    errors.push(
      `r5Gate.exempt r5-seed-pin-check must be setup and product-db-read only and forbid ${R5_CHECK_FORBIDS.join(", ")}`,
    );
  if (
    r5Check &&
    (typeof r5Check.stopsAt?.graphCases !== "string" ||
      !r5Check.stopsAt.graphCases.includes("maintenance") ||
      typeof r5Check.stopsAt?.g01 !== "string" ||
      !r5Check.stopsAt.g01.includes("typed Revision"))
  )
    errors.push(
      "r5Gate.exempt r5-seed-pin-check must stop after the seed pin step (before maintenance; G-01 before typed Revision prepare)",
    );
  const workspace = prep.r5Gate?.r5CheckWorkspace;
  if (
    !isObject(workspace) ||
    workspace.disposition !== "discard" ||
    !same(workspace.reuseFor, []) ||
    !same(workspace.recheckInLaterPhases, ["sp-p1", "sp-p3-r5"]) ||
    workspace.onMismatch !== "[precheck]" ||
    typeof workspace.rule !== "string"
  )
    errors.push(
      "r5Gate.r5CheckWorkspace must discard the R5 check workspaces and re-check SP-P1 and R5 in new workspaces, [precheck] on mismatch (S3v4-P3-2)",
    );
  if (
    prep.r5Gate?.syntheticDetection?.decidedIn !==
    "sp-synthetic-detection-before-s4"
  )
    errors.push(
      "r5Gate.syntheticDetection.decidedIn must be sp-synthetic-detection-before-s4 (S3v4-P2-1)",
    );
  if (
    !same(prep.s4Stages, ["s4a-bytes", "s4b-fill-and-freeze"]) ||
    typeof prep.s4StagesRule !== "string" ||
    !String(prep.placeholderRule).includes("真の祖先")
  )
    errors.push(
      "s4Stages must be s4a-bytes then s4b-fill-and-freeze, and placeholderRule must make the referenced commits strict ancestors (S3v4-P3-3)",
    );
  // S2 追補 #7（DR-CP4-S4-1）: S4's procedure — the merge commit of
  // claude/nir1-contracts, the merge-commit PR, the integrator's formal gate
  // on S4b and the entries' read against the freeze record.
  for (const [item, words] of Object.entries(S4_PROCEDURE_WORDS)) {
    const missing = words.filter(
      (word) => !String(prep.s4StagesRule ?? "").includes(word),
    );
    if (missing.length > 0)
      errors.push(
        `s4StagesRule must state S4's procedure (${item}) with ${missing.join(", ")} (S2 追補 #7、DR-CP4-S4-1)`,
      );
  }
  const r5CheckRecord = prep.r5Gate?.r5CheckRecord;
  if (
    typeof r5CheckRecord !== "string" ||
    r5CheckRecord.trim() === "" ||
    (r5CheckRecord.startsWith("S4:") &&
      (!PLACEHOLDER.test(r5CheckRecord) || frozen)) ||
    typeof prep.r5Gate?.r5CheckRecordRule !== "string"
  )
    errors.push(
      "r5Gate.r5CheckRecord must locate the R5 check run's record (filled when frozen) with its rule",
    );

  // Step order (SP/1 設計: the seed pin step first, the declaration later).
  if (!same(prep.stepOrder?.graphCases, STEP_ORDER.graphCases))
    errors.push("stepOrder.graphCases must be the SP/1 and K2/4 order");
  if (!same(prep.stepOrder?.g01, STEP_ORDER.g01))
    errors.push("stepOrder.g01 must be the SP/1 and K2/4 order");

  // Registered tolerance usages (S3-P3-4).
  const tolerance = (prep.registeredForReview ?? []).find(
    (row) => row?.name === "BOUNDARY_TOLERANCE_MS",
  );
  if (
    !same(
      (tolerance?.usages ?? []).map((row) => row.site),
      TOLERANCE_USAGES,
    ) ||
    (tolerance?.usages ?? []).some(
      (row) => typeof row.use !== "string" || row.use.trim() === "",
    )
  )
    errors.push(
      `registeredForReview BOUNDARY_TOLERANCE_MS must list ${TOLERANCE_USAGES.join(", ")}`,
    );

  // Traces: both kinds, the reviewed bytes by commit and sha256.
  const traces = Array.isArray(prep.traces) ? prep.traces : [];
  if (
    !same(
      traces.map((row) => row.kind),
      ["editing", "browsing"],
    )
  )
    errors.push("traces must be the editing and the browsing trace");
  for (const [at, row] of traces.entries()) {
    const file = TRACE_KINDS[row.kind]?.file;
    if (row.path !== file) errors.push(`traces[${at}].path must be ${file}`);
    referenceErrors(
      errors,
      `traces[${at}].commit`,
      row.commit,
      "commit",
      frozen,
    );
    referenceErrors(
      errors,
      `traces[${at}].sha256`,
      row.sha256,
      "sha256",
      frozen,
      ctx.fileSha256[file],
    );
  }

  // K6/4 procedure file.
  const procedure = prep.k64Procedure ?? {};
  if (procedure.draft?.path !== OBSERVATION_PREP_FILES.procedureDraft)
    errors.push(
      `k64Procedure.draft.path must be ${OBSERVATION_PREP_FILES.procedureDraft}`,
    );
  if (!same(procedure.values, ctx.procedureDraft?.values))
    errors.push("k64Procedure.values must equal the procedure file's values");
  for (const key of [...Object.keys(K64_VALUES), "r1r4WaitMs"])
    if (
      typeof procedure.valueReasons?.[key] !== "string" ||
      procedure.valueReasons[key].trim() === ""
    )
      errors.push(`k64Procedure.valueReasons.${key} is required`);
  const formal = procedure.formal ?? {};
  if (formal.version !== "v1" || formal.path !== PROCEDURE_V1)
    errors.push("k64Procedure.formal must be the v1 file");
  referenceErrors(
    errors,
    "k64Procedure.formal.commit",
    formal.commit,
    "commit",
    frozen,
  );
  referenceErrors(
    errors,
    "k64Procedure.formal.sha256",
    formal.sha256,
    "sha256",
    frozen,
  );
  if (frozen) {
    if (ctx.fileSha256[formal.path] === undefined)
      errors.push("k64Procedure.formal: the v1 file is not in the repository");
    else if (formal.sha256 !== ctx.fileSha256[formal.path])
      errors.push("k64Procedure.formal.sha256 differs from the v1 file");
    const review = formal.review;
    if (
      !isObject(review) ||
      typeof review.reviewer !== "string" ||
      typeof review.record !== "string" ||
      !ISO_DATE.test(review.reviewedAt ?? "")
    )
      errors.push("k64Procedure.formal.review must be the v1 file's review");
    const v1 = ctx.procedureFormal;
    const draft = ctx.procedureDraft ?? {};
    if (
      !isObject(v1) ||
      v1.version !== "v1" ||
      v1.draft !== false ||
      v1.schema !== draft.schema ||
      !same(v1.contract, draft.contract) ||
      !same(v1.values, draft.values) ||
      !same(v1.conditions, draft.conditions)
    )
      errors.push(
        "k64Procedure.formal: the v1 file must be the reviewed draft-2 (schema, contract, values, conditions) as version v1, draft false (S3-P2-3)",
      );
    else if (!same(v1.review, review))
      errors.push("k64Procedure.formal.review must equal the v1 file's review");
    if (review?.record !== prep.review?.record)
      errors.push(
        "k64Procedure.formal.review must cite the same independent review record as this record",
      );
  } else if (formal.review !== null)
    errors.push("k64Procedure.formal.review must be null until S3 reviews");

  // Diagnostic runs (K2/4 negatives and K6/2 (iii)).
  const ids = (prep.diagnosticRuns ?? []).map((row) => row.id);
  if (!same(ids, DIAGNOSTIC_IDS))
    errors.push(`diagnosticRuns must be ${DIAGNOSTIC_IDS.join(", ")}`);
  const negatives = [
    ...(ctx.setupAddendum?.diagnosticNegatives ?? []),
    ...(ctx.declarationAddendum?.diagnosticNegatives ?? []),
  ];
  for (const negative of negatives) {
    const row = (prep.diagnosticRuns ?? []).find(
      (run) => run.id === negative.id,
    );
    if (
      !row ||
      row.variant !== `${negative.caseId}/${negative.variantId}` ||
      row.declare !== negative.declare ||
      row.mutationAfterDeclaration !== negative.mutationAfterDeclaration
    )
      errors.push(`diagnosticRuns ${negative.id} must match its addendum row`);
  }

  const p4 = (prep.diagnosticRuns ?? []).find((run) => run.id === "SP-P4");
  if (
    !p4 ||
    p4.runKind !== "seed-pin-parity" ||
    !same(p4.arms, ["hybrid"]) ||
    p4.graphArm !== false ||
    p4.seedSent !== false ||
    !same(p4.variants, SP_P4_VARIANTS) ||
    !same(p4.sides, ["without-seed-pin-step", "with-seed-pin-step"]) ||
    p4.runsPerSide !== 1 ||
    typeof p4.comparison !== "string" ||
    typeof p4.onDifference !== "string" ||
    !p4.onDifference.includes("[precheck]") ||
    p4.d2aMode !== prep.d10?.arms?.hybrid ||
    p4.branch !== "single-pre-step-copy" ||
    p4.compareBy !== "logical-id" ||
    p4.attemptLimit !== 2 ||
    typeof p4.attemptRule !== "string" ||
    !p4.attemptRule.includes("[precheck]") ||
    !(p4.requiredRecords ?? []).includes("owner-begins-delta-zero") ||
    !same([...(p4.notCountedAs ?? [])].sort(), [
      "case-judgement",
      "g-case-parity-unrestricted",
      "g01-eval-revision-receipt",
      "k3-parity-run",
    ])
  )
    errors.push(
      "diagnosticRuns SP-P4 must be the seed pin parity (hybrid only, no Graph arm, no seed, 8 base variants, without/with the step, SP-N7 -> [precheck])",
    );
  spP4ReadingErrors(errors, p4, prep, ctx);

  // Bound files: exactly the documents (S3-P2-2).
  const boundPaths = (prep.boundFiles ?? []).map((row) => row.path);
  const requiredBound = [
    OBSERVATION_PREP_FILES.setupAddendum,
    OBSERVATION_PREP_FILES.declarationAddendum,
    OBSERVATION_PREP_FILES.traceEditing,
    OBSERVATION_PREP_FILES.traceBrowsing,
    OBSERVATION_PREP_FILES.authorDeclaration,
    OBSERVATION_PREP_FILES.seedPinAddendum,
  ];
  if (!same([...boundPaths].sort(), [...requiredBound].sort()))
    errors.push(`boundFiles must be exactly ${requiredBound.join(", ")}`);
  for (const trace of traces) {
    const bound = (prep.boundFiles ?? []).find(
      (row) => row.path === trace.path,
    );
    if (
      !bound ||
      bound.commit !== trace.commit ||
      bound.sha256 !== trace.sha256
    )
      errors.push(
        `boundFiles ${trace.path} must carry the same commit and sha256 as traces`,
      );
  }
  for (const [at, row] of (prep.boundFiles ?? []).entries()) {
    if (ctx.fileSha256[row.path] === undefined)
      errors.push(
        `boundFiles[${at}].path ${row.path} is not an observation-prep file`,
      );
    referenceErrors(
      errors,
      `boundFiles[${at}].commit`,
      row.commit,
      "commit",
      frozen,
    );
    referenceErrors(
      errors,
      `boundFiles[${at}].sha256`,
      row.sha256,
      "sha256",
      frozen,
      ctx.fileSha256[row.path],
    );
  }

  // Placeholders: documented exactly; none when frozen.
  const { placeholders: listed, ...rest } = prep;
  const used = [...placeholderTokens(rest)].sort();
  const documented = (Array.isArray(listed) ? listed : [])
    .map((row) => row.token)
    .sort();
  for (const token of used)
    if (!PLACEHOLDER.test(token))
      errors.push(`placeholder ${token} is not of the form S4:<name>`);
  if (!same(used, documented))
    errors.push(
      `placeholders must document exactly the placeholders used (${used.join(", ") || "none"})`,
    );
  if (frozen && used.length > 0)
    errors.push(`a frozen record still has placeholder(s) ${used.join(", ")}`);
  // S3v6-P3-3: a draft keeps exactly the S4 tokens (S4b fills them all).
  if (!frozen && !same(documented, [...S4_PLACEHOLDERS].sort()))
    errors.push(
      `placeholders: a draft keeps exactly the ${S4_PLACEHOLDERS.length} S4 tokens (${S4_PLACEHOLDERS.join(", ")}); S4b fills them all at once`,
    );

  if (frozen) {
    const review = prep.review;
    if (
      !isObject(review) ||
      typeof review.reviewer !== "string" ||
      typeof review.record !== "string" ||
      !ISO_DATE.test(review.reviewedAt ?? "") ||
      !HEX64.test(review.recordSha256 ?? "")
    )
      errors.push("review must name the independent review record when frozen");
  } else if (prep.review !== null)
    errors.push("review must be null until S3 reviews");
  return errors;
}

/** The author's declaration (S2 did not read Graph runtime output). */
export function authorDeclarationErrors(declaration) {
  const errors = [];
  if (!isObject(declaration)) return ["author declaration must be an object"];
  if (declaration.schemaVersion !== "nir1-cp4-observation-prep-author/1")
    errors.push("schemaVersion must be nir1-cp4-observation-prep-author/1");
  if (declaration.graphRuntimeOutputObserved !== false)
    errors.push("graphRuntimeOutputObserved must be false");
  if (
    !isObject(declaration.author) ||
    typeof declaration.author.model !== "string"
  )
    errors.push("author.model is required");
  if (typeof declaration.author?.effort !== "string")
    errors.push("author.effort is required");
  if (!ISO_DATE.test(declaration.declaredAt ?? ""))
    errors.push("declaredAt must be an ISO date");
  const rows = Array.isArray(declaration.readFiles)
    ? declaration.readFiles
    : [];
  if (rows.length === 0)
    errors.push("readFiles must list what the author read");
  let decisionRows = 0;
  for (const [at, row] of rows.entries()) {
    if (typeof row?.path !== "string" || row.path.trim() === "")
      errors.push(`readFiles[${at}].path is required`);
    if (!HEX64.test(row?.sha256 ?? ""))
      errors.push(`readFiles[${at}].sha256 must be a sha256`);
    // S3v6-P3-1: searched anywhere in the path as written, so a `<ref>:`
    // prefix, an absolute path, `./` or a trailing note never hides it.
    const raw = String(row?.path ?? "");
    if (FORBIDDEN_READ.some((pattern) => pattern.test(raw)))
      errors.push(
        `readFiles[${at}] ${row.path} is a forbidden (observation) file`,
      );
    if (DECISIONS_RECORD.test(raw)) {
      const permitted = row.permittedRows;
      if (
        !Array.isArray(permitted) ||
        permitted.length === 0 ||
        permitted.some((id) => !PERMITTED_DECISION_ROWS.has(id)) ||
        !nonBlank(row.permittedBy)
      )
        errors.push(
          `readFiles[${at}] ${row.path} is a forbidden (observation) file unless its permittedRows are within DR-CP4-L-1〜L-15, L-18〜L-24, L-27, L-28 and DR-CP4-TR-1〜TR-14 with permittedBy`,
        );
      else decisionRows += 1;
    }
  }
  if (decisionRows > 0) {
    if (!nonBlank(declaration.decisionSummariesSeen))
      errors.push(
        "decisionSummariesSeen must disclose the run summaries inside the permitted DR rows",
      );
    // S3v6-P3-2: what false covers, and the readings chosen after dev runs.
    if (
      !nonBlank(declaration.graphRuntimeOutputObservedScope) ||
      !declaration.graphRuntimeOutputObservedScope.includes("凍結した G-case")
    )
      errors.push(
        "graphRuntimeOutputObservedScope must say that false covers the frozen G-case materials",
      );
    const chosen = declaration.readingsChosenAfterDevObservation;
    if (
      !Array.isArray(chosen) ||
      !same(
        chosen.map((row) => row?.id),
        READINGS_AFTER_DEV,
      ) ||
      chosen.some((row) => !nonBlank(row?.chosenBy) || !nonBlank(row?.basis))
    )
      errors.push(
        `readingsChosenAfterDevObservation must list ${READINGS_AFTER_DEV.join(", ")} with who chose each and on what basis`,
      );
  }
  if (!Array.isArray(declaration.accidentalReads))
    errors.push("accidentalReads must be a list (empty when none)");
  if (declaration.forbiddenFilesNotRead !== true)
    errors.push("forbiddenFilesNotRead must be true");
  return errors;
}

/**
 * S2 追補 #3: BLOCKED_CONTRACT_TABLE parsed from the harness bytes (never
 * imported or run). Returns the rows as { harnessId, condition, g01,
 * graphCases }, or null when the literal is not found.
 */
export function parseBlockedContractTable(text) {
  const head = "export const BLOCKED_CONTRACT_TABLE = Object.freeze(";
  const start = String(text).indexOf(head);
  if (start < 0) return null;
  const end = String(text).indexOf("].map(", start);
  if (end < 0) return null;
  const literal = String(text)
    .slice(start + head.length, end + 1)
    .replace(/,(\s*\])/gu, "$1");
  try {
    const rows = JSON.parse(literal);
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 4 ||
          row.some((cell) => typeof cell !== "string"),
      )
    )
      return null;
    return rows.map(([harnessId, condition, g01, graphCases]) => ({
      harnessId,
      condition,
      g01,
      graphCases,
    }));
  } catch {
    return null;
  }
}

/**
 * The pinned harness bytes: `git show <pin>:<path>` (the pin that holds the
 * path) when the commit is present, else the working tree file (whose sha256
 * the validator compares with the pin).
 */
async function readPinnedHarnessFile({ repoRoot, read, file }) {
  const pin = harnessPinOf(file);
  if (!pin) return null;
  let bytes;
  let from = "git";
  try {
    bytes = execFileSync("git", ["show", `${pin.commit}:${file}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    from = "worktree";
    try {
      bytes = await read(file);
    } catch {
      return null;
    }
  }
  return { bytes, from, commit: pin.commit, sha256: sha256(bytes) };
}

async function readHarnessBlockedTable({ repoRoot, read }) {
  const pinned = await readPinnedHarnessFile({
    repoRoot,
    read,
    file: BLOCKED_TABLE_SOURCE.path,
  });
  if (!pinned) return null;
  const table = parseBlockedContractTable(pinned.bytes.toString("utf8"));
  if (!table) return null;
  return {
    table,
    source: {
      ...BLOCKED_TABLE_SOURCE,
      from: pinned.from,
      sha256: pinned.sha256,
    },
  };
}

/**
 * S2 追補 #4: one exported constant's literal (a number with `_`
 * separators, or a double-quoted string) in harness source text; undefined
 * when absent.
 */
export function parseHarnessConstant(text, name) {
  const match = new RegExp(
    `^export const ${name} = (?:([0-9][0-9_]*)|"([^"\\n]*)");$`,
    "mu",
  ).exec(String(text));
  if (!match) return undefined;
  return match[1] !== undefined
    ? Number(match[1].replaceAll("_", ""))
    : match[2];
}

/**
 * S4 の最終関門の P3-3: the K6/4 freeze commit S2's contracts.k64.freezeCommit
 * must equal, read from the pinned bytes of the harness's constants.mjs
 * (never imported or run).
 */
export const K64_FREEZE_SOURCE = Object.freeze({
  path: `${HARNESS_DIR}constants.mjs`,
  name: "K64_FREEZE",
  field: "freezeCommit",
});

/**
 * S4 の最終関門の P3-3: K64_FREEZE.freezeCommit (a 40-hex) in the harness's
 * constants.mjs text; undefined when the object literal or the field (exactly
 * once) is absent.
 */
export function parseK64FreezeCommit(text) {
  const block =
    /^export const K64_FREEZE = Object\.freeze\(\{\n([\s\S]*?)\n\}\);$/mu.exec(
      String(text),
    );
  if (!block) return undefined;
  const rows = [
    ...block[1].matchAll(/^ {2}freezeCommit: "([0-9a-f]{40})",$/gmu),
  ];
  return rows.length === 1 ? rows[0][1] : undefined;
}

/** S4 の最終関門の P3-3: K64_FREEZE.freezeCommit from the pinned bytes; null on a miss. */
async function readHarnessK64Freeze({ repoRoot, read }) {
  const pinned = await readPinnedHarnessFile({
    repoRoot,
    read,
    file: K64_FREEZE_SOURCE.path,
  });
  if (!pinned) return null;
  const commit = parseK64FreezeCommit(pinned.bytes.toString("utf8"));
  if (commit === undefined) return null;
  return {
    commit,
    source: {
      path: K64_FREEZE_SOURCE.path,
      commit: pinned.commit,
      from: pinned.from,
      sha256: pinned.sha256,
    },
  };
}

/**
 * S2 追補 #9（DR-CP4-T-1）: one unexported module constant (`const NAME =
 * literal;` at the start of a line, exactly once) in harness source text;
 * undefined when absent, exported or repeated.
 */
export function parseHarnessModuleConstant(text, name) {
  const rows = [
    ...String(text).matchAll(
      new RegExp(`^const ${name} = (?:([0-9][0-9_]*)|"([^"\\n]*)");$`, "gmu"),
    ),
  ];
  if (rows.length !== 1) return undefined;
  const [match] = rows;
  return match[1] !== undefined
    ? Number(match[1].replaceAll("_", ""))
    : match[2];
}

/**
 * S2 追補 #9（DR-CP4-T-4 (a)）: the kinds the harness plan's readyProbeOf
 * applies V-10 READY to, when the plan defines it once as one equality and
 * both formalRunPlan and devRunSpec use it (and the earlier `!isOneShot`
 * reading is gone); undefined otherwise.
 */
export function parseReadyProbeKinds(text) {
  const source = String(text);
  const rows = [
    ...source.matchAll(
      /^const readyProbeOf = \(kind\) => kind === "([a-z-]+)";$/gmu,
    ),
  ];
  if (rows.length !== 1) return undefined;
  const uses = source.split("readyProbe: readyProbeOf(kind),").length - 1;
  if (uses !== 2 || source.includes("readyProbe: !isOneShot")) return undefined;
  return [rows[0][1]];
}

/** S2 追補 #9: readyProbeOf's kinds from the pinned bytes; null on a miss. */
async function readHarnessReadyProbe({ repoRoot, read }) {
  const pinned = await readPinnedHarnessFile({
    repoRoot,
    read,
    file: READY_PROBE_SOURCE.path,
  });
  if (!pinned) return null;
  const kinds = parseReadyProbeKinds(pinned.bytes.toString("utf8"));
  if (kinds === undefined) return null;
  return {
    kinds,
    source: {
      path: READY_PROBE_SOURCE.path,
      commit: pinned.commit,
      from: pinned.from,
      sha256: pinned.sha256,
    },
  };
}

/**
 * S2 追補 #4: HARNESS_CONSTANTS from the pinned bytes; null on any miss.
 * S2 追補 #9: and HARNESS_MODULE_CONSTANTS under their `as` names.
 */
async function readHarnessConstants({ repoRoot, read }) {
  const values = {};
  const sources = [];
  const files = [
    ...Object.entries(HARNESS_CONSTANTS).map(([file, names]) => [
      file,
      names.map((name) => ({ name, as: name, parse: parseHarnessConstant })),
    ]),
    ...Object.entries(HARNESS_MODULE_CONSTANTS).map(([file, rows]) => [
      file,
      rows.map((row) => ({ ...row, parse: parseHarnessModuleConstant })),
    ]),
  ];
  for (const [file, names] of files) {
    const pinned = await readPinnedHarnessFile({ repoRoot, read, file });
    if (!pinned) return null;
    const text = pinned.bytes.toString("utf8");
    for (const { name, as, parse } of names) {
      const value = parse(text, name);
      if (value === undefined || Object.hasOwn(values, as)) return null;
      values[as] = value;
    }
    sources.push({
      path: file,
      commit: pinned.commit,
      from: pinned.from,
      sha256: pinned.sha256,
    });
  }
  return { values, sources };
}

/**
 * S2 追補 #4: git for the pins (cached per commit and path), or null in a
 * shallow clone or without git (the formal gate always checks).
 */
function sourcePinGitContext(repoRoot) {
  try {
    const shallow = execFileSync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (shallow !== "false") return null;
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { head, ...cachedGit(repoRoot) };
  } catch {
    return null;
  }
}

function cachedGit(repoRoot) {
  const blobs = new Map();
  const ancestors = new Map();
  return {
    blobSha: (commit, file) => {
      const key = `${commit}:${file}`;
      if (!blobs.has(key)) blobs.set(key, gitBlobSha(repoRoot, commit, file));
      return blobs.get(key);
    },
    isAncestor: (ancestor, descendant) => {
      const key = `${ancestor}..${descendant}`;
      if (!ancestors.has(key))
        ancestors.set(
          key,
          HEX40.test(String(ancestor)) &&
            isAncestor(repoRoot, ancestor, descendant),
        );
      return ancestors.get(key);
    },
  };
}

/** Reads every file the validators compare against. */
export async function loadObservationPrepContext({ repoRoot }) {
  const read = (relative) => readFile(path.join(repoRoot, relative));
  // The current freeze (B1 review P3-6): its cases are the frozen fixtures.
  const freezeBytes = await read(NIR1_GRAPH_FREEZE_PATH);
  const freezeJson = JSON.parse(freezeBytes);
  const frozen = new Map(
    (freezeJson.cases ?? []).map((row) => [row.caseId, row]),
  );
  const fixture = async (caseId) => {
    const entry = frozen.get(caseId);
    const bytes = await read(entry.path);
    return {
      path: entry.path,
      sha256: sha256(bytes),
      frozenSha256: entry.sha256,
      json: JSON.parse(bytes),
    };
  };
  const fixtures = {};
  for (const caseId of frozen.keys()) fixtures[caseId] = await fixture(caseId);
  const fileSha256 = {};
  const parsed = {};
  for (const [name, relative] of Object.entries(OBSERVATION_PREP_FILES)) {
    try {
      const bytes = await read(relative);
      fileSha256[relative] = sha256(bytes);
      parsed[name] = JSON.parse(bytes);
    } catch {
      parsed[name] = null;
    }
  }
  let supersededDeclarationAddendum = null;
  try {
    const bytes = await read(DECLARATION_ADDENDUM_V1.path);
    supersededDeclarationAddendum = {
      sha256: sha256(bytes),
      json: JSON.parse(bytes),
    };
  } catch {
    // Absent or unreadable: the supersedes check fails closed.
  }
  const formal = PROCEDURE_V1;
  let procedureFormal = null;
  try {
    const bytes = await read(formal);
    fileSha256[formal] = sha256(bytes);
    procedureFormal = JSON.parse(bytes);
  } catch {
    // The v1 procedure file is S4's; absent in a draft.
  }
  // SP/1 bytes, once placed on master (S3v2-P3-4); null while absent.
  let sp1Sha256;
  try {
    sp1Sha256 = sha256(await read(SP1.path));
  } catch {
    sp1Sha256 = null;
  }
  const productSources = {};
  for (const relative of Object.values(PRODUCT_SOURCES))
    productSources[relative] = (await read(relative)).toString("utf8");
  const blocked = await readHarnessBlockedTable({ repoRoot, read });
  const constants = await readHarnessConstants({ repoRoot, read });
  const k64Freeze = await readHarnessK64Freeze({ repoRoot, read });
  const readyProbe = await readHarnessReadyProbe({ repoRoot, read });
  return {
    harnessK64Freeze: k64Freeze,
    harnessReadyProbe: readyProbe,
    harnessBlockedTable: blocked?.table ?? null,
    harnessBlockedTableSource: blocked?.source ?? null,
    harnessConstants: constants?.values ?? null,
    harnessConstantSources: constants?.sources ?? null,
    sourcePinGit: sourcePinGitContext(repoRoot),
    freeze: { sha256: sha256(freezeBytes), json: freezeJson },
    g01: fixtures["G-01"],
    fixtures,
    fileSha256,
    productSources,
    setupAddendum: parsed.setupAddendum,
    declarationAddendum: parsed.declarationAddendum,
    supersededDeclarationAddendum,
    procedureDraft: parsed.procedureDraft,
    procedureFormal,
    sp1Sha256,
    parsed,
  };
}

/** eval:fixtures: every observation-prep document, draft or frozen. */
export async function validateNir1ObservationPrep({ repoRoot }) {
  const ctx = await loadObservationPrepContext({ repoRoot });
  const errors = [];
  const add = (label, list) =>
    errors.push(...list.map((e) => `${label}: ${e}`));
  for (const [name, relative] of Object.entries(OBSERVATION_PREP_FILES))
    if (ctx.parsed[name] === null)
      errors.push(`${relative} is missing or not JSON`);
  if (errors.length > 0)
    return { status: "failed", errors, formalReady: false, placeholders: [] };
  add(
    OBSERVATION_PREP_FILES.setupAddendum,
    setupAddendumErrors(ctx.parsed.setupAddendum, ctx),
  );
  add(
    OBSERVATION_PREP_FILES.declarationAddendum,
    declarationAddendumErrors(ctx.parsed.declarationAddendum, ctx),
  );
  add(
    OBSERVATION_PREP_FILES.traceEditing,
    traceErrors(ctx.parsed.traceEditing, ctx),
  );
  if (ctx.parsed.traceEditing?.kind !== "editing")
    errors.push(`${OBSERVATION_PREP_FILES.traceEditing}: kind must be editing`);
  add(
    OBSERVATION_PREP_FILES.traceBrowsing,
    traceErrors(ctx.parsed.traceBrowsing, ctx),
  );
  if (ctx.parsed.traceBrowsing?.kind !== "browsing")
    errors.push(
      `${OBSERVATION_PREP_FILES.traceBrowsing}: kind must be browsing`,
    );
  add(
    OBSERVATION_PREP_FILES.procedureDraft,
    procedureDraftErrors(ctx.parsed.procedureDraft),
  );
  add(OBSERVATION_PREP_FILES.prep, observationPrepErrors(ctx.parsed.prep, ctx));
  add(
    OBSERVATION_PREP_FILES.authorDeclaration,
    authorDeclarationErrors(ctx.parsed.authorDeclaration),
  );
  add(
    OBSERVATION_PREP_FILES.seedPinAddendum,
    seedPinAddendumErrors(ctx.parsed.seedPinAddendum, ctx),
  );
  const placeholders = (ctx.parsed.prep?.placeholders ?? []).map(
    (row) => row.token,
  );
  const formalReady =
    errors.length === 0 &&
    placeholders.length === 0 &&
    ctx.parsed.prep?.status === PREP_FROZEN &&
    [
      ctx.parsed.setupAddendum,
      ctx.parsed.declarationAddendum,
      ctx.parsed.traceEditing,
      ctx.parsed.traceBrowsing,
      ctx.parsed.seedPinAddendum,
    ].every((document) => document?.status === ADDENDUM_STATUSES[1]);
  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    formalReady,
    placeholders,
  };
}

function gitBlobSha(repoRoot, commit, file) {
  try {
    const bytes = execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return sha256(bytes);
  } catch {
    return null;
  }
}

function isAncestor(repoRoot, ancestor, head) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, head], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Each referenced (path, commit, sha256): the commit holds those bytes and is
 * a strict ancestor of `head` (the commit that froze the record cannot name
 * its own hash; S4a holds the bytes, S4b fills the placeholders).
 */
export function formalReferenceErrors(rows, head, git) {
  const errors = [];
  for (const row of rows) {
    if (row.commit === head)
      errors.push(
        `${row.path} is referenced at the record's own commit ${head}; it must be a strict ancestor (S4a before S4b)`,
      );
    if (git.blobSha(row.commit, row.path) !== row.sha256)
      errors.push(`${row.path} at ${row.commit} is not the referenced bytes`);
    if (!git.isAncestor(row.commit, head))
      errors.push(`${row.commit} is not an ancestor of ${head}`);
  }
  return errors;
}

/**
 * The gate a formal CP-4 Graph run passes before its first query: every
 * document frozen and reviewed, no placeholder, and (git) each referenced
 * commit holds the referenced bytes and is an ancestor of `head`.
 */
export async function assertObservationPrepFormal({
  repoRoot,
  head: headRef = "HEAD",
}) {
  const result = await validateNir1ObservationPrep({ repoRoot });
  if (result.errors.length > 0)
    throw new Error(
      `[precheck] the observation-prep documents are invalid: ${result.errors.join("; ")}`,
    );
  if (!result.formalReady)
    throw new Error(
      `[precheck] the observation-prep record is a draft or keeps placeholder(s) (${result.placeholders.join(", ") || "status"}); a formal run cannot use it`,
    );
  const prep = JSON.parse(
    await readFile(path.join(repoRoot, OBSERVATION_PREP_FILES.prep), "utf8"),
  );
  const references = [
    ...prep.traces,
    ...prep.boundFiles,
    {
      path: prep.k64Procedure.formal.path,
      commit: prep.k64Procedure.formal.commit,
      sha256: prep.k64Procedure.formal.sha256,
    },
    {
      path: SP1.path,
      commit: prep.contracts.sp1.bytesCommit,
      sha256: SP1.sha256,
    },
  ];
  const head = execFileSync(
    "git",
    ["rev-parse", "--verify", `${headRef}^{commit}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).trim();
  const git = {
    blobSha: (commit, file) => gitBlobSha(repoRoot, commit, file),
    isAncestor: (ancestor, descendant) =>
      isAncestor(repoRoot, ancestor, descendant),
  };
  const errors = [
    ...formalReferenceErrors(references, head, git),
    // S2 追補 #4: the pins against git, also in a shallow clone (a missing
    // commit is an error here).
    ...sourcePinGitErrors(prep.setupReadings?.source?.pins ?? [], head, git),
  ];
  if (errors.length > 0) throw new Error(`[precheck] ${errors.join("; ")}`);
  return { proceed: true };
}
