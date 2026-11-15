// Synthetic receipts only (DR-CP4-QV-1). Every sample list is built from the
// frozen fixtures' own predeclared lists, so the end-to-end checks also prove
// that the loader, the scorer and the fixture expectations agree. Receipts
// are written to a fresh temp directory; nothing in the repository changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";
import {
  GRAPH_EVAL_B_MS,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_HYBRID_P95_LIMIT_MS,
  GRAPH_EVAL_VARIANTS,
  K65_FREEZE,
  K66_FREEZE,
  K67_FREEZE,
} from "./constants.mjs";
import {
  DEFAULT_ROOT,
  GRAPH_MANIFEST,
  PROCEDURE_FILE,
  RETRIEVAL_MANIFEST,
  buildQualityVerdict as buildVerdict,
  loadExpectations,
  loadQualityInputs as loadInputs,
  readMetricTolerance,
  readReceiptDir,
  renderSummary,
  sha256,
  verifyBindings as verifyBindingsOf,
} from "./quality-verdict-cli.mjs";
import {
  d3Missing,
  d3Problems,
  deriveLatencyPolicy,
  evaluateQualityVerdict,
  latestTypedRevisionOf,
} from "./quality-verdict.mjs";
import {
  evaluateEvidenceItems,
  textSha256,
} from "./quality-evidence-items.mjs";
import { H40, followUpRecord, k64Sample, k66Sample } from "./test-support.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

// The verdict reads the formal procedure file with `loadProcedureFile` at the
// S4 commit. The repository's v2 still carries S3's placeholder review (S2
// 追補 #14 fills it), which the formal loader refuses, so these tests read a
// throwaway repository holding the same v2 with a recorded review, committed:
// that commit is the S4 commit of the allow list. The real v2 file (the
// placeholder) is checked to be refused in the last test.
const PROC_REPO = mkdtempSync(path.join(tmpdir(), "qv-procedure-"));
process.on("exit", () => rmSync(PROC_REPO, { recursive: true, force: true }));
const REVIEWED_V2 = {
  ...JSON.parse(readFileSync(path.join(DEFAULT_ROOT, PROCEDURE_FILE), "utf8")),
  review: {
    reviewer: "independent reviewer (test)",
    reviewedAt: "2026-11-08",
    record: "scratchpad/s3/test-review.json",
  },
};
const PROCEDURE_BYTES = `${JSON.stringify(REVIEWED_V2, null, 2)}\n`;
git(PROC_REPO, "init", "-q", "-b", "main");
mkdirSync(path.join(PROC_REPO, path.dirname(PROCEDURE_FILE)), {
  recursive: true,
});
writeFileSync(path.join(PROC_REPO, PROCEDURE_FILE), PROCEDURE_BYTES);
git(PROC_REPO, "add", PROCEDURE_FILE);
git(
  PROC_REPO,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@example.invalid",
  "commit",
  "-q",
  "-m",
  "reviewed v2",
);
const S4 = git(PROC_REPO, "rev-parse", "HEAD");
// K6/6 変える点 8: the tests hold the receipts to a descriptor of their own
// (the same bytes, a synthetic freeze commit). The pinned default refuses a
// receipt with that synthetic head (last test).
const TEST_K66 = { ...K66_FREEZE, freezeCommit: "6".repeat(40) };
// K6/7 変える点 8: and the /7 freeze, held the same way.
const TEST_K67 = { ...K67_FREEZE, freezeCommit: "7".repeat(40) };
const buildQualityVerdict = (options) =>
  buildVerdict({
    procedureRoot: PROC_REPO,
    freeze66: TEST_K66,
    freeze67: TEST_K67,
    ...options,
  });
const loadQualityInputs = (options) =>
  loadInputs({
    procedureRoot: PROC_REPO,
    freeze66: TEST_K66,
    freeze67: TEST_K67,
    ...options,
  });
const verifyBindings = (output, options) =>
  verifyBindingsOf(output, {
    procedureRoot: PROC_REPO,
    freeze66: TEST_K66,
    freeze67: TEST_K67,
    ...options,
  });
const CANDIDATE = H40("c");
const RUN = { startedAtMs: 1_000, finishedAtMs: 61_000 };
const WINDOW = [0, 20_000, 40_000, 62_000].map((atMs) => ({
  atMs,
  locksReadable: true,
  heavySlotFiles: 3,
  heavySlotsInUse: 0,
  buildProcesses: [],
  otherMeasurements: [],
  sameWorktreeBuild: false,
}));
const readJson = (relative) =>
  JSON.parse(readFileSync(path.join(DEFAULT_ROOT, relative), "utf8"));
const PROCEDURE_SHA = sha256(PROCEDURE_BYTES);
const K65_HEAD = {
  freezeCommit: K65_FREEZE.freezeCommit,
  sha256: K65_FREEZE.sha256,
};
const K66_HEAD = {
  freezeCommit: TEST_K66.freezeCommit,
  sha256: TEST_K66.sha256,
};
const K67_HEAD = {
  freezeCommit: TEST_K67.freezeCommit,
  sha256: TEST_K67.sha256,
};

/** The predeclared R+IR and R+IR+Graph lists of each catalog variant. */
function fixtureLists(variant) {
  const fixture = readJson(variant.fixturePath);
  if (variant.caseId === "G-01")
    return {
      hybrid: fixture.expectations.rPlusIr,
      graph: fixture.expectations.rPlusIrPlusGraph,
    };
  const arms = fixture.variants.find((row) => row.id === variant.variantId)
    .expectations.arms;
  return {
    hybrid: arms.rPlusIr.sceneIds,
    graph: arms.rPlusIrPlusGraph.sceneIds,
  };
}

/**
 * Prereg v3: the four items' receipt fields for one variant, built from its
 * frozen fixture's own expectations (never from a product): every displayed
 * edge carries the Evidence rows of both endpoints' current summary
 * (`[0, len)`), the Graph-only row carries the fixture's range and the body's
 * hash, the R+IR rows are the paired list. `change.v3` (a function) mutates
 * the returned data; `true` keeps it.
 */
function v3Base(variant, expectation) {
  const fixture = readJson(variant.fixturePath);
  const plan = expectation.evidence;
  const ent = (id) => `e-${id}`;
  const relations = new Map(
    [
      ...(fixture.relations ?? []),
      ...(fixture.relation ? [fixture.relation] : []),
    ].map((row) => [row.id, row]),
  );
  const summaryOf = (logical) => plan.entityTexts[logical][1];
  const evidenceId = (edge, logical) => `ev-${edge}-${logical}`;
  const edgeOf = (edgeId) => {
    const row = relations.get(edgeId);
    return {
      from: ent(row.fromEntityId),
      to: ent(row.toEntityId),
      evidence: [row.fromEntityId, row.toEntityId].map((logical) => ({
        evidenceId: evidenceId(edgeId, logical),
        quoteSha256: textSha256(summaryOf(logical)),
      })),
    };
  };
  const contributions = expectation.expectedContributions;
  const only = contributions.find((row) => row.kind === "graph-only");
  const typedRevisions = new Map();
  for (const row of contributions)
    for (const edgeId of row.edgeIds) {
      const rel = relations.get(edgeId);
      typedRevisions.set(`rev-of-${edgeId}`, {
        logicalRevisionId: `rev-of-${edgeId}`,
        runtimeRevisionId: `runtime-rev-of-${edgeId}`,
        evidence: [rel.fromEntityId, rel.toEntityId].map((logical) => ({
          evidenceId: evidenceId(edgeId, logical),
          sourceRef: `codex:${ent(logical)}`,
          startUtf16: 0,
          endUtf16: summaryOf(logical).length,
          quoteSha256: textSha256(summaryOf(logical)),
        })),
      });
    }
  const seedLogical =
    fixture.expectations?.graphPath?.seedEntityId ??
    fixture.variants?.find((row) => row.id === variant.variantId)?.expectations
      .pathAttachments?.[0]?.path.seedEntityId ??
    fixture.variants?.find((row) => row.id === variant.variantId)?.expectations
      .addedScene?.path.seedEntityId ??
    null;
  const rows = (list) =>
    list.map((id) => ({
      sceneId: `u-${id}`,
      kind: "raw",
      excerptSha256: textSha256(`excerpt of ${id}`),
      excerptUtf16Length: 20 + id.length,
    }));
  const hybrid = fixtureLists(variant).hybrid;
  const graphOnly =
    plan.graphOnly && plan.sceneExcerpt
      ? {
          sceneId: `u-${plan.graphOnly.sceneId}`,
          hop: plan.graphOnly.hop,
          pinEntityId: ent(plan.graphOnly.pinEntityId),
          canonicalRange: { ...plan.sceneExcerpt.range },
          excerptSha256: textSha256(plan.sceneExcerpt.body),
          excerptUtf16Length: plan.sceneExcerpt.body.length,
          edges: only ? only.edgeIds.map(edgeOf) : [],
        }
      : null;
  return {
    entities: Object.fromEntries(
      Object.keys(plan.entityTexts).map((id) => [id, ent(id)]),
    ),
    seed: seedLogical
      ? { logical: seedLogical, runtime: ent(seedLogical) }
      : null,
    observation: {
      typedRevisions: [...typedRevisions.values()],
      readAfterSamples: true,
    },
    parent: { queryGeneration: 41, rowExcerpts: rows(hybrid) },
    child: {
      // A real run's follow-up is two generations after its parent.
      queryGeneration: 43,
      evidence: {
        graphOnly,
        pathAttachments: contributions
          .filter((row) => row.kind === "path-attachment")
          .map((row) => ({
            sceneId: `u-${row.sceneId}`,
            hop: plan.attachments.find((entry) => entry.sceneId === row.sceneId)
              .hop,
            edges: row.edgeIds.map(edgeOf),
          })),
      },
      rowExcerpts: [
        ...rows(hybrid),
        ...(graphOnly
          ? [
              {
                sceneId: graphOnly.sceneId,
                kind: "graph-only",
                excerptSha256: graphOnly.excerptSha256,
                excerptUtf16Length: graphOnly.excerptUtf16Length,
              },
            ]
          : []),
      ],
    },
    edgeOf,
  };
}

/**
 * Receipts for the 13 variants from `expectations`. `edit(key, ctx)` may
 * return { hybrid, graph, graphLists, latency, child, parent, receipt } to
 * change one variant.
 */
function buildReceipts(expectations, edit = () => ({})) {
  return GRAPH_EVAL_VARIANTS.map((variant) => {
    const key = variant.key;
    const base = fixtureLists(variant);
    const change = edit(key, { variant, expectation: expectations[key] }) ?? {};
    const hybridLogical = change.hybrid ?? base.hybrid;
    const graphLogical = change.graph ?? base.graph;
    const logicals = new Set([
      ...hybridLogical,
      ...graphLogical,
      "scene-query",
    ]);
    for (const id of expectations[key].forbiddenSceneIds) logicals.add(id);
    const scenes = Object.fromEntries(
      [...logicals].map((id) => [id, `u-${id}`]),
    );
    const runtime = (list) => list.map((id) => `u-${id}`);
    const unavailable = variant.expectedGraph === "unavailable";
    const contributions = expectations[key].expectedContributions;
    const v3 = change.v3
      ? (typeof change.v3 === "function" ? change.v3 : (data) => data)(
          v3Base(variant, expectations[key]),
        )
      : null;
    const samples = [];
    for (let repeat = 0; repeat < 30; repeat += 1) {
      const latency = change.latency?.(repeat) ?? { hybrid: 30, graph: 30 };
      const hybridRow = {
        variantKey: key,
        arm: "hybrid",
        phase: "measured",
        repeat,
        trigger: "user-operation",
        tFetch: 100,
        tReturn: 100 + latency.hybrid,
        status: "completed",
        finalSceneIds: runtime(hybridLogical),
      };
      samples.push(change.mapHybridSample?.(hybridRow, repeat) ?? hybridRow);
      const material = {
        matched: contributions.map((row) => `${row.kind}:${row.sceneId}`),
        unresolvedEdges: 0,
        observed: contributions.map((row) => ({
          kind: row.kind,
          sceneId: row.sceneId,
          pairs: row.edgeIds.map((edge) => `rev-of-${edge}|${edge}`),
          unresolved: 0,
        })),
      };
      const graphSample = unavailable
        ? k64Sample(
            {
              variantKey: key,
              repeat,
              finalSceneIds: runtime(hybridLogical),
              graph: { outcome: "graph-unavailable", reason: "index-state" },
            },
            { child: null },
          )
        : k64Sample(
            {
              variantKey: key,
              repeat,
              finalSceneIds: runtime(hybridLogical),
            },
            {
              parent: {
                rSceneIds: runtime(hybridLogical),
                irSceneIds: [],
                ...(v3 ? clone(v3.parent) : {}),
                ...change.parent,
              },
              child: {
                rSceneIds: runtime(hybridLogical),
                irSceneIds: [],
                finalSceneIds: runtime(
                  change.graphLists?.(repeat) ?? graphLogical,
                ),
                edgeCount: contributions.length,
                materialRevision:
                  change.material?.(repeat, material) ?? material,
                ...(v3 ? clone(v3.child) : {}),
                ...change.child,
              },
            },
          );
      const merged = {
        ...graphSample,
        tFetch: 100,
        tReturn: 100 + latency.graph,
        status: "completed",
      };
      samples.push(change.mapGraphSample?.(merged, repeat) ?? merged);
    }
    const receipt = {
      schemaVersion: "nir1-cp4-run-receipt/1",
      runKind: "g-case-gold",
      runnerKind: "k64-hook-consumer",
      runId: `gold-test/${key}`,
      preview: false,
      run: RUN,
      head: {
        observationPrep: { commit: S4 },
        k65: K65_HEAD,
        k66: K66_HEAD,
        k67: K67_HEAD,
      },
      candidate: { commit: CANDIDATE },
      environment: { windowSamples: WINDOW, ownPids: [] },
      settings: {
        variantKey: key,
        setupReceipt: {
          logicalToRuntime: {
            scenes,
            ...(v3 ? { entities: v3.entities } : {}),
            // The setup record's typed Revisions in prepare order (D3 (d)).
            // `change.typedRevisions` replaces them; `null` leaves them out.
            ...(change.typedRevisions === null
              ? {}
              : {
                  typedRevisions: change.typedRevisions ?? {
                    "g08-r-cass": {
                      id: "g08-r-cass",
                      relationIds: ["g08-rents-to-cass"],
                      decision: "approved",
                      revisionId: "runtime-g08-r-cass",
                    },
                    "g08-r-juno": {
                      id: "g08-r-juno",
                      relationIds: ["g08-rents-to-juno"],
                      decision: "approved",
                      revisionId: "runtime-g08-r-juno",
                    },
                  },
                }),
          },
          // The setup driver records a Revision refused at a stage here.
          ...(change.refusedAtSetup
            ? { refusedAtSetup: change.refusedAtSetup }
            : {}),
        },
        k64: { procedureFile: { sha256: PROCEDURE_SHA } },
        ...(v3?.seed ? { seed: v3.seed } : {}),
      },
      ...(v3 && v3.observation ? { evidenceObservation: v3.observation } : {}),
      samples,
      verdict: { outcome: "recorded" },
      ...change.receipt,
    };
    return receipt;
  });
}

