// Synthetic receipts only (DR-CP4-QV-1). Every sample list is built from the
// frozen fixtures' own predeclared lists, so the end-to-end checks also prove
// that the loader, the scorer and the fixture expectations agree. Receipts
// are written to a fresh temp directory; nothing in the repository changes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { GRAPH_EVAL_D_MS, GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  DEFAULT_ROOT,
  GRAPH_MANIFEST,
  PROCEDURE_FILE,
  RETRIEVAL_MANIFEST,
  buildQualityVerdict,
  loadExpectations,
  loadQualityInputs,
  readMetricTolerance,
  readReceiptDir,
  renderSummary,
  sha256,
  verifyBindings,
} from "./quality-verdict-cli.mjs";
import {
  deriveLatencyPolicy,
  evaluateQualityVerdict,
} from "./quality-verdict.mjs";
import { H40, k64Sample } from "./test-support.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const S4 = H40("5");
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
const PROCEDURE_SHA = sha256(
  readFileSync(path.join(DEFAULT_ROOT, PROCEDURE_FILE)),
);

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
    const samples = [];
    for (let repeat = 0; repeat < 30; repeat += 1) {
      const latency = change.latency?.(repeat) ?? { hybrid: 30, graph: 30 };
      samples.push({
        variantKey: key,
        arm: "hybrid",
        phase: "measured",
        repeat,
        trigger: "user-operation",
        tFetch: 100,
        tReturn: 100 + latency.hybrid,
        status: "completed",
        finalSceneIds: runtime(hybridLogical),
      });
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
      head: { observationPrep: { commit: S4 } },
      candidate: { commit: CANDIDATE },
      environment: { windowSamples: WINDOW, ownPids: [] },
      settings: {
        variantKey: key,
        setupReceipt: { logicalToRuntime: { scenes } },
        k64: { procedureFile: { sha256: PROCEDURE_SHA } },
      },
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
  assert.equal(statusOf(output, "evidence-validity"), "not-evaluable");
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
    reasons: ["unverified-required-items"],
    failed: [],
    held: [],
    unverified: [
      "macro-non-regression",
      "evidence-validity",
      "forbidden-contribution",
    ],
  });
  const listed = output.notEvaluable.map(
    (row) => `${row.condition}/${row.component}`,
  );
  assert.ok(listed.includes("macro-non-regression/existing-24-graph-arm"));
  assert.ok(listed.includes("evidence-validity/utf16-range"));
  assert.ok(
    listed.includes(
      "forbidden-contribution/c-existing-24-graph-appearance-and-dto",
    ),
  );
  assert.match(
    renderSummary(output),
    /全体：hold（unverified-required-items）/u,
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

test("no threshold is written in the verdict code; the manifest and the K6/2 text decide", () => {
  for (const file of ["quality-verdict.mjs", "quality-verdict-cli.mjs"]) {
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