function writeDir(receipts, { tamper = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qv-test-"));
  const lines = [];
  for (const receipt of receipts) {
    const name = `${receipt.settings.variantKey.replace("/", "_")}.receipt.json`;
    const text = JSON.stringify(receipt);
    lines.push(`${sha256(text)}  ./${name}`);
    writeFileSync(path.join(dir, name), tamper ? tamper(name, text) : text);
    writeFileSync(
      path.join(dir, name.replace(".receipt.json", ".validation.json")),
      JSON.stringify({ valid: true, errors: [] }),
    );
  }
  writeFileSync(path.join(dir, "files.sha256"), `${lines.join("\n")}\n`);
  writeFileSync(
    path.join(dir, "allow.json"),
    JSON.stringify({ s4Commit: S4, candidate: CANDIDATE }),
  );
  return dir;
}

function run(edit, options = {}) {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const dir = writeDir(buildReceipts(expectations, edit), options);
  try {
    return buildQualityVerdict({
      goldDir: dir,
      allowListPath: options.allowListPath ?? path.join(dir, "allow.json"),
      ledgerPath: options.ledgerPath ?? null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// G-08's frozen fixture: its `revisions` array order is cass, juno; the observed
// path of an `index-ready` child resolves the Relation of the first.
const REL = "g08-rents-to-cass";
const OBSERVED_PAIR = `g08-r-cass|${REL}`;
const statusOf = (output, id) => output.conditions[id].status;
const keyOf = (output, key) =>
  output.variants.find((row) => row.variantKey === key);

test("the baseline: five conditions on lists built from the fixtures' own predeclared expectations", () => {
  const output = run();
  assert.equal(output.positioning, "outside-procedure-supplementary-record");
  // G-01 reproduces the predeclared 0 / 0 -> 1 / 0.63093 through scoreQuery.
  const g01 = output.conditions["g01-predeclared-improvement"];
  assert.equal(g01.status, "pass");
  assert.equal(g01.rPlusIr.recallAt8, 0);
  assert.equal(g01.graph.recallAt8, 1);
  assert.ok(Math.abs(g01.graph.ndcgAt8 - 0.6309297535714574) < 1e-12);
  // Every variant's computed metrics equal its fixture expectation.
  for (const row of output.variants)
    assert.deepEqual(
      row.expectationMatch,
      { rPlusIr: true, graph: true },
      row.variantKey,
    );
  // The conditions that can be settled pass; the rest is disclosed, not passed.
  assert.equal(
    output.conditions["macro-non-regression"].components["g-case"].status,
    "pass",
  );
  assert.equal(statusOf(output, "macro-non-regression"), "not-evaluable");
  assert.equal(statusOf(output, "hybrid-p95"), "pass");
  assert.equal(output.conditions["hybrid-p95"].hybridArm.n, 390);
  assert.equal(output.conditions["hybrid-p95"].hybridArm.p95Ms, 30);
  assert.equal(
    output.conditions["evidence-validity"].components["edge-binding"].status,
    "pass",
  );
  assert.equal(
    output.conditions["evidence-validity"].components["edge-binding"].checked,
    270,
  );
  // Prereg v3: a receipt without the four items' fields (every receipt up to
  // s7r2 and this synthetic one) holds them; it never passes and never
  // leaves them `not-evaluable`. The variants a fixture's `requirements` do
  // not apply an item to stay `n/a`.
  assert.equal(statusOf(output, "evidence-validity"), "hold");
  const items = output.conditions["evidence-validity"].components;
  assert.deepEqual(
    [
      "utf16-range",
      "explicit-pin-association",
      "raw-excerpt-unchanged",
      "added-scene-body-anchor",
    ].map((id) => [id, items[id].status, items[id].applicableVariants]),
    [
      ["utf16-range", "hold", 9],
      ["explicit-pin-association", "hold", 9],
      ["raw-excerpt-unchanged", "hold", 6],
      ["added-scene-body-anchor", "hold", 6],
    ],
  );
  const forbidden = output.conditions["forbidden-contribution"].components;
  assert.equal(
    forbidden["a-forbidden-scene-or-blocked-candidate"].status,
    "pass",
  );
  assert.equal(forbidden["b-late-graph-in-display"].status, "pass");
  assert.equal(statusOf(output, "forbidden-contribution"), "not-evaluable");
  // The whole is never a pass while an item is unverified.
  assert.deepEqual(output.verdict, {
    verdict: "hold",
    reasons: ["held-required-items", "unverified-required-items"],
    failed: [],
    held: ["evidence-validity"],
    unverified: ["macro-non-regression", "forbidden-contribution"],
  });
  const listed = output.notEvaluable.map(
    (row) => `${row.condition}/${row.component}`,
  );
  assert.ok(listed.includes("macro-non-regression/existing-24-graph-arm"));
  assert.ok(!listed.some((row) => row.startsWith("evidence-validity/")));
  assert.ok(
    listed.includes(
      "forbidden-contribution/c-existing-24-graph-appearance-and-dto",
    ),
  );
  assert.match(
    renderSummary(output),
    /全体：hold（held-required-items、unverified-required-items）/u,
  );
});

test("condition 1 (G-01): fail when the late child does not change the list, hold when it improves differently", () => {
  // graph-late child not applied: the displayed list stays R+IR.
  const flat = run((key, { variant }) =>
    variant.caseId === "G-01"
      ? { graphLists: () => fixtureLists(variant).hybrid }
      : {},
  );
  assert.equal(statusOf(flat, "g01-predeclared-improvement"), "fail");
  // An improvement that differs from the predeclared metrics is a Hold.
  const other = run((key, { variant }) =>
    variant.caseId === "G-01"
      ? {
          graphLists: () => [
            "g01-mira",
            ...fixtureLists(variant).graph.slice(0, 1),
          ],
        }
      : {},
  );
  assert.equal(statusOf(other, "g01-predeclared-improvement"), "hold");
  assert.equal(other.conditions["g01-predeclared-improvement"].improved, true);
});

test("condition 2 (macro): the G-case mean fails when the Graph display loses what R+IR showed", () => {
  // Every variant's R+IR already shows its Gold Scenes; the Graph display drops them.
  const output = run((key, { variant, expectation }) => {
    const lists = fixtureLists(variant);
    const gold = Object.entries(expectation.grades)
      .filter(([, grade]) => grade > 0)
      .map(([id]) => id);
    return {
      hybrid: [
        ...new Set([...lists.hybrid.slice(0, 8 - gold.length), ...gold]),
      ],
      graphLists: () =>
        lists.hybrid
          .slice(0, 8 - gold.length)
          .filter((id) => !gold.includes(id)),
    };
  });
  const gcase = output.conditions["macro-non-regression"].components["g-case"];
  assert.equal(gcase.status, "fail");
  assert.ok(gcase.recallAt8.graph < gcase.recallAt8.rPlusIr);
  assert.equal(
    keyOf(output, "G-02/base").conditions["macro-non-regression"].status,
    "fail",
  );
  assert.equal(statusOf(output, "macro-non-regression"), "fail");
  assert.ok(output.verdict.failed.includes("macro-non-regression"));
  // One variant's loss is offset by the others' gains: the mean decides.
  const offset = run((key, { variant }) =>
    key === "G-05/base"
      ? { graphLists: () => fixtureLists(variant).hybrid.slice(0, 1) }
      : {},
  );
  assert.equal(
    keyOf(offset, "G-05/base").conditions["macro-non-regression"].status,
    "fail",
  );
  assert.equal(
    offset.conditions["macro-non-regression"].components["g-case"].status,
    "pass",
  );
});

test("K6/5-N4（条件 3）: Hybrid p95 の判定の境界は 94.2 ms で、65.04 ms と 240 ms ではない。arm ごとに pool し、どちらかに failed があれば fail", () => {
  assert.equal(GRAPH_EVAL_B_MS, 54.2);
  assert.equal(GRAPH_EVAL_D_MS, 40);
  assert.equal(GRAPH_EVAL_HYBRID_P95_LIMIT_MS, 94.2);
  const withLatency = (latency) => run(() => ({ latency: () => latency }));
  const p95 = (output) => output.conditions["hybrid-p95"];
  // 65.04 ms（P の評価の上限）と 94.2 ms の間の値は pass（旧い上限なら fail）。
  for (const ms of [65.05, 80, 94.1]) {
    const output = withLatency({ hybrid: ms, graph: ms });
    assert.equal(statusOf(output, "hybrid-p95"), "pass", String(ms));
    assert.equal(p95(output).limitMs, 94.2);
    assert.equal(p95(output).graphArm.status, "pass");
    assert.equal(p95(output).hybridArm.status, "pass");
  }
  // 上限ちょうどは pass（以下）。94.2 を超えると fail（240 ms の上限でも通さない）。
  assert.equal(
    statusOf(withLatency({ hybrid: 94.2, graph: 94.2 }), "hybrid-p95"),
    "pass",
  );
  for (const ms of [94.21, 120, 239.9]) {
    const output = withLatency({ hybrid: ms, graph: ms });
    assert.equal(statusOf(output, "hybrid-p95"), "fail", String(ms));
    assert.equal(p95(output).hybridArm.status, "fail");
    assert.equal(p95(output).graphArm.status, "fail");
  }
  // 両 arm が上限以下のときだけ pass（片方の arm だけでは判定しない）。
  const hybridOnly = withLatency({ hybrid: 94.21, graph: 40 });
  assert.equal(p95(hybridOnly).hybridArm.status, "fail");
  assert.equal(p95(hybridOnly).graphArm.status, "pass");
  assert.equal(statusOf(hybridOnly, "hybrid-p95"), "fail");
  const graphOnly = withLatency({ hybrid: 40, graph: 94.21 });
  assert.equal(p95(graphOnly).hybridArm.status, "pass");
  assert.equal(p95(graphOnly).graphArm.status, "fail");
  assert.equal(statusOf(graphOnly, "hybrid-p95"), "fail");
  // 失敗した call は、遅さが上限以下でも、どちらの arm でも p95 を出さず fail。
  for (const arm of ["hybridArm", "graphArm"]) {
    const mapped = (row, repeat) =>
      repeat === 3 ? { ...row, status: "failed" } : row;
    const output = run((key) =>
      key === "G-05/base"
        ? {
            latency: () => ({ hybrid: 40, graph: 40 }),
            [arm === "hybridArm" ? "mapHybridSample" : "mapGraphSample"]:
              mapped,
          }
        : {},
    );
    assert.equal(p95(output)[arm].failedCount, 1, arm);
    assert.equal(p95(output)[arm].p95Ms, null, arm);
    assert.equal(p95(output)[arm].status, "fail", arm);
    assert.equal(statusOf(output, "hybrid-p95"), "fail", arm);
  }
});

test("condition 3 (p95): tReturn - tFetch, nearest-rank, both arms, limit from the manifest", () => {
  const slow = run((key) =>
    ["G-02/base", "G-03/base", "G-04/base"].includes(key)
      ? { latency: () => ({ hybrid: 30, graph: 100 }) }
      : {},
  );
  assert.equal(statusOf(slow, "hybrid-p95"), "fail");
  assert.equal(slow.conditions["hybrid-p95"].graphArm.p95Ms, 100);
  assert.equal(slow.conditions["hybrid-p95"].hybridArm.status, "pass");
  assert.equal(slow.conditions["hybrid-p95"].limitMs, 94.2);
  // A failed call is kept, never dropped.
  const failed = run((key) =>
    key === "G-05/base"
      ? {
          mapGraphSample: (row, repeat) =>
            repeat === 3 ? { ...row, status: "failed" } : row,
        }
      : {},
  );
  assert.equal(statusOf(failed, "hybrid-p95"), "fail");
  assert.equal(failed.conditions["hybrid-p95"].graphArm.failedCount, 1);
  // K6/5 変える点 4: B と上限は手順のファイル v2 の値（D から逆算しない）。
  const policy = deriveLatencyPolicy(
    readJson(RETRIEVAL_MANIFEST),
    readJson(PROCEDURE_FILE),
  );
  assert.deepEqual(
    [policy.percentile, policy.b, policy.d, policy.limit],
    [0.95, 54.2, GRAPH_EVAL_D_MS, 94.2],
  );
});

test("condition 4 (Evidence): the edge binding fails on an unresolved or unexpected edge, and the rest stays not-evaluable", () => {
  const unresolved = run((key) =>
    key === "G-06/base"
      ? {
          material: (repeat, material) =>
            repeat === 7 ? { ...material, unresolvedEdges: 1 } : material,
        }
      : {},
  );
  const edge =
    unresolved.conditions["evidence-validity"].components["edge-binding"];
  assert.equal(edge.status, "fail");
  assert.equal(statusOf(unresolved, "evidence-validity"), "fail");
  const extra = run((key) =>
    key === "G-07/base"
      ? {
          material: (repeat, material) => ({
            ...material,
            observed: [
              ...material.observed,
              {
                kind: "path-attachment",
                sceneId: "g07-other",
                pairs: ["r|x"],
                unresolved: 0,
              },
            ],
          }),
        }
      : {},
  );
  assert.equal(keyOf(extra, "G-07/base").edgeBinding.status, "fail");
  const wrongEdge = run((key) =>
    key === "G-02/base"
      ? {
          material: (repeat, material) => ({
            ...material,
            observed: material.observed.map((entry) => ({
              ...entry,
              pairs: ["r|other-edge"],
            })),
          }),
        }
      : {},
  );
  assert.equal(keyOf(wrongEdge, "G-02/base").edgeBinding.status, "fail");
});

test("condition 5 (forbidden contribution): (a) a forbidden Scene the Graph adds, (b) a late Graph in a display", () => {
  const forbiddenAdded = run((key, { expectation, variant }) =>
    key === "G-02/base"
      ? {
          graphLists: () => [
            ...fixtureLists(variant).graph,
            expectation.forbiddenSceneIds[0],
          ],
        }
      : {},
  );
  const a = forbiddenAdded.conditions["forbidden-contribution"].components;
  assert.equal(a["a-forbidden-scene-or-blocked-candidate"].status, "fail");
  assert.equal(
    a["a-forbidden-scene-or-blocked-candidate"].violatingSamples,
    30,
  );
  assert.equal(statusOf(forbiddenAdded, "forbidden-contribution"), "fail");
  // A forbidden Scene already in R+IR is the baseline's, not the Graph's.
  const baseline = run((key, { expectation, variant }) =>
    key === "G-02/base"
      ? {
          hybrid: [
            ...fixtureLists(variant).hybrid,
            expectation.forbiddenSceneIds[0],
          ],
          graphLists: () => [
            ...fixtureLists(variant).graph,
            expectation.forbiddenSceneIds[0],
          ],
        }
      : {},
  );
  const base = baseline.conditions["forbidden-contribution"].components;
  assert.equal(base["a-forbidden-scene-or-blocked-candidate"].status, "pass");
  assert.equal(
    base["a-forbidden-scene-or-blocked-candidate"].baselineForbiddenSamples,
    30,
  );
  // (b): a late Graph in the child's display, and a second publish.
  const late = run((key) =>
    key === "G-03/base" ? { child: { lateGraphInDisplay: true } } : {},
  );
  assert.equal(
    late.conditions["forbidden-contribution"].components[
      "b-late-graph-in-display"
    ].status,
    "fail",
  );
  const twice = run((key) =>
    key === "G-04/base" ? { parent: { publishCount: 2 } } : {},
  );
  assert.equal(
    twice.conditions["forbidden-contribution"].components[
      "b-late-graph-in-display"
    ].status,
    "fail",
  );
  // A Graph shown for a variant expected unavailable is a forbidden contribution.
  const shown = run((key) =>
    key === "G-08/graph-index-unusable"
      ? {
          mapGraphSample: (row) => ({
            ...row,
            followUp: {
              ...row.followUp,
              child: {
                ...k64Sample().followUp.child,
                outcome: "graph-ready",
                edgeCount: 1,
                publishCount: 1,
                finalSceneIds: row.finalSceneIds,
              },
            },
          }),
        }
      : {},
  );
  const shownParts = shown.conditions["forbidden-contribution"].components;
  assert.equal(
    shownParts["a-forbidden-scene-or-blocked-candidate"].status,
    "fail",
  );
});

test("an expected-unavailable variant fails when the display list differs from the paired R+IR (prereg 3)", () => {
  const unavailableKey = "G-08/graph-index-unusable";
  // An extra, otherwise harmless Scene in the parent's display.
  const extra = run((key) =>
    key === unavailableKey
      ? {
          mapGraphSample: (row) => ({
            ...row,
            finalSceneIds: [...row.finalSceneIds, "u-scene-query"],
          }),
        }
      : {},
  );
  const extraParts = extra.conditions["forbidden-contribution"].components;
  assert.equal(
    extraParts["a-forbidden-scene-or-blocked-candidate"].status,
    "fail",
  );
  assert.ok(
    extraParts["a-forbidden-scene-or-blocked-candidate"].violatingSamples > 0,
  );
  // The same members in another order are a different list too.
  const reordered = run((key) =>
    key === unavailableKey
      ? {
          mapGraphSample: (row) => ({
            ...row,
            finalSceneIds: [...row.finalSceneIds].reverse(),
          }),
        }
      : {},
  );
  const base = run();
  const pairLength = keyOf(base, unavailableKey).lists.rPlusIr.length;
  if (pairLength > 1)
    assert.equal(
      reordered.conditions["forbidden-contribution"].components[
        "a-forbidden-scene-or-blocked-candidate"
      ].status,
      "fail",
    );
  assert.equal(
    base.conditions["forbidden-contribution"].components[
      "a-forbidden-scene-or-blocked-candidate"
    ].status,
    "pass",
  );
});

test("a variant marked blocked in the ledger leaves macro and p95; a missing receipt without a record stops", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const receipts = buildReceipts(expectations).filter(
    (receipt) => receipt.settings.variantKey !== "G-02/base",
  );
  const dir = writeDir(receipts);
  const ledger = path.join(dir, "ledger.json");
  writeFileSync(
    ledger,
    JSON.stringify({
      status: "completed",
      s4Commit: S4,
      candidate: { commit: CANDIDATE },
      variants: { "G-02/base": "blocked:cb4-inputs" },
    }),
  );
  try {
    const output = buildQualityVerdict({
      goldDir: dir,
      allowListPath: path.join(dir, "allow.json"),
      ledgerPath: ledger,
    });
    assert.equal(keyOf(output, "G-02/base").blocked, "blocked:cb4-inputs");
    assert.equal(
      output.conditions["macro-non-regression"].components["g-case"].variants,
      12,
    );
    assert.equal(output.conditions["hybrid-p95"].hybridArm.n, 360);
    assert.equal(output.blockedDetermination, "ledger");
    assert.throws(
      () =>
        buildQualityVerdict({
          goldDir: dir,
          allowListPath: path.join(dir, "allow.json"),
        }),
      /\[precheck\] G-02\/base: neither a receipt nor a blocked record/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops with [precheck]: allow list, procedure, unmapped ID, missing expectation, tampered receipt", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const receipts = buildReceipts(expectations);
  const dir = writeDir(receipts);
  try {
    // The allowed pair differs.
    const other = path.join(dir, "other-allow.json");
    writeFileSync(other, JSON.stringify({ s4Commit: S4, candidate: H40("d") }));
    assert.throws(
      () => buildQualityVerdict({ goldDir: dir, allowListPath: other }),
      /\[precheck\].*not the allowed pair/,
    );
    // A receipt that names another procedure.
    const procedureReceipts = buildReceipts(expectations, (key) =>
      key === "G-03/base"
        ? {
            receipt: {
              settings: {
                variantKey: key,
                setupReceipt: { logicalToRuntime: { scenes: {} } },
                k64: { procedureFile: { sha256: "0".repeat(64) } },
              },
            },
          }
        : {},
    );
    const procedureDir = writeDir(procedureReceipts);
    try {
      assert.throws(
        () =>
          buildQualityVerdict({
            goldDir: procedureDir,
            allowListPath: path.join(procedureDir, "allow.json"),
          }),
        /\[precheck\].*procedure differs/,
      );
    } finally {
      rmSync(procedureDir, { recursive: true, force: true });
    }
    // A Scene UUID without a logical ID.
    assert.throws(
      () =>
        run((key) =>
          key === "G-02/base"
            ? {
                receipt: {
                  settings: {
                    variantKey: key,
                    setupReceipt: {
                      logicalToRuntime: {
                        scenes: { "g02-probe": "u-g02-probe" },
                      },
                    },
                    k64: { procedureFile: { sha256: PROCEDURE_SHA } },
                  },
                },
              }
            : {},
        ),
      /\[precheck\].*has no logical ID/,
    );
    // An expectation is missing.
    const inputs = loadQualityInputs({
      goldDir: dir,
      allowListPath: path.join(dir, "allow.json"),
    });
    const { bindings: _bindings, ...rest } = inputs;
    const { "G-05/base": dropped, ...fewer } = rest.expectations;
    assert.ok(dropped);
    assert.throws(
      () => evaluateQualityVerdict({ ...rest, expectations: fewer }),
      /\[precheck\] G-05\/base: no expectation/,
    );
    assert.throws(
      () => evaluateQualityVerdict({ ...rest, tolerance: undefined }),
      /\[precheck\] the metric tolerance/,
    );
    // One changed byte in a receipt, with files.sha256 untouched.
    const tampered = writeDir(receipts, {
      tamper: (name, text) =>
        name.startsWith("G-01")
          ? text.replace("g-case-gold", "g-case-gole")
          : text,
    });
    try {
      assert.throws(
        () => readReceiptDir(tampered),
        /\[precheck\].*differs from files\.sha256/,
      );
    } finally {
      rmSync(tampered, { recursive: true, force: true });
    }
    // The manifest without the single predeclared improvement.
    assert.throws(
      () =>
        loadExpectations({
          root: DEFAULT_ROOT,
          graphManifest: {
            cases: [{ caseId: "G-01", predeclaredImprovement: false }],
          },
        }),
      /\[precheck\].*predeclare/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bindings: a changed receipt, allow list, procedure or script is found by verify", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const dir = writeDir(buildReceipts(expectations));
  try {
    const output = buildQualityVerdict({
      goldDir: dir,
      allowListPath: path.join(dir, "allow.json"),
    });
    // The allow list is bound by file name, not by an absolute path.
    assert.equal(output.bindings.allowList.path, "allow.json");
    assert.deepEqual(verifyBindings(output, { allowListDir: dir }), []);
    for (const key of ["script", "manifests", "fixtures"])
      assert.ok(output.bindings[key].length > 0, key);
    assert.equal(output.bindings.procedure.sha256, PROCEDURE_SHA);
    assert.equal(output.bindings.receipts.length, 13);
    assert.equal(output.bindings.k62.text.endsWith("1e-12"), true);
    // Change one byte of a bound receipt and of the allow list.
    const receiptFile = output.bindings.receipts[0].path;
    writeFileSync(receiptFile, `${readFileSync(receiptFile, "utf8")} `);
    const allowFile = path.join(dir, output.bindings.allowList.path);
    writeFileSync(allowFile, `${readFileSync(allowFile, "utf8")} `);
    assert.deepEqual(
      verifyBindings(output, { allowListDir: dir }).sort(),
      [receiptFile, output.bindings.allowList.path].sort(),
    );
    // A tampered recorded digest of the procedure or a script is found too.
    const forged = clone(output);
    forged.bindings.procedure.sha256 = "0".repeat(64);
    forged.bindings.script[0].sha256 = "1".repeat(64);
    const forgedMismatches = verifyBindings(forged, { allowListDir: dir });
    assert.ok(forgedMismatches.includes(PROCEDURE_FILE));
    assert.ok(forgedMismatches.includes(forged.bindings.script[0].path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K6/5 変える点 7: 手順のファイルは正式の loader で S4 の commit から読み、receipt の head.k65 は K65_FREEZE と一致しなければ [precheck]", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const verdictOf = (receipts, options = {}) => {
    const dir = writeDir(receipts);
    try {
      return buildQualityVerdict({
        goldDir: dir,
        allowListPath: path.join(dir, "allow.json"),
        ...options,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const withK65 = (k65) =>
    buildReceipts(expectations, (key) =>
      key === "G-03/base"
        ? {
            receipt: {
              head: { observationPrep: { commit: S4 }, ...k65 },
            },
          }
        : {},
    );
  assert.equal(verdictOf(buildReceipts(expectations)).schema.length > 0, true);
  for (const [name, head] of [
    ["head.k65 が無い", {}],
    ["別の凍結の commit", { k65: { ...K65_HEAD, freezeCommit: H40("1") } }],
    ["別の bytes", { k65: { ...K65_HEAD, sha256: "0".repeat(64) } }],
    [
      "K6/4 の凍結",
      {
        k65: {
          freezeCommit: "5dea38af158283c2a925d68ef0d8b0771c0ea209",
          sha256: K65_HEAD.sha256,
        },
      },
    ],
  ])
    assert.throws(
      () => verdictOf(withK65(head)),
      /\[precheck\].*head\.k65 is not the K6\/5 freeze/u,
      name,
    );
  // K6/6-N9: head.k66 が無い、別の commit、別の bytes、K6/5 の凍結は /6 の行で判定しない。
  const withK66 = (k66) =>
    buildReceipts(expectations, (key) =>
      key === "G-03/base"
        ? {
            receipt: {
              head: {
                observationPrep: { commit: S4 },
                k65: K65_HEAD,
                ...k66,
              },
            },
          }
        : {},
    );
  for (const [name, head] of [
    ["head.k66 が無い（/6 の凍結の前に始めた run。s6r1 を含む）", {}],
    ["別の凍結の commit", { k66: { ...K66_HEAD, freezeCommit: H40("1") } }],
    ["別の bytes", { k66: { ...K66_HEAD, sha256: "0".repeat(64) } }],
    ["K6/5 の凍結", { k66: K65_HEAD }],
  ])
    assert.throws(
      () => verdictOf(withK66(head)),
      /\[precheck\].*head\.k66 is not the K6\/6 freeze/u,
      name,
    );
  // K6/7-N9′: head.k67 が無い（s6r1・s7r1・s7r2 など /7 の凍結の前に始めた run）、別の commit、別の bytes、K6/6 の凍結は /7 の行で判定しない。
  const withK67 = (k67) =>
    buildReceipts(expectations, (key) =>
      key === "G-03/base"
        ? {
            receipt: {
              head: {
                observationPrep: { commit: S4 },
                k65: K65_HEAD,
                k66: K66_HEAD,
                ...k67,
              },
            },
          }
        : {},
    );
  for (const [name, head] of [
    [
      "head.k67 が無い（/7 の凍結の前に始めた run。s6r1・s7r1・s7r2 を含む）",
      {},
    ],
    ["別の凍結の commit", { k67: { ...K67_HEAD, freezeCommit: H40("1") } }],
    ["別の bytes", { k67: { ...K67_HEAD, sha256: "0".repeat(64) } }],
    ["K6/6 の凍結", { k67: K66_HEAD }],
  ])
    assert.throws(
      () => verdictOf(withK67(head)),
      /\[precheck\].*head\.k67 is not the K6\/7 freeze/u,
      name,
    );
  // 既定の K67_FREEZE は固定した /7 の凍結で、試験の合成の head.k67 の receipt は判定しない。
  assert.throws(
    () => verdictOf(buildReceipts(expectations), { freeze67: K67_FREEZE }),
    new RegExp(
      `\\[precheck\\].*head\\.k67 is not the K6/7 freeze \\(${K67_FREEZE.freezeCommit}\\)`,
      "u",
    ),
  );
  // descriptor の freezeCommit が null なら、どの receipt も判定しない（fail closed）。
  assert.throws(
    () =>
      verdictOf(buildReceipts(expectations), {
        freeze67: { ...K67_FREEZE, freezeCommit: null },
      }),
    /\[precheck\].*head\.k67 is not the K6\/7 freeze \(null\)/u,
  );
  // 既定の K66_FREEZE は固定した /6 の凍結で、試験の合成の head.k66 の receipt は判定しない。
  assert.throws(
    () => verdictOf(buildReceipts(expectations), { freeze66: K66_FREEZE }),
    new RegExp(
      `\\[precheck\\].*head\\.k66 is not the K6/6 freeze \\(${K66_FREEZE.freezeCommit}\\)`,
      "u",
    ),
  );
  // descriptor の freezeCommit が null なら、どの receipt も判定しない（fail closed）。
  assert.throws(
    () =>
      verdictOf(buildReceipts(expectations), {
        freeze66: { ...K66_FREEZE, freezeCommit: null },
      }),
    /\[precheck\].*head\.k66 is not the K6\/6 freeze \(null\)/u,
  );
  // 実リポジトリは S4 の commit（試験の repo の commit）を持たず、v2 の review も placeholder なので読めない。
  assert.throws(
    () =>
      verdictOf(buildReceipts(expectations), {
        procedureRoot: DEFAULT_ROOT,
      }),
    /\[precheck\]/u,
  );
  // S4 の commit に手順のファイルが無い（commit が違う）。
  const dir = writeDir(buildReceipts(expectations));
  try {
    writeFileSync(
      path.join(dir, "allow.json"),
      JSON.stringify({ s4Commit: H40("e"), candidate: CANDIDATE }),
    );
    assert.throws(
      () =>
        buildQualityVerdict({
          goldDir: dir,
          allowListPath: path.join(dir, "allow.json"),
        }),
      /\[precheck\] the procedure file .* cannot be read from/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // 契約と違う D・B・p95 の上限を書いた file は、素の JSON では読めてしまうが loader が拒む。
  for (const [key, value] of [
    ["dMs", 10.84],
    ["bMs", 200],
    ["hybridP95LimitMs", 65.04],
    ["hybridP95LimitMs", 240],
  ]) {
    const repo = mkdtempSync(path.join(tmpdir(), "qv-procedure-bad-"));
    try {
      git(repo, "init", "-q", "-b", "main");
      mkdirSync(path.join(repo, path.dirname(PROCEDURE_FILE)), {
        recursive: true,
      });
      const bad = clone(REVIEWED_V2);
      bad.values[key] = value;
      writeFileSync(
        path.join(repo, PROCEDURE_FILE),
        `${JSON.stringify(bad, null, 2)}\n`,
      );
      git(repo, "add", PROCEDURE_FILE);
      git(
        repo,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "-q",
        "-m",
        "bad v2",
      );
      const badCommit = git(repo, "rev-parse", "HEAD");
      const receipts = buildReceipts(expectations);
      const allow = writeDir(receipts);
      try {
        writeFileSync(
          path.join(allow, "allow.json"),
          JSON.stringify({ s4Commit: badCommit, candidate: CANDIDATE }),
        );
        assert.throws(
          () =>
            buildQualityVerdict({
              goldDir: allow,
              allowListPath: path.join(allow, "allow.json"),
              procedureRoot: repo,
            }),
          new RegExp(
            `\\[precheck\\].*values\\.${key} must be the contract`,
            "u",
          ),
          `${key}=${value}`,
        );
      } finally {
        rmSync(allow, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("no threshold is written in the verdict code; the manifest and the K6/2 text decide", () => {
  for (const file of [
    "quality-verdict.mjs",
    "quality-evidence-items.mjs",
    "quality-verdict-cli.mjs",
  ]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
      .join("\n");
    for (const literal of [
      /65\.04/u,
      /94\.2/u,
      /\b200\b/u,
      /10\.84/u,
      /54\.2/u,
      /1e-12/u,
      /0\.95/u,
      /\b100\b(?!％)/u,
      /0\.20/u,
    ])
      assert.doesNotMatch(code, literal, `${file}: ${literal}`);
  }
  // The percentile moves with the manifest; B, D and the limit are the
  // procedure file's and must equal the contract's (K6/5-N4: B is never
  // computed from D, so D = 40 ms never yields B = 200 ms or limit 240 ms).
  const manifest = readJson(RETRIEVAL_MANIFEST);
  const procedure = readJson(PROCEDURE_FILE);
  const changed = clone(manifest);
  changed.performance.warm.B = "Raw-only p90(t_return-t_fetch) ...";
  assert.equal(deriveLatencyPolicy(changed, procedure).percentile, 0.9);
  const noLimit = clone(manifest);
  noLimit.performance.warm.hybridP95Limit = "B";
  assert.throws(() => deriveLatencyPolicy(noLimit, procedure), /\[precheck\]/);
  for (const [key, value] of [
    ["bMs", 200],
    ["hybridP95LimitMs", 240],
    ["hybridP95LimitMs", 65.04],
    ["dMs", 10.84],
    ["bMs", undefined],
  ])
    assert.throws(
      () =>
        deriveLatencyPolicy(manifest, {
          ...procedure,
          values: { ...procedure.values, [key]: value },
        }),
      new RegExp(`\\[precheck\\].*values\\.${key}`, "u"),
      `${key}=${value}`,
    );
  assert.throws(
    () => deriveLatencyPolicy(manifest, null),
    /\[precheck\].*values\.dMs/u,
  );
  assert.equal(readMetricTolerance(DEFAULT_ROOT).tolerance, 1e-12);
  // The same receipts under a larger limit pass what a smaller one fails.
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const dir = writeDir(
    buildReceipts(expectations, () => ({
      latency: () => ({ hybrid: 100, graph: 100 }),
    })),
  );
  try {
    const inputs = loadQualityInputs({
      goldDir: dir,
      allowListPath: path.join(dir, "allow.json"),
    });
    const { bindings: _bindings, ...rest } = inputs;
    assert.equal(
      evaluateQualityVerdict(rest).conditions["hybrid-p95"].status,
      "fail",
    );
    const relaxed = { ...rest, policy: { ...rest.policy, limit: 119.24 } };
    assert.equal(
      evaluateQualityVerdict(relaxed).conditions["hybrid-p95"].status,
      "pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 品質判定の事前登録 v2（草稿。K6/6 に連動）: D3・D6・D8 --------------------

/**
 * A first-render row (K6/6) in place of the follow-up row of a variant: the
 * parent joined the Graph in the D window and shows the Graph's list, with the
 * parent's own contribution record (FR-7). `startSlot.preparesReady` counts
 * 10 + repeat, as R1 records it, so (c) holds for every row.
 */
function firstRenderRows(variant, expectation, mutate = () => ({})) {
  const runtime = (list) => list.map((id) => `u-${id}`);
  const contributions = expectation.expectedContributions;
  const material = {
    matched: contributions.map((row) => `${row.kind}:${row.sceneId}`),
    unresolvedEdges: 0,
    observed: contributions.map((row) => ({
      kind: row.kind,
      sceneId: row.sceneId,
      pairs: row.edgeIds.map((edge) => `rev-of-${edge}|${edge}`),
      unresolved: 0,
    })),
  };
  const graphList = runtime(fixtureLists(variant).graph);
  return {
    mapGraphSample: (_merged, repeat) => {
      const { overrides = {}, followUp = {} } =
        mutate(repeat, { runtime }) ?? {};
      return {
        ...k66Sample(
          {
            variantKey: variant.key,
            phase: "measured",
            repeat,
            finalSceneIds: graphList,
            startSlot: {
              kind: "empty",
              readyFresh: false,
              preparesReady: 10 + repeat,
            },
            graph: { edgeCount: Math.max(1, contributions.length) },
            ...overrides,
          },
          {
            parent: {
              rSceneIds: runtime(fixtureLists(variant).hybrid),
              irSceneIds: [],
              contribution: {
                expectedContribution: true,
                contributionBasis: "material-revision",
                materialRevision: material,
              },
              ...followUp.parent,
            },
            ...followUp,
          },
        ),
        status: "completed",
      };
    },
  };
}

const G02 = (output) => keyOf(output, "G-02/base");

test("品質 v2 D6: first-render で表示された sample の edge の束縛は親の寄与の記録（FR-7）で検査する", () => {
  const output = run((key, ctx) =>
    key === "G-02/base" ? firstRenderRows(ctx.variant, ctx.expectation) : {},
  );
  assert.deepEqual(G02(output).displayed, {
    firstRender: 30,
    followUp: 0,
    notDisplayed: 0,
  });
  assert.equal(G02(output).edgeBinding.status, "pass");
  assert.equal(G02(output).edgeBinding.checked, 30);
  assert.deepEqual(G02(output).notDisplayedFailures, []);
  assert.equal(statusOf(output, "macro-non-regression"), "not-evaluable");
  assert.equal(
    output.conditions["macro-non-regression"].components["g-case"].status,
    "pass",
  );
});

test("品質 v2 D8（K6/6-N13a・N13b）: 窓内に合流して Graph が表示に寄与したのに first-render の条件を欠いた親は、Scene の一覧が R+IR と違っても同じでも fail（hold に留めない）", () => {
  for (const [name, overrides] of [
    // 同じ（path の添付だけ。G-06 の形）: R+IR の一覧のまま。
    ["R+IR と同じ", (runtime, hybrid) => ({ finalSceneIds: runtime(hybrid) })],
    // 違う: 一覧に Scene が足される。
    ["R+IR と違う", () => ({})],
  ]) {
    const output = run((key, ctx) =>
      key === "G-02/base"
        ? firstRenderRows(
            ctx.variant,
            ctx.expectation,
            (repeat, { runtime }) =>
              repeat === 4
                ? {
                    overrides: overrides(
                      runtime,
                      fixtureLists(ctx.variant).hybrid,
                    ),
                    followUp: { parent: { contribution: null } },
                  }
                : {},
          )
        : {},
    );
    const row = G02(output);
    assert.equal(row.conditions["macro-non-regression"].status, "fail", name);
    assert.deepEqual(
      row.notDisplayedFailures.map((entry) => [entry.repeat, entry.reason]),
      [[4, "graph-contributed-parent-not-counted-as-first-render"]],
      name,
    );
    assert.deepEqual(row.notDisplayedFailures[0].firstRenderFails, [
      "FR7:no-contribution-record",
    ]);
    assert.equal(
      row.conditions["evidence-validity"].components[
        "graph-contributed-parent-counted"
      ].status,
      "fail",
    );
    assert.equal(statusOf(output, "macro-non-regression"), "fail", name);
    assert.equal(
      statusOf(output, "evidence-validity"),
      "fail",
      "condition 4 for a variant with an expectation",
    );
    assert.ok(output.verdict.failed.includes("macro-non-regression"));
  }
});

test("品質 v2 D8: 表示されなかった sample の Scene の一覧が R+IR と違うのは hold でなく fail（v1 の実装は K6/4:171 より弱かった）", () => {
  const output = run((key, ctx) =>
    key === "G-02/base"
      ? {
          mapGraphSample: (merged, repeat) =>
            repeat === 2
              ? {
                  ...k64Sample(
                    {
                      variantKey: key,
                      repeat,
                      // R+IR の一覧から 1 件落とした一覧（R+IR と違う）。
                      finalSceneIds: fixtureLists(ctx.variant)
                        .hybrid.slice(1)
                        .map((id) => `u-${id}`),
                    },
                    { child: null, notices: [] },
                  ),
                  tFetch: 100,
                  tReturn: 130,
                  status: "completed",
                }
              : merged,
        }
      : {},
  );
  assert.deepEqual(
    G02(output).notDisplayedFailures.map((entry) => entry.reason),
    ["not-displayed-sample-differs-from-r-plus-ir"],
  );
  assert.equal(G02(output).conditions["macro-non-regression"].status, "fail");
});

test("品質 v2 D8: Graph が合流したが edgeCount 0 の親は『寄与した』に当たらず fail にしない", () => {
  const output = run((key, ctx) =>
    key === "G-02/base"
      ? firstRenderRows(ctx.variant, ctx.expectation, (repeat, { runtime }) =>
          repeat === 4
            ? {
                overrides: {
                  graph: { edgeCount: 0 },
                  finalSceneIds: runtime(fixtureLists(ctx.variant).hybrid),
                },
                followUp: { parent: { contribution: null } },
              }
            : {},
        )
      : {},
  );
  assert.deepEqual(G02(output).notDisplayedFailures, []);
});

test("品質 v2 D2・D3: G-08/chronicle-index-unusable の index-ready の子は、6 条件を満たせば子から外して D3 で検査し、1 つでも欠けば子のまま（fail closed）", () => {
  const KEY = "G-08/chronicle-index-unusable";
  const edit =
    (
      childOverrides,
      sampleOverrides = {},
      forbidden = false,
      typedRevisions = undefined,
    ) =>
    (key, ctx) => {
      if (key !== KEY) return {};
      const runtime = (list) => list.map((id) => `u-${id}`);
      const pair = runtime(fixtureLists(ctx.variant).hybrid);
      const forbiddenScene = ctx.expectation.forbiddenSceneIds[0];
      return {
        typedRevisions,
        mapGraphSample: (merged, repeat) => ({
          ...k64Sample(
            {
              variantKey: key,
              repeat,
              finalSceneIds: pair,
              snapshot: {
                usable: true,
                reason: null,
                chronicleIndexUsable: false,
              },
              irOutcome: "index-unavailable",
              graph: { outcome: "graph-unavailable", reason: "index-state" },
              ...sampleOverrides,
            },
            {
              child: {
                ...followUpRecord().child,
                origin: "index-ready",
                refreshTrigger: null,
                chronicleIndexUsable: true,
                outcome: "graph-ready",
                edgeCount: 1,
                rSceneIds: pair,
                irSceneIds: [],
                finalSceneIds: pair,
                materialRevision: {
                  unresolvedEdges: 0,
                  observed: [
                    {
                      kind: "path-attachment",
                      sceneId: forbidden ? forbiddenScene : "g08-attach",
                      pairs: [OBSERVED_PAIR],
                      unresolved: 0,
                    },
                  ],
                },
                ...childOverrides,
              },
            },
          ),
          tFetch: 100,
          tReturn: 130,
          status: "completed",
        }),
      };
    };
  const a2 = (output) =>
    output.conditions["forbidden-contribution"].components[
      "a2-index-ready-requery-forbidden"
    ];
  // 6 条件を満たし、禁止の寄与が無く、観測した Revision が setup の記録の最新: 子としての違反にはならず、D3 の対象で pass。
  const ok = run(edit({}));
  assert.equal(a2(ok).eligibleChildren, 30);
  assert.equal(a2(ok).status, "pass");
  assert.deepEqual(a2(ok).problems, []);
  assert.equal(
    keyOf(ok, KEY).forbidden.a.violations.length,
    0,
    "an eligible index-ready child is not 'a child that showed a Graph'",
  );
  // 子の開始時に Chronicle の Index が使えなかった（(6) を欠く）: 子のまま。Graph を出した子は fail。
  const kept = run(edit({ chronicleIndexUsable: false }));
  assert.equal(a2(kept).eligibleChildren, 0);
  assert.equal(a2(kept).keptAsChildren, 30);
  assert.equal(
    keyOf(kept, KEY).forbidden.a.violations[0].reason,
    "graph-shown-for-a-variant-expected-unavailable",
  );
  // origin が graph-ready の子（K6/4:52 の「子」）は D3 の対象にしない。
  const graphReady = run(edit({ origin: "graph-ready" }));
  assert.equal(a2(graphReady).eligibleChildren, 0);
  assert.equal(statusOf(graphReady, "forbidden-contribution"), "fail");
  // 禁止された Scene への path の寄与（R+IR の一覧に同じ Scene があっても数える）は fail。
  const forbidden = run(edit({}, {}, true));
  assert.equal(a2(forbidden).status, "fail");
  assert.ok(
    a2(forbidden).problems.some((entry) => entry.code === "b-forbidden-path"),
  );
  // 遅れた Graph の表示、2 回の公開は fail。
  assert.equal(a2(run(edit({ lateGraphInDisplay: true }))).status, "fail");
  assert.equal(a2(run(edit({ publishCount: 2 }))).status, "fail");
  // 他の variant の index-ready の子は D3 の対象にしない（G-08/chronicle-index-unusable だけ）。
  // D3 (d) の後半: 観測した Revision は、setup の記録のその edge の最新の typed Revision でなければ fail。
  // 最新は凍結の fixture の `revisions` の配列の順（cass、juno）で、setup の記録の JSON の key の順ではない。
  const prepared = (id, relationIds, extra = {}) => [
    id,
    {
      id,
      relationIds,
      decision: "approved",
      revisionId: `runtime-${id}`,
      ...extra,
    },
  ];
  // The setup record carries every fixture Revision (cass, juno): the rows
  // given replace the default rows of the same id.
  const full = (...rows) =>
    Object.fromEntries([
      prepared("g08-r-cass", ["g08-rents-to-cass-unbound"]),
      prepared("g08-r-juno", ["g08-rents-to-juno"]),
      ...rows,
    ]);
  const latestIsJuno = (output) =>
    a2(output).problems.every(
      (entry) =>
        entry.code === "d-revision-is-not-the-latest" &&
        entry.observed === "g08-r-cass" &&
        entry.latest === "g08-r-juno" &&
        entry.edge === REL,
    );
  for (const rows of [
    // cass が先の key の順（準備順）と、juno が先の key の順（key の順に頼らない）。
    [
      prepared("g08-r-cass", [REL]),
      prepared("g08-r-juno", [REL], { decision: "none" }),
    ],
    [
      prepared("g08-r-juno", [REL], { decision: "none" }),
      prepared("g08-r-cass", [REL]),
    ],
  ]) {
    const superseded = run(edit({}, {}, false, Object.fromEntries(rows)));
    assert.equal(a2(superseded).status, "fail");
    assert.ok(a2(superseded).problems.length > 0 && latestIsJuno(superseded));
  }
  // decision の段で拒まれた行も Revision は作られているので数え、前の Revision を置き換える（fail）。
  const decisionRefused = run(
    edit(
      {},
      {},
      false,
      Object.fromEntries([
        prepared("g08-r-cass", [REL]),
        prepared("g08-r-juno", [REL], { refusedAtSetup: "decision" }),
      ]),
    ),
  );
  assert.equal(a2(decisionRefused).status, "fail");
  assert.ok(latestIsJuno(decisionRefused));
  // prepare の段で拒まれた Revision は、setup driver が typedRevisions に書かず setupReceipt.refusedAtSetup に書く。
  // その記録があれば fixture の行が setup の記録に無くても飛ばす（pass）。無ければ最新かもしれないので hold。
  const missingJuno = Object.fromEntries([prepared("g08-r-cass", [REL])]);
  const refusedLater = run(
    indexReadyEdit(CHRONICLE, {
      typedRevisions: missingJuno,
      refusedAtSetup: [
        { revisionId: "g08-r-juno", stage: "prepare", error: "x" },
      ],
    }),
  );
  assert.equal(a2Of(refusedLater).status, "pass");
  for (const refused of [
    undefined,
    [{ revisionId: "g08-r-juno", stage: "decision", error: "x" }],
    [{ revisionId: "g08-r-cass", stage: "prepare", error: "x" }],
  ]) {
    const unaccounted = run(
      indexReadyEdit(CHRONICLE, {
        typedRevisions: missingJuno,
        refusedAtSetup: refused,
      }),
    );
    assert.equal(a2Of(unaccounted).status, "hold");
    assert.ok(
      a2Of(unaccounted).problems.every(
        (entry) =>
          entry.code === "d-fixture-revision-not-in-setup" &&
          entry.revisions.join() === "g08-r-juno",
      ),
    );
  }
  // 別の Relation の Revision が後にあっても関係しない（pass）。
  const otherRelation = run(
    edit(
      {},
      {},
      false,
      Object.fromEntries([
        prepared("g08-r-cass", [REL]),
        prepared("g08-r-juno", ["g08-rents-to-juno"]),
      ]),
    ),
  );
  assert.equal(a2(otherRelation).status, "pass");
  // setup の記録に fixture の配列に無い Revision がある（順を決められない）は hold。
  const unordered = run(
    edit(
      {},
      {},
      false,
      Object.fromEntries([
        prepared("g08-r-cass", [REL]),
        prepared("not-in-the-fixture", [REL]),
      ]),
    ),
  );
  assert.equal(a2(unordered).status, "hold");
  assert.ok(
    a2(unordered).problems.every(
      (entry) => entry.code === "d-revision-order-unavailable",
    ),
  );
  // setup の記録に typed Revision が無い（引けない）は hold。edge を持つ Revision が無いのも hold。
  const noRecord = run(edit({}, {}, false, null));
  assert.equal(a2(noRecord).status, "hold");
  assert.ok(
    a2(noRecord).problems.every(
      (entry) => entry.code === "d-revision-resolution-unavailable",
    ),
  );
  const noEdge = run(edit({}, {}, false, full()));
  assert.equal(a2(noEdge).status, "hold");
  assert.ok(
    a2(noEdge).problems.every(
      (entry) => entry.code === "d-edge-has-no-typed-revision-in-setup",
    ),
  );
  // unresolvedEdges が 0 でない（pairs が null）は従来どおり fail。
  const unresolved = run(
    edit({
      materialRevision: {
        unresolvedEdges: 1,
        observed: [
          {
            kind: "path-attachment",
            sceneId: "g08-attach",
            pairs: null,
            unresolved: 1,
          },
        ],
      },
    }),
  );
  assert.equal(a2(unresolved).status, "fail");
  assert.ok(
    a2(unresolved).problems.some(
      (entry) => entry.code === "d-unresolved-edges",
    ),
  );
});

test("品質 v2 D3 (d): 最新の typed Revision は凍結の fixture の配列の順の最後の行。prepare で拒まれた行だけ数えず、decision で拒まれた行は数える", () => {
  const rows = {
    d: { id: "d", relationIds: ["r3"] },
    c: { id: "c", relationIds: ["r1"], refusedAtSetup: "decision" },
    b: { id: "b", relationIds: ["r1"] },
    a: { id: "a", relationIds: ["r1", "r2"] },
  };
  const order = ["a", "b", "c", "d"];
  // JSON の key の順（d、c、b、a）ではなく、order の順で決める。
  assert.equal(latestTypedRevisionOf(rows, "r1", order), "c");
  assert.equal(latestTypedRevisionOf(rows, "r2", order), "a");
  assert.equal(latestTypedRevisionOf(rows, "r3", order), "d");
  assert.equal(latestTypedRevisionOf(rows, "nope", order), null);
  assert.equal(latestTypedRevisionOf(undefined, "r1", order), null);
  assert.equal(latestTypedRevisionOf(rows, "r1", undefined), null);
  assert.equal(
    latestTypedRevisionOf(
      { x: { id: "x", refusedAtSetup: "prepare", relationIds: ["r1"] } },
      "r1",
      ["x"],
    ),
    null,
  );
  assert.equal(
    latestTypedRevisionOf(
      { ...rows, c: { ...rows.c, refusedAtSetup: "prepare" } },
      "r1",
      order,
    ),
    "b",
  );
});

test("品質 v2 D4: 受領書の最上位の requeries（user-operation でない行）が Scene の一覧を持てば、R+IR に足した禁止 Scene・blocked 候補は条件 5 (a) の fail。一覧の無い行は関係しない", () => {
  const forbiddenOf = (expectation) => expectation.forbiddenSceneIds[0];
  const withRequery = (row) =>
    run((key, { expectation }) =>
      key === "G-02/base"
        ? {
            receipt: {
              requeries: [
                {
                  variantKey: key,
                  arm: "graph",
                  phase: "measured",
                  repeat: 0,
                  trigger: "index-ready-requery",
                  ...row(expectation),
                },
              ],
            },
          }
        : {},
    );
  const a = (output) =>
    output.conditions["forbidden-contribution"].components[
      "a-forbidden-scene-or-blocked-candidate"
    ];
  // 禁止 Scene を出す行（対の R+IR にその Scene が無い）: fail。
  const hit = withRequery((expectation) => ({
    finalSceneIds: [`u-${forbiddenOf(expectation)}`],
  }));
  assert.equal(a(hit).status, "fail");
  assert.equal(a(hit).violatingSamples, 1);
  const violation = keyOf(hit, "G-02/base").forbidden.a.violations[0];
  assert.equal(
    violation.reason,
    "requery-row-forbidden-or-blocked-contribution",
  );
  assert.deepEqual(violation.sceneIds, [forbiddenOf(expectationsOf())]);
  // 対の `repeat` が引けない行は、禁止・blocked への一致だけを見る（fail）。
  const unpaired = withRequery((expectation) => ({
    repeat: 99,
    finalSceneIds: [`u-${forbiddenOf(expectation)}`],
  }));
  assert.equal(a(unpaired).status, "fail");
  // Scene の一覧が無い行（N29・N32 の側）、R+IR arm の行、禁止に入らない一覧は pass。
  assert.equal(a(withRequery(() => ({ publishCount: 1 }))).status, "pass");
  assert.equal(
    a(
      withRequery((expectation) => ({
        arm: "hybrid",
        finalSceneIds: [`u-${forbiddenOf(expectation)}`],
      })),
    ).status,
    "pass",
  );
  assert.equal(
    a(withRequery(() => ({ finalSceneIds: ["u-scene-query"] }))).status,
    "pass",
  );
  // user-operation の行は samples の側で、requeries には置かない。
  assert.equal(
    a(
      withRequery((expectation) => ({
        trigger: "user-operation",
        finalSceneIds: [`u-${forbiddenOf(expectation)}`],
      })),
    ).status,
    "pass",
  );
});

function expectationsOf() {
  return loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  }).expectations["G-02/base"];
}

test("品質 v2 D3 (b)(d): materialRevision の記録が在れば outcome・edgeCount によらず観測した path と unresolvedEdges を検査する。Graph を出したかもしれない子に記録が無ければ hold", () => {
  const lists = (ids) => ids;
  const base = {
    pair: [],
    lists,
    forbidden: new Set(["f"]),
    blocked: new Set(),
    typedRevisions: {
      rev: { id: "rev", relationIds: ["edge"] },
    },
    typedRevisionOrder: ["rev"],
  };
  const record = {
    unresolvedEdges: 2,
    observed: [{ sceneId: "f", pairs: ["rev|edge"] }],
  };
  const codes = (child) =>
    d3Problems({ ...base, child }).map(
      (entry) => `${entry.kind}:${entry.code}`,
    );
  const failing = ["fail:b-forbidden-path", "fail:d-unresolved-edges"];
  // edgeCount が null、0、outcome が graph-ready でない子でも、記録が示せば fail。
  for (const child of [
    { outcome: "graph-ready", edgeCount: null, materialRevision: record },
    { outcome: "graph-ready", edgeCount: 0, materialRevision: record },
    { outcome: "graph-late", edgeCount: 1, materialRevision: record },
    { outcome: "graph-unavailable", materialRevision: record },
  ])
    assert.deepEqual(
      codes({ publishCount: 1, finalSceneIds: [], ...child }),
      failing,
    );
  // Graph を出したかもしれない（graph-ready で edgeCount が 0 と確定していない）子に記録が無ければ hold。
  for (const edgeCount of [null, undefined, 1])
    assert.deepEqual(
      codes({
        publishCount: 1,
        finalSceneIds: [],
        outcome: "graph-ready",
        edgeCount,
      }),
      ["hold:b-material-revision-record-missing"],
    );
  // 記録の無い子は outcome・edgeCount によらずすべて hold（v2 §3 の字義。edgeCount 0 も graph-ready でない子も pass にしない）。
  for (const child of [
    { outcome: "graph-ready", edgeCount: 0 },
    { outcome: "graph-unavailable" },
    { outcome: "graph-late", edgeCount: 1 },
  ])
    assert.deepEqual(codes({ publishCount: 1, finalSceneIds: [], ...child }), [
      "hold:b-material-revision-record-missing",
    ]);
  // Graph を出したかもしれない子の空の記録（probe が paths を出さない形。unresolvedEdges 0・observed []）は hold。
  for (const edgeCount of [null, 1])
    assert.deepEqual(
      codes({
        publishCount: 1,
        finalSceneIds: [],
        outcome: "graph-ready",
        edgeCount,
        materialRevision: { unresolvedEdges: 0, observed: [] },
      }),
      ["hold:b-observed-path-record-empty"],
    );
  // Scene が論理 ID に無い path（sceneId が null）は捨てずに hold。
  assert.deepEqual(
    codes({
      publishCount: 1,
      finalSceneIds: [],
      outcome: "graph-ready",
      edgeCount: 1,
      materialRevision: {
        unresolvedEdges: 0,
        observed: [{ sceneId: null, pairs: ["rev|edge"] }],
      },
    }),
    ["hold:b-observed-scene-has-no-logical-id"],
  );
  // 観測した path が無い edgeCount 0 の記録は、Graph を出していないので hold にしない。
  // 何も観測せず unresolvedEdges 0 の記録は、setup の typed Revision が無くても hold にならない。
  assert.deepEqual(
    d3Problems({
      ...base,
      typedRevisions: null,
      child: {
        publishCount: 0,
        finalSceneIds: [],
        outcome: "graph-unavailable",
        materialRevision: { unresolvedEdges: 0, observed: [] },
      },
    }),
    [],
  );
});

test("品質 v2 D3 の開示: Graph を出した子の数と edge の件数、期待の外の追加、D2 に残った index-ready の子と欠けた条件を出力に残す", () => {
  const KEY = "G-08/chronicle-index-unusable";
  const edit =
    (childOverrides, sampleOverrides = {}) =>
    (key, ctx) => {
      if (key !== KEY) return {};
      const runtime = (list) => list.map((id) => `u-${id}`);
      const pair = runtime(fixtureLists(ctx.variant).hybrid);
      return {
        mapGraphSample: (merged, repeat) => ({
          ...k64Sample(
            {
              variantKey: key,
              repeat,
              finalSceneIds: pair,
              snapshot: {
                usable: true,
                reason: null,
                chronicleIndexUsable: false,
              },
              irOutcome: "index-unavailable",
              graph: { outcome: "graph-unavailable", reason: "index-state" },
              ...sampleOverrides,
            },
            {
              child: {
                ...followUpRecord().child,
                origin: "index-ready",
                refreshTrigger: null,
                chronicleIndexUsable: true,
                outcome: "graph-ready",
                edgeCount: 3,
                rSceneIds: pair,
                irSceneIds: [],
                finalSceneIds: [...pair, "u-scene-query"],
                materialRevision: {
                  unresolvedEdges: 0,
                  observed: [
                    {
                      kind: "path-attachment",
                      sceneId: "g08-attach",
                      pairs: [OBSERVED_PAIR],
                      unresolved: 0,
                    },
                  ],
                },
                ...childOverrides,
              },
            },
          ),
          tFetch: 100,
          tReturn: 130,
          status: "completed",
        }),
      };
    };
  const a2 = (output) =>
    output.conditions["forbidden-contribution"].components[
      "a2-index-ready-requery-forbidden"
    ];
  const eligible = run(edit({}));
  assert.equal(a2(eligible).eligibleChildren, 30);
  assert.equal(a2(eligible).graphShownChildren, 30);
  assert.equal(a2(eligible).graphEdgeCount, 90);
  assert.equal(a2(eligible).outsideExpectationAdded, 30);
  assert.equal(a2(eligible).keptAsChildren, 0);
  assert.deepEqual(a2(eligible).keptAsChildrenMissing, []);
  // D3 の対象の子は「子」に数えない: R+IR に期待の外の Scene を足しても、期待 unavailable の variant の表示（子の一覧）の違いにも、条件 5 (a) の違反にもならない。
  assert.deepEqual(keyOf(eligible, KEY).forbidden.a.violations, []);
  const row = keyOf(eligible, KEY).conditions["forbidden-contribution"]
    .components["a2-index-ready-requery-forbidden"];
  assert.equal(row.graphEdgeCount, 90);
  // 子の開始時に Chronicle の Index が使えなかった（6）を欠く子は、欠けた条件を行ごとに残す。
  const kept = run(edit({ chronicleIndexUsable: false }));
  assert.equal(a2(kept).keptAsChildren, 30);
  assert.equal(a2(kept).keptAsChildrenMissing.length, 30);
  assert.deepEqual(a2(kept).keptAsChildrenMissing[0], {
    variantKey: KEY,
    repeat: 0,
    missingConditions: [6],
  });
  // 述語そのもの。
  const sample = {
    snapshot: { chronicleIndexUsable: false, usable: false },
    irOutcome: "index-ready",
  };
  assert.deepEqual(
    d3Missing(sample, {
      origin: "index-ready",
      refreshTrigger: "graph-ready",
      chronicleIndexUsable: false,
    }),
    [3, 4, 5, 6],
  );
  assert.deepEqual(d3Missing(sample, null), [2]);
});

// ---- レビュー指摘（PR #840）への対応: DR-CP4-QV-3 ------------------------------

/** One `index-ready` child on a variant's every Graph arm sample. */
function indexReadyEdit(
  targetKey,
  {
    child = {},
    sample = {},
    typedRevisions = undefined,
    refusedAtSetup = undefined,
  } = {},
) {
  return (key, ctx) => {
    if (key !== targetKey) return {};
    const runtime = (list) => list.map((id) => `u-${id}`);
    const pair = runtime(fixtureLists(ctx.variant).hybrid);
    return {
      typedRevisions,
      refusedAtSetup,
      mapGraphSample: (_merged, repeat) => ({
        ...k64Sample(
          {
            variantKey: key,
            repeat,
            finalSceneIds: pair,
            snapshot: {
              usable: true,
              reason: null,
              chronicleIndexUsable: false,
            },
            irOutcome: "index-unavailable",
            graph: { outcome: "graph-unavailable", reason: "index-state" },
            ...sample,
          },
          {
            child: {
              ...followUpRecord().child,
              origin: "index-ready",
              refreshTrigger: null,
              chronicleIndexUsable: true,
              outcome: "graph-ready",
              edgeCount: 1,
              rSceneIds: pair,
              irSceneIds: [],
              finalSceneIds: pair,
              materialRevision: {
                unresolvedEdges: 0,
                observed: [
                  {
                    kind: "path-attachment",
                    sceneId: "g08-attach",
                    pairs: [OBSERVED_PAIR],
                    unresolved: 0,
                  },
                ],
              },
              ...(typeof child === "function" ? child(pair, ctx) : child),
            },
          },
        ),
        tFetch: 100,
        tReturn: 130,
        status: "completed",
      }),
    };
  };
}
const CHRONICLE = "G-08/chronicle-index-unusable";
const a2Of = (output) =>
  output.conditions["forbidden-contribution"].components[
    "a2-index-ready-requery-forbidden"
  ];

test("P1-1（品質 v2 C8）: 表示が 0 件の variant（Graph が寄与したのに first-render に数えない 30 件）があっても条件 2 は TypeError にならず fail を返す", () => {
  const output = run((key, ctx) =>
    key === "G-02/base"
      ? firstRenderRows(ctx.variant, ctx.expectation, () => ({
          followUp: { parent: { contribution: null } },
        }))
      : {},
  );
  const row = G02(output);
  assert.deepEqual(row.displayed, {
    firstRender: 0,
    followUp: 0,
    notDisplayed: 30,
  });
  assert.equal(row.metrics.graph, null);
  assert.equal(row.notDisplayedFailures.length, 30);
  const gcase = output.conditions["macro-non-regression"].components["g-case"];
  assert.equal(gcase.status, "fail");
  assert.equal(gcase.notDisplayedFailures[0].variantKey, "G-02/base");
  assert.equal(statusOf(output, "macro-non-regression"), "fail");
  // D8 の fail は、他の variant が hold でも先に返す（hold の判断に入れない）。
  const withHold = run((key, ctx) =>
    key === "G-02/base"
      ? firstRenderRows(ctx.variant, ctx.expectation, () => ({
          followUp: { parent: { contribution: null } },
        }))
      : key === "G-03/base"
        ? { hybrid: ["g03-no-such-scene"] }
        : {},
  );
  assert.equal(
    withHold.conditions["macro-non-regression"].components["g-case"].status,
    "fail",
  );
});

test("P2-1（v2 C4）: Graph を出したかもしれない子の空の記録（probe が paths を出さない形）は D3 (b)(d) を素通りせず hold", () => {
  const output = run(
    indexReadyEdit(CHRONICLE, {
      child: { materialRevision: { unresolvedEdges: 0, observed: [] } },
    }),
  );
  assert.equal(a2Of(output).status, "hold");
  assert.ok(
    a2Of(output).problems.every(
      (entry) => entry.code === "b-observed-path-record-empty",
    ),
  );
  // 記録の無い子は outcome・edgeCount によらず hold（v2 §3 の字義）。
  for (const child of [
    { outcome: "graph-unavailable", edgeCount: null },
    { edgeCount: 0 },
  ]) {
    const none = run(
      indexReadyEdit(CHRONICLE, {
        child: { ...child, materialRevision: undefined },
      }),
    );
    assert.equal(a2Of(none).status, "hold", JSON.stringify(child));
    assert.ok(
      a2Of(none).problems.every(
        (entry) => entry.code === "b-material-revision-record-missing",
      ),
    );
  }
});

test("P3-2（v2 C4）: Scene が論理 ID に無い path（sceneId null）は捨てずに hold", () => {
  const output = run(
    indexReadyEdit(CHRONICLE, {
      child: {
        materialRevision: {
          unresolvedEdges: 0,
          observed: [
            {
              kind: "path-attachment",
              sceneId: null,
              pairs: [OBSERVED_PAIR],
              unresolved: 0,
            },
          ],
        },
      },
    }),
  );
  assert.equal(a2Of(output).status, "hold");
  assert.ok(
    a2Of(output).problems.every(
      (entry) => entry.code === "b-observed-scene-has-no-logical-id",
    ),
  );
});

test("P2-2（v2 C6）: 定常状態の followUp.requeries の行は first-render にせず（FR-6）、N29・N32 と条件 5 の (a) で見る", () => {
  const withRows = (requeries, extra = {}) =>
    run((key, ctx) =>
      key === "G-02/base"
        ? firstRenderRows(ctx.variant, ctx.expectation, (repeat) =>
            repeat === 4 ? { followUp: { requeries, ...extra } } : {},
          )
        : {},
    );
  // 行が 1 つあれば first-render として数えない（FR6）。親は Graph を寄与したので D8 の fail。
  const row = withRows([{ publishCount: 1, lateGraphInDisplay: false }]);
  assert.deepEqual(
    G02(row).notDisplayedFailures.map((entry) => [
      entry.repeat,
      entry.firstRenderFails,
    ]),
    [[4, ["FR6:requeries-1"]]],
  );
  assert.equal(statusOf(row, "macro-non-regression"), "fail");
  // key があっても空の配列なら何も無い（通常の first-render）。
  assert.deepEqual(G02(withRows([])).notDisplayedFailures, []);
  // list でない値は FR6。
  assert.deepEqual(
    G02(withRows("rows")).notDisplayedFailures[0].firstRenderFails,
    ["FR6:requeries-not-a-list"],
  );
  // 遅れた Graph の表示・2 回の公開は条件 5 (b) の fail（N29・N32）。
  for (const requery of [
    { lateGraphInDisplay: true, publishCount: 1 },
    { lateGraphInDisplay: false, publishCount: 2 },
  ]) {
    const output = withRows([requery]);
    assert.equal(
      output.conditions["forbidden-contribution"].components[
        "b-late-graph-in-display"
      ].status,
      "fail",
      JSON.stringify(requery),
    );
  }
  // Scene の一覧を持つ行が禁止 Scene を R+IR に足せば条件 5 の (a) の fail。
  const forbiddenScene = expectationsOf().forbiddenSceneIds[0];
  const listed = withRows([
    { publishCount: 1, finalSceneIds: [`u-${forbiddenScene}`] },
  ]);
  const violation = G02(listed).forbidden.a.violations.find(
    (entry) =>
      entry.reason === "followup-requery-row-forbidden-or-blocked-contribution",
  );
  assert.deepEqual(violation.sceneIds, [forbiddenScene]);
});

test("P3-2（v2 C5）: variantKey の無い再 query の行は黙って捨てず、すべての variant の条件 5 を hold にする。R+IR arm の行は対象外", () => {
  const withRequery = (row) =>
    run((key) =>
      key === "G-02/base"
        ? {
            receipt: {
              requeries: [
                { arm: "graph", trigger: "index-ready-requery", ...row },
              ],
            },
          }
        : {},
    );
  const noKey = withRequery({ finalSceneIds: [] });
  const part =
    noKey.conditions["forbidden-contribution"].components[
      "a3-requery-row-unattributable"
    ];
  assert.equal(part.status, "hold");
  assert.equal(part.rowsWithoutVariantKey, 1);
  assert.equal(part.rowsWithUnknownVariantKey, 0);
  assert.equal(statusOf(noKey, "forbidden-contribution"), "hold");
  // catalog に無い variantKey（誤記）の行も、どの variant の行か決められないので hold。
  const unknown = withRequery({ variantKey: "G-02/bse", finalSceneIds: [] });
  const unknownPart =
    unknown.conditions["forbidden-contribution"].components[
      "a3-requery-row-unattributable"
    ];
  assert.equal(unknownPart.status, "hold");
  assert.equal(unknownPart.rowsWithUnknownVariantKey, 1);
  assert.equal(unknownPart.rowsWithoutVariantKey, 0);
  assert.equal(statusOf(unknown, "forbidden-contribution"), "hold");
  // R+IR arm の行は D4 の対象外（baseline）。variantKey が在れば hold にしない。
  const hybrid = withRequery({
    variantKey: "G-02/base",
    arm: "hybrid",
    finalSceneIds: [],
  });
  assert.equal(
    hybrid.conditions["forbidden-contribution"].components[
      "a3-requery-row-unattributable"
    ].status,
    "n/a",
  );
  // user-operation の行は samples の側（requeries には置かない）。
  assert.equal(
    withRequery({ trigger: "user-operation" }).conditions[
      "forbidden-contribution"
    ].components["a3-requery-row-unattributable"].status,
    "n/a",
  );
});

test("P3-1: D3 の (3)(4)(5) をそれぞれ単独で欠く子は D3 の対象にならず子のまま（Graph を出せば fail）。他の variant の index-ready の子は D3 の対象にしない", () => {
  const keptOnly = (name, options, missing) => {
    const output = run(indexReadyEdit(CHRONICLE, options));
    assert.equal(a2Of(output).eligibleChildren, 0, name);
    assert.equal(a2Of(output).keptAsChildren, 30, name);
    assert.deepEqual(
      a2Of(output).keptAsChildrenMissing[0].missingConditions,
      [missing],
      name,
    );
    assert.equal(
      keyOf(output, CHRONICLE).forbidden.a.violations[0].reason,
      "graph-shown-for-a-variant-expected-unavailable",
      name,
    );
  };
  keptOnly(
    "(3) refreshTrigger",
    { child: { refreshTrigger: "graph-ready" } },
    3,
  );
  keptOnly(
    "(4) 親の Chronicle Index が使えた",
    {
      sample: {
        snapshot: { usable: true, reason: null, chronicleIndexUsable: true },
      },
    },
    4,
  );
  keptOnly(
    "(4) 親の IR が index-unavailable でない",
    { sample: { irOutcome: "index-ready" } },
    4,
  );
  keptOnly(
    "(5) 親の Graph Index が使えなかった",
    {
      sample: {
        snapshot: { usable: false, reason: "x", chronicleIndexUsable: false },
      },
    },
    5,
  );
  // 他の variant（G-02/base）の index-ready の子は、6 条件を満たしても D3 の対象にしない。
  const other = run(
    indexReadyEdit("G-02/base", {
      child: (pair) => ({
        finalSceneIds: [...pair, `u-${expectationsOf().forbiddenSceneIds[0]}`],
      }),
    }),
  );
  assert.equal(a2Of(other).eligibleChildren, 0);
  assert.equal(a2Of(other).keptAsChildren, 0);
  assert.ok(G02(other).forbidden.a.violations.length > 0);
  assert.equal(statusOf(other, "forbidden-contribution"), "fail");
});

test("P3-1: G-08/both-indexes-unusable の子が Graph を出せば fail（D3 の対象は chronicle-index-unusable だけ）", () => {
  const KEY = "G-08/both-indexes-unusable";
  const output = run(
    indexReadyEdit(KEY, {
      sample: {
        snapshot: { usable: false, reason: "x", chronicleIndexUsable: false },
      },
    }),
  );
  const row = keyOf(output, KEY);
  assert.equal(a2Of(output).eligibleChildren, 0);
  assert.equal(
    row.forbidden.a.violations[0].reason,
    "graph-shown-for-a-variant-expected-unavailable",
  );
  assert.equal(statusOf(output, "forbidden-contribution"), "fail");
});

test("P3-1: D3 (a) の一覧の追加（禁止 Scene・blocked 候補を R+IR に足す）は fail、既に R+IR に在る Scene は足したことにならない", () => {
  const output = run(
    indexReadyEdit(CHRONICLE, {
      child: (pair, ctx) => ({
        finalSceneIds: [...pair, `u-${ctx.expectation.forbiddenSceneIds[0]}`],
      }),
    }),
  );
  assert.equal(a2Of(output).status, "fail");
  assert.ok(
    a2Of(output).problems.every(
      (entry) => entry.code === "a-forbidden-contribution",
    ),
  );
  // 純粋な側: blocked 候補でも fail、R+IR の一覧に既に在る禁止 Scene は fail にしない。
  const base = {
    pair: ["p"],
    lists: (ids) => ids,
    forbidden: new Set(["f"]),
    blocked: new Set(["b"]),
    typedRevisions: null,
    typedRevisionOrder: [],
    child: {
      publishCount: 1,
      outcome: "graph-unavailable",
      materialRevision: { unresolvedEdges: 0, observed: [] },
    },
  };
  const codes = (finalSceneIds) =>
    d3Problems({
      ...base,
      child: { ...base.child, finalSceneIds },
    }).map((entry) => entry.code);
  assert.deepEqual(codes(["p", "b"]), ["a-forbidden-contribution"]);
  assert.deepEqual(codes(["p", "f"]), ["a-forbidden-contribution"]);
  assert.deepEqual(codes(["p", "ok"]), []);
  assert.deepEqual(
    d3Problems({
      ...base,
      pair: ["p", "f"],
      child: { ...base.child, finalSceneIds: ["p", "f"] },
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Prereg v3: the four evidence items (quality-evidence-items.mjs). Synthetic
// receipts only; every expectation is the frozen fixtures' own.

const ITEM_IDS = [
  "utf16-range",
  "explicit-pin-association",
  "raw-excerpt-unchanged",
  "added-scene-body-anchor",
];
const itemsOf = (output) => output.conditions["evidence-validity"].components;
const variantItems = (output, key) =>
  keyOf(output, key).conditions["evidence-validity"].components;
/** `edit` for `run`: every variant carries the v3 fields; `mutators` change some. */
const v3 =
  (mutators = {}, rest = () => ({})) =>
  (key, ctx) => ({
    ...rest(key, ctx),
    v3: mutators[key] ?? true,
  });

test("品質 v3: 4 項目の fields を持つ受領書は、fixture の期待と一致すれば 4 項目とも pass（適用 9／9／6／6 variant）。全体は 24 件と (c) が残るので hold", () => {
  const output = run(v3());
  const items = itemsOf(output);
  for (const id of ITEM_IDS) assert.equal(items[id].status, "pass", id);
  assert.deepEqual(
    ITEM_IDS.map((id) => [
      items[id].variants,
      items[id].checked,
      items[id].skipped,
    ]),
    [
      [9, 270, 0],
      [9, 270, 0],
      [6, 180, 0],
      [6, 180, 0],
    ],
  );
  assert.equal(statusOf(output, "evidence-validity"), "pass");
  // Evidence disclosure: every row is the whole summary, none is 1 long.
  const range = items["utf16-range"].disclosure;
  assert.equal(range.notFullRange, 0);
  assert.equal(range.lengthOne, 0);
  assert.equal(range.fullRange, range.rows);
  assert.ok(range.rows > 0);
  assert.deepEqual(output.verdict.failed, []);
  assert.deepEqual(output.verdict.held, []);
  // 24 件と (c) are never passed by these four.
  assert.equal(output.verdict.verdict, "hold");
  assert.deepEqual(output.verdict.unverified, [
    "macro-non-regression",
    "forbidden-contribution",
  ]);
  // A variant whose fixture lists no `requirements` is n/a for all four.
  for (const key of [
    "G-03/frontier-exceeded",
    "G-08/graph-index-unusable",
    "G-08/chronicle-index-unusable",
    "G-08/both-indexes-unusable",
  ])
    for (const id of ITEM_IDS)
      assert.equal(variantItems(output, key)[id].status, "n/a", `${key} ${id}`);
  // G-01 has no `requirements`: the user's answer A applies three items.
  assert.equal(
    variantItems(output, "G-01/v1")["raw-excerpt-unchanged"].status,
    "n/a",
  );
  for (const id of ITEM_IDS.filter((id) => id !== "raw-excerpt-unchanged"))
    assert.equal(variantItems(output, "G-01/v1")[id].status, "pass", id);
  // G-04 v2 and G-08/graph-recovered have no path attachment.
  assert.equal(
    variantItems(output, "G-04/base")["raw-excerpt-unchanged"].status,
    "n/a",
  );
  assert.equal(
    variantItems(output, "G-08/graph-recovered")["raw-excerpt-unchanged"]
      .status,
    "n/a",
  );
  assert.match(renderSummary(output), /v3 の 4 項目/u);
});

test("品質 v3 §2.1 utf16-range: 古い text（G-05 の copper）・別の text の hash・端点に行が無い edge は fail、範囲が 1 文字でも hash が current に一致すれば pass（開示に数える）", () => {
  const key = "G-05/base";
  const copper = textSha256("Xan carries a copper lamp on night watch.");
  const stale = run(
    v3({
      [key]: (data) => {
        // The wire row and the read row both return the superseded text.
        const row = data.observation.typedRevisions
          .flatMap((revision) => revision.evidence)
          .find((entry) => entry.evidenceId.endsWith("g05-xan"));
        row.endUtf16 = "Xan carries a copper lamp on night watch.".length;
        row.quoteSha256 = copper;
        for (const edge of [
          ...data.child.evidence.pathAttachments.flatMap((p) => p.edges),
        ])
          for (const shown of edge.evidence)
            if (shown.evidenceId.endsWith("g05-xan"))
              shown.quoteSha256 = copper;
        return data;
      },
    }),
  );
  assert.equal(variantItems(stale, key)["utf16-range"].status, "fail");
  assert.ok(
    variantItems(stale, key)["utf16-range"].problems.some(
      (entry) => entry.code === "evidence-row-matches-no-endpoint-text",
    ),
  );
  assert.equal(statusOf(stale, "evidence-validity"), "fail");
  assert.ok(stale.verdict.reasons.includes("failed-required-items"));
  // Only the wire row differs from the read row: fail (both must equal).
  const wireOnly = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments[0].edges[0].evidence[0].quoteSha256 =
          textSha256("another text");
        return data;
      },
    }),
  );
  assert.equal(variantItems(wireOnly, key)["utf16-range"].status, "fail");
  // An edge with no Evidence row at all is a fail (iii).
  const none = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments[0].edges[0].evidence = [];
        return data;
      },
    }),
  );
  assert.equal(variantItems(none, key)["utf16-range"].status, "fail");
  assert.ok(
    variantItems(none, key)["utf16-range"].problems.some(
      (entry) => entry.code === "endpoint-without-valid-evidence",
    ),
  );
  // One endpoint without a valid row is a fail too.
  const oneEnd = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments[0].edges[0].evidence.pop();
        return data;
      },
    }),
  );
  assert.equal(variantItems(oneEnd, key)["utf16-range"].status, "fail");
  // A displayed evidenceId that the read Revision does not hold (ii).
  const unknown = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments[0].edges[0].evidence[0].evidenceId =
          "ev-not-in-the-revision";
        return data;
      },
    }),
  );
  assert.equal(variantItems(unknown, key)["utf16-range"].status, "fail");
  assert.ok(
    variantItems(unknown, key)["utf16-range"].problems.some(
      (entry) => entry.code === "evidence-id-not-in-revision",
    ),
  );
  // A 1-character range passes when its hash is the current text's (v3 §8 9).
  const short = run(
    v3({
      [key]: (data) => {
        const text = "Xan carries a silver lamp on night watch.";
        for (const revision of data.observation.typedRevisions)
          for (const row of revision.evidence)
            if (row.evidenceId.endsWith("g05-xan")) {
              row.startUtf16 = 0;
              row.endUtf16 = 1;
              row.quoteSha256 = textSha256(text.slice(0, 1));
            }
        for (const path of data.child.evidence.pathAttachments)
          for (const edge of path.edges)
            for (const shown of edge.evidence)
              if (shown.evidenceId.endsWith("g05-xan"))
                shown.quoteSha256 = textSha256(text.slice(0, 1));
        return data;
      },
    }),
  );
  assert.equal(variantItems(short, key)["utf16-range"].status, "pass");
  assert.ok(itemsOf(short)["utf16-range"].disclosure.notFullRange > 0);
  assert.ok(itemsOf(short)["utf16-range"].disclosure.lengthOne > 0);
  // A range past the end of the current text is never accepted.
  const past = run(
    v3({
      [key]: (data) => {
        for (const revision of data.observation.typedRevisions)
          for (const row of revision.evidence) row.endUtf16 += 5;
        return data;
      },
    }),
  );
  assert.equal(variantItems(past, key)["utf16-range"].status, "fail");
});

test("品質 v3 §2.1 utf16-range: 読み取り済みの Evidence が無い・sample の後に読んでいない・Revision を読めない・field が無いのは hold（fail でも pass でもない）", () => {
  const key = "G-06/base";
  const hold = (mutate) =>
    variantItems(run(v3({ [key]: mutate })), key)["utf16-range"];
  const noObservation = hold((data) => {
    delete data.observation;
    return data;
  });
  assert.equal(noObservation.status, "hold");
  assert.equal(noObservation.problems[0].code, "evidence-observation-missing");
  assert.equal(
    hold((data) => {
      data.observation.readAfterSamples = false;
      return data;
    }).problems[0].code,
    "evidence-observation-not-read-after-samples",
  );
  assert.equal(
    hold((data) => {
      data.observation.typedRevisions[0] = {
        logicalRevisionId: data.observation.typedRevisions[0].logicalRevisionId,
        runtimeRevisionId: "x",
        unavailable: "not-found",
      };
      return data;
    }).status,
    "hold",
  );
  assert.equal(
    hold((data) => {
      delete data.child.evidence;
      return data;
    }).problems[0].code,
    "evidence-field-missing",
  );
  assert.equal(
    hold((data) => {
      for (const path of data.child.evidence.pathAttachments)
        for (const edge of path.edges) delete edge.evidence;
      return data;
    }).status,
    "hold",
  );
  // A fail is stronger than a hold in one variant.
  const mixed = hold((data) => {
    data.child.evidence.pathAttachments[0].edges[0].evidence = [];
    data.observation.readAfterSamples = true;
    return data;
  });
  assert.equal(mixed.status, "fail");
});

test("品質 v3 §2.2 explicit-pin-association: 期待の外の Scene への path（G-06 の名前の言及）・pin・終端・hop の食い違いは fail、field が無いのは hold、G-01 は attachment が付けば fail", () => {
  const key = "G-06/base";
  const fixture = readJson("evals/nir1-graph/g06-evidence-anchor-path.v1.json");
  const pinOf = (output, k = key) =>
    variantItems(output, k)["explicit-pin-association"];
  // Name-inferred association: g06-c4 mentions Bram but has no pin.
  const inferred = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments.push({
          sceneId: "u-g06-c4",
          hop: 1,
          edges: [data.child.evidence.pathAttachments[1].edges[1]],
        });
        return data;
      },
    }),
  );
  assert.equal(pinOf(inferred).status, "fail");
  assert.ok(
    pinOf(inferred).problems.some(
      (p) => p.code === "attachment-outside-expectation",
    ),
  );
  assert.ok(fixture.variants[0].expectations.scenesWithoutPath.length > 0);
  // The terminal Entity differs (the path ends at another Entity).
  const terminal = run(
    v3({
      [key]: (data) => {
        const edges = data.child.evidence.pathAttachments[0].edges;
        edges[edges.length - 1].to = "e-g06-bram";
        return data;
      },
    }),
  );
  assert.equal(pinOf(terminal).status, "fail");
  // The hop differs.
  const hop = run(
    v3({
      [key]: (data) => {
        data.child.evidence.pathAttachments[1].hop = 3;
        return data;
      },
    }),
  );
  assert.equal(pinOf(hop).status, "fail");
  // `hop` missing is a hold.
  const noHop = run(
    v3({
      [key]: (data) => {
        delete data.child.evidence.pathAttachments[0].hop;
        return data;
      },
    }),
  );
  assert.equal(pinOf(noHop).status, "hold");
  // Graph-only: wrong pin Entity, wrong hop, missing pin field.
  const g02 = "G-02/base";
  assert.equal(
    pinOf(
      run(
        v3({
          [g02]: (data) => {
            data.child.evidence.graphOnly.pinEntityId = "e-g02-other";
            return data;
          },
        }),
      ),
      g02,
    ).status,
    "fail",
  );
  assert.equal(
    pinOf(
      run(
        v3({
          [g02]: (data) => {
            data.child.evidence.graphOnly.hop = 2;
            return data;
          },
        }),
      ),
      g02,
    ).status,
    "fail",
  );
  assert.equal(
    pinOf(
      run(
        v3({
          [g02]: (data) => {
            delete data.child.evidence.graphOnly.pinEntityId;
            return data;
          },
        }),
      ),
      g02,
    ).status,
    "hold",
  );
  // A Graph-only row on a Scene the fixture does not name.
  assert.equal(
    pinOf(
      run(
        v3({
          [g02]: (data) => {
            data.child.evidence.graphOnly.sceneId = `u-${fixtureLists(GRAPH_EVAL_VARIANTS.find((row) => row.key === g02)).hybrid[0]}`;
            return data;
          },
        }),
      ),
      g02,
    ).status,
    "fail",
  );
  // G-01 has no path attachment: one that appears is a fail.
  const g01 = "G-01/v1";
  const attached = run(
    v3({
      [g01]: (data) => {
        data.child.evidence.pathAttachments.push({
          sceneId: "u-g01-question",
          hop: 1,
          edges: data.child.evidence.graphOnly.edges,
        });
        return data;
      },
    }),
  );
  assert.equal(pinOf(attached, g01).status, "fail");
  // Nothing expected displayed at all: a hold (the edge binding fails it).
  const nothing = run(
    v3({
      [g01]: (data) => {
        data.child.evidence.graphOnly = null;
        return data;
      },
    }),
  );
  assert.equal(pinOf(nothing, g01).status, "hold");
});

test("品質 v3 §2.3 raw-excerpt-unchanged: 同じ sample の親と子の R+IR の行（membership・順序・excerpt の hash と長さ）が違えば fail、比べられない（IR 未完・世代の食い違い・field 無し）は hold、Graph-only 行は比べない", () => {
  const key = "G-03/base";
  const rawOf = (output, k = key) =>
    variantItems(output, k)["raw-excerpt-unchanged"];
  const changed = run(
    v3({
      [key]: (data) => {
        data.child.rowExcerpts[0].excerptSha256 = textSha256("rewritten");
        return data;
      },
    }),
  );
  assert.equal(rawOf(changed).status, "fail");
  const reordered = run(
    v3({
      [key]: (data) => {
        data.child.rowExcerpts.reverse();
        return data;
      },
    }),
  );
  assert.equal(rawOf(reordered).status, "fail");
  const shorter = run(
    v3({
      [key]: (data) => {
        data.child.rowExcerpts[0].excerptUtf16Length += 1;
        return data;
      },
    }),
  );
  assert.equal(rawOf(shorter).status, "fail");
  const dropped = run(
    v3({
      [key]: (data) => {
        data.child.rowExcerpts.pop();
        return data;
      },
    }),
  );
  assert.equal(rawOf(dropped).status, "fail");
  const added = run(
    v3({
      [key]: (data) => {
        data.child.rowExcerpts.push({
          sceneId: "u-extra",
          kind: "ir",
          excerptSha256: textSha256("ir"),
          excerptUtf16Length: 2,
        });
        return data;
      },
    }),
  );
  assert.equal(rawOf(added).status, "fail");
  // A Graph-only row on the child is not compared.
  const g02 = "G-02/base";
  assert.equal(rawOf(run(v3()), g02).status, "pass");
  assert.equal(
    rawOf(
      run(
        v3({
          [g02]: (data) => {
            const only = data.child.rowExcerpts.find(
              (row) => row.kind === "graph-only",
            );
            only.excerptSha256 = textSha256("anything");
            return data;
          },
        }),
      ),
      g02,
    ).status,
    "pass",
  );
  // Not comparable in the same sample: a hold, not a fail.
  for (const mutate of [
    (data) => {
      // Not later than the parent's generation.
      data.child.queryGeneration = data.parent.queryGeneration;
    },
    (data) => {
      // Another query Scene (a different query), or a Raw recovery.
      data.child.sceneId = "another-scene";
    },
    (data) => {
      data.child.origin = "raw-recovery";
    },
    (data) => {
      data.child.seed = "another-seed";
    },
  ]) {
    const other = run(
      v3({
        [key]: (data) => {
          mutate(data);
          return data;
        },
      }),
    );
    assert.equal(rawOf(other).status, "hold");
  }
  const irNotComplete = run(
    v3({ [key]: (data) => data }, (k) =>
      k === key
        ? { mapGraphSample: (sample) => ({ ...sample, irOutcome: "timeout" }) }
        : {},
    ),
  );
  assert.equal(rawOf(irNotComplete).status, "hold");
  const missing = run(
    v3({
      [key]: (data) => {
        delete data.parent.rowExcerpts;
        return data;
      },
    }),
  );
  assert.equal(rawOf(missing).status, "hold");
  // G-01, G-04 v2 and G-08/graph-recovered have no path attachment: n/a.
  assert.equal(rawOf(run(v3()), "G-01/v1").status, "n/a");
});

test("品質 v3 §2.4 added-scene-body-anchor: Graph-only 行の Scene・範囲・excerpt の hash と長さが fixture の期待（範囲と本文）と 1 つでも違えば fail、field が無い・期待の行が無いのは hold", () => {
  const key = "G-07/base";
  const anchor = (output, k = key) =>
    variantItems(output, k)["added-scene-body-anchor"];
  for (const [label, mutate, code] of [
    [
      "end is 1 too long (a canonical newline)",
      (data) => {
        data.child.evidence.graphOnly.canonicalRange.end += 1;
      },
      "anchor-range-differs",
    ],
    [
      "start is not 0",
      (data) => {
        data.child.evidence.graphOnly.canonicalRange.start = 1;
      },
      "anchor-range-differs",
    ],
    [
      "excerpt hash is not the body's",
      (data) => {
        data.child.evidence.graphOnly.excerptSha256 =
          textSha256("a shorter excerpt");
      },
      "anchor-excerpt-hash-differs",
    ],
    [
      "excerpt length is not the body's",
      (data) => {
        data.child.evidence.graphOnly.excerptUtf16Length -= 1;
      },
      "anchor-excerpt-length-differs",
    ],
    [
      "another Scene",
      (data) => {
        data.child.evidence.graphOnly.sceneId = `u-${fixtureLists(GRAPH_EVAL_VARIANTS.find((row) => row.key === key)).hybrid[0]}`;
      },
      "anchor-scene-differs",
    ],
  ]) {
    const output = run(
      v3({
        [key]: (data) => {
          mutate(data);
          return data;
        },
      }),
    );
    assert.equal(anchor(output).status, "fail", label);
    assert.ok(
      anchor(output).problems.some((entry) => entry.code === code),
      label,
    );
  }
  // An absent field, or a displayed child with no Graph-only row, is a hold.
  assert.equal(
    anchor(
      run(
        v3({
          [key]: (data) => {
            delete data.child.evidence.graphOnly.excerptSha256;
            return data;
          },
        }),
      ),
    ).status,
    "hold",
  );
  assert.equal(
    anchor(
      run(
        v3({
          [key]: (data) => {
            data.child.evidence.graphOnly = null;
            return data;
          },
        }),
      ),
    ).status,
    "hold",
  );
  // No `evidence` field at all (an older receipt) holds; it never passes.
  assert.equal(
    anchor(
      run(
        v3({
          [key]: (data) => {
            delete data.child.evidence;
            return data;
          },
        }),
      ),
    ).status,
    "hold",
  );
});

test("品質 v3 §2.0: 適用する variant がすべて blocked の項目は n/a でなく not-evaluable（条件 4 を pass にしない）。blocked でない variant の fail は blocked に隠れない", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qv-ledger-"));
  try {
    const anchorKeys = [
      "G-01/v1",
      "G-02/base",
      "G-04/base",
      "G-07/base",
      "G-08/base-usable",
      "G-08/graph-recovered",
    ];
    const ledgerFor = (keys) => {
      const file = path.join(dir, `ledger-${keys.length}.json`);
      writeFileSync(
        file,
        JSON.stringify({
          status: "completed",
          s4Commit: S4,
          candidate: { commit: CANDIDATE },
          variants: Object.fromEntries(
            keys.map((key) => [key, "blocked:cb4-inputs"]),
          ),
        }),
      );
      return file;
    };
    const blockedAll = run(v3(), { ledgerPath: ledgerFor(anchorKeys) });
    const anchor = itemsOf(blockedAll)["added-scene-body-anchor"];
    assert.equal(anchor.status, "not-evaluable");
    assert.equal(anchor.reason, "every-applicable-variant-is-blocked");
    // The other items still pass over their remaining variants, and the
    // condition is not a pass while one item is unverified.
    assert.equal(itemsOf(blockedAll)["utf16-range"].variants, 3);
    assert.equal(statusOf(blockedAll, "evidence-validity"), "not-evaluable");
    assert.ok(
      blockedAll.notEvaluable.some(
        (row) =>
          row.condition === "evidence-validity" &&
          row.component === "added-scene-body-anchor",
      ),
    );
    // One live variant keeps the item evaluated.
    const oneLive = run(v3(), { ledgerPath: ledgerFor(anchorKeys.slice(1)) });
    assert.equal(itemsOf(oneLive)["added-scene-body-anchor"].status, "pass");
    assert.equal(itemsOf(oneLive)["added-scene-body-anchor"].variants, 1);
    // A fail of a live variant is not hidden by blocked ones.
    const failing = run(
      v3({
        "G-01/v1": (data) => {
          data.child.evidence.graphOnly.canonicalRange.end += 1;
          return data;
        },
      }),
      { ledgerPath: ledgerFor(anchorKeys.slice(1)) },
    );
    assert.equal(itemsOf(failing)["added-scene-body-anchor"].status, "fail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("品質 v3 §2.0: 受領書に無い runtime ID（端点の Entity・Scene）は [precheck]、fixture の current の text が定まらない mutation も [precheck]", () => {
  assert.throws(
    () =>
      run(
        v3({
          "G-06/base": (data) => {
            data.child.evidence.pathAttachments[0].edges[0].from =
              "e-not-in-the-map";
            return data;
          },
        }),
      ),
    /\[precheck\].*no logical ID/u,
  );
  assert.throws(
    () =>
      run(
        v3({
          "G-06/base": (data) => {
            data.child.evidence.pathAttachments[0].sceneId = "u-unknown-scene";
            return data;
          },
        }),
      ),
    /\[precheck\]/u,
  );
  // logicalToRuntime that is not one to one.
  assert.throws(
    () =>
      run(
        v3({
          "G-06/base": (data) => {
            data.entities["g06-ines"] = data.entities["g06-maro"];
            return data;
          },
        }),
      ),
    /\[precheck\].*not one to one/u,
  );
});

test("品質 v3 §2.1: 期待の current の text は fixture の mutation を setupTimeline の順に当てる（onlyInVariants は variant ごと）。継がない mutation は [precheck]", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const texts = (key) => expectations[key].evidence.entityTexts;
  // G-05: the current text is the silver one (the assertion's currentText).
  assert.deepEqual(texts("G-05/base")["g05-xan"], [
    "Xan",
    "Xan carries a silver lamp on night watch.",
  ]);
  // G-08: the Juno mutation applies to graph-recovered only, not base-usable.
  assert.match(texts("G-08/base-usable")["g08-juno"][1], /parlor/u);
  assert.doesNotMatch(texts("G-08/base-usable")["g08-juno"][1], /violin/u);
  assert.match(texts("G-08/graph-recovered")["g08-juno"][1], /violin/u);
  // Every applicable-variant expectation names both a label and a summary.
  for (const [key, expectation] of Object.entries(expectations))
    for (const row of Object.values(expectation.evidence.entityTexts))
      assert.ok(
        row.every((text) => typeof text === "string" && text.length > 0),
        key,
      );
  // The exact set of applicable variants (prereg v3 §3).
  const applies = (id) =>
    Object.entries(expectations)
      .filter(([, expectation]) => expectation.evidence.applies[id])
      .map(([key]) => key);
  assert.equal(applies("utf16-range").length, 9);
  assert.equal(applies("explicit-pin-association").length, 9);
  assert.equal(applies("raw-excerpt-unchanged").length, 6);
  assert.equal(applies("added-scene-body-anchor").length, 6);
});

test("品質 v3 §2.0 skip と D8: 子が無い・graph-ready でない sample は検査せず件数を開示する。親の合流が表示に寄与したのに first-render でない sample は raw-excerpt-unchanged では hold（他の 3 件は skip）。first-render は親の記録を表示側として読む", () => {
  const { expectations } = loadExpectations({
    root: DEFAULT_ROOT,
    graphManifest: readJson(GRAPH_MANIFEST),
  });
  const variant = GRAPH_EVAL_VARIANTS.find((row) => row.key === "G-02/base");
  const base = v3Base(variant, expectations[variant.key]);
  const receipt = {
    runId: "unit",
    settings: {
      seed: base.seed,
      setupReceipt: {
        logicalToRuntime: { entities: base.entities, scenes: {} },
      },
    },
    evidenceObservation: base.observation,
  };
  // Scenes the unit reads: map the runtime Scene IDs the rows use.
  const sceneIds = new Set([
    ...base.child.rowExcerpts.map((row) => row.sceneId),
    ...base.child.evidence.pathAttachments.map((row) => row.sceneId),
  ]);
  receipt.settings.setupReceipt.logicalToRuntime.scenes = Object.fromEntries(
    [...sceneIds].map((id) => [id.replace(/^u-/u, ""), id]),
  );
  const material = {
    observed: expectations[variant.key].expectedContributions.map((row) => ({
      kind: row.kind,
      sceneId: row.sceneId,
      pairs: row.edgeIds.map((edge) => `rev-of-${edge}|${edge}`),
      unresolved: 0,
    })),
  };
  const followed = (repeat) => ({
    repeat,
    irOutcome: "ir-ready",
    graph: { outcome: "graph-late" },
    followUp: {
      parent: { ...clone(base.parent), sceneId: "scene-q", seed: "seed-q" },
      child: {
        origin: "graph-ready",
        sceneId: "scene-q",
        seed: "seed-q",
        outcome: "graph-ready",
        materialRevision: material,
        ...clone(base.child),
      },
    },
  });
  const follow = {
    displayed: true,
    firstRender: false,
    parentContributed: false,
  };
  const evaluate = (inputs) =>
    evaluateEvidenceItems({
      variantKey: variant.key,
      expectation: expectations[variant.key],
      receipt,
      inputs,
    });
  // follow-up: all four pass.
  const ok = evaluate([{ sample: followed(0), result: follow }]);
  for (const id of ITEM_IDS) assert.equal(ok[id].status, "pass", id);
  // No child: skipped (counted), so no sample was checked: hold.
  const noChild = followed(1);
  delete noChild.followUp.child;
  const skipped = evaluate([
    {
      sample: noChild,
      result: {
        displayed: false,
        firstRender: false,
        parentContributed: false,
      },
    },
  ]);
  for (const id of ITEM_IDS) {
    assert.equal(skipped[id].skipped, 1, id);
    assert.equal(skipped[id].status, "hold", id);
  }
  // D8: the parent's Graph reached the display but was not a first render.
  const d8 = evaluate([
    { sample: followed(2), result: follow },
    {
      sample: noChild,
      result: { displayed: false, firstRender: false, parentContributed: true },
    },
  ]);
  assert.equal(d8["raw-excerpt-unchanged"].status, "hold");
  assert.ok(
    d8["raw-excerpt-unchanged"].problems.some(
      (entry) => entry.code === "d8-graph-contributed-without-a-first-render",
    ),
  );
  for (const id of ITEM_IDS.filter((id) => id !== "raw-excerpt-unchanged")) {
    assert.equal(d8[id].status, "pass", id);
    assert.equal(d8[id].skipped, 1, id);
  }
  // first-render: the parent's record is the display side. Its Graph rows are
  // checked (items 1, 2, 4); there is no child to compare (item 3: hold).
  const first = followed(3);
  first.followUp.parent = {
    ...clone(base.child),
    contribution: { materialRevision: material },
  };
  first.graph = { outcome: "graph-ready" };
  delete first.followUp.child;
  const firstRender = evaluate([
    {
      sample: first,
      result: { displayed: true, firstRender: true, parentContributed: true },
    },
  ]);
  for (const id of ITEM_IDS.filter((id) => id !== "raw-excerpt-unchanged"))
    assert.equal(firstRender[id].status, "pass", id);
  assert.equal(firstRender["raw-excerpt-unchanged"].status, "hold");
});
