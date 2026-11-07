// CP-4 quality verdict: file loading, bindings and the command line around
// the pure verdict (quality-verdict.mjs, DR-CP4-QV-1).
//
// Usage:
//   node scripts/quality/nir1-graph-eval/quality-verdict-cli.mjs \
//     --gold-dir <dir> --allow-list <json> [--parity-dir <dir>] [--ledger <json>] \
//     --out <verdict.json> [--summary <summary.md>]
//   node scripts/quality/nir1-graph-eval/quality-verdict-cli.mjs --verify <verdict.json>
//     (the allow list is read by file name from the verdict file's directory)
//
// Reads receipts, never rewrites them. Every file the verdict depends on is
// bound by sha256 in the output; `--verify` recomputes them.

import console from "node:console";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import {
  FROZEN_FIXTURE_SHA256,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_VARIANTS,
  K62_FREEZE,
  K65_FREEZE,
} from "./constants.mjs";
import { loadProcedureFile } from "./procedure-file.mjs";
import {
  QUALITY_VERDICT_SCHEMA,
  deriveLatencyPolicy,
  evaluateQualityVerdict,
} from "./quality-verdict.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const DEFAULT_ROOT = path.resolve(HERE, "../../..");
export const GRAPH_MANIFEST = "evals/nir1-graph/manifest.v1.json";
export const RETRIEVAL_MANIFEST = "evals/nir1-retrieval/manifest.json";
export const PROCEDURE_FILE =
  "scripts/quality/nir1-graph-eval/procedure/k64-procedure.v2.json";
/** The formal procedure version `PROCEDURE_FILE` is (read by the formal loader). */
const PROCEDURE_VERSION = "v2";
const CODE_FILES = Object.freeze([
  "scripts/quality/nir1-graph-eval/quality-verdict.mjs",
  "scripts/quality/nir1-graph-eval/quality-verdict-cli.mjs",
  "scripts/quality/nir1-graph-eval/followup.mjs",
  "scripts/quality/nir1-graph-eval/receipt.mjs",
  "scripts/quality/nir1-graph-eval/constants.mjs",
  "scripts/quality/nir1-graph-eval/join.mjs",
  "scripts/quality/nir1-retrieval/contract.mjs",
]);

function precheck(message) {
  return new Error(`[precheck] ${message}`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    throw precheck(`cannot read ${file}: ${error.code ?? error.message}`);
  }
}

function readJson(file) {
  return JSON.parse(readBytes(file));
}

function bound(root, relative) {
  return {
    path: relative,
    sha256: sha256(readBytes(path.join(root, relative))),
  };
}

/** The metric tolerance, read from the K6/2 text after its pinned digest. */
export function readMetricTolerance(root) {
  const bytes = readBytes(path.join(root, K62_FREEZE.path));
  if (sha256(bytes) !== K62_FREEZE.sha256)
    throw precheck("the K6/2 text differs from its frozen digest");
  const match = /同じ許容誤差\s*(1e-\d+)/u.exec(bytes.toString("utf8"));
  if (!match)
    throw precheck("the K6/2 text does not state the metric tolerance");
  return {
    tolerance: Number(match[1]),
    source: { ...bound(root, K62_FREEZE.path), text: match[0] },
  };
}

function gradesOf(fixture) {
  return Object.fromEntries(
    fixture.scenes.map((scene) => [scene.id, scene.gold]),
  );
}

function metricsOf(expectations, key) {
  const metrics = expectations?.metrics;
  for (const arm of ["raw", "rPlusIr", "rPlusIrPlusGraph"])
    if (
      !Number.isFinite(metrics?.[arm]?.recallAt8) ||
      !Number.isFinite(metrics?.[arm]?.ndcgAt8)
    )
      throw precheck(`${key}: the fixture has no expected metrics for ${arm}`);
  return metrics;
}

/** Normalized fixture expectations of the 13 catalog variants. */
export function loadExpectations({ root, graphManifest }) {
  const predeclared = (graphManifest?.cases ?? []).filter(
    (row) => row.predeclaredImprovement === true,
  );
  if (predeclared.length !== 1 || predeclared[0].caseId !== "G-01")
    throw precheck(
      "the manifest does not predeclare G-01 as the single improvement case",
    );
  const expectations = {};
  const files = new Map();
  for (const variant of GRAPH_EVAL_VARIANTS) {
    const bytes = readBytes(path.join(root, variant.fixturePath));
    if (sha256(bytes) !== FROZEN_FIXTURE_SHA256[variant.fixturePath])
      throw precheck(`${variant.fixturePath} differs from its frozen digest`);
    files.set(variant.fixturePath, sha256(bytes));
    const fixture = JSON.parse(bytes);
    const base = {
      expectedGraph: variant.expectedGraph,
      grades: gradesOf(fixture),
      eligibleSceneIds: fixture.eligibleSceneIds,
      predeclaredImprovement: variant.caseId === "G-01",
    };
    if (!Array.isArray(base.eligibleSceneIds))
      throw precheck(`${variant.key}: the fixture has no eligibleSceneIds`);
    if (variant.caseId === "G-01") {
      const path0 = fixture.expectations?.graphPath;
      if (!path0?.sceneId || !path0?.edgeId)
        throw precheck("G-01: the fixture has no graphPath expectation");
      expectations[variant.key] = {
        ...base,
        forbiddenSceneIds: [],
        blockedSceneIds: [],
        expectedContributions: [
          {
            kind: "graph-only",
            sceneId: path0.sceneId,
            edgeIds: [path0.edgeId],
          },
        ],
        metrics: metricsOf(fixture.expectations, variant.key),
      };
      continue;
    }
    const fixtureVariant = fixture.variants?.find(
      (row) => row.id === variant.variantId,
    );
    const expected = fixtureVariant?.expectations;
    if (!expected) throw precheck(`${variant.key}: not in its fixture`);
    if (expected.graph?.status !== variant.expectedGraph)
      throw precheck(
        `${variant.key}: fixture and catalog disagree on the Graph status`,
      );
    if (!Array.isArray(expected.forbiddenSceneIds))
      throw precheck(`${variant.key}: the fixture has no forbiddenSceneIds`);
    const contributions = [];
    if (expected.addedScene?.sceneId)
      contributions.push({
        kind: "graph-only",
        sceneId: expected.addedScene.sceneId,
        edgeIds: expected.addedScene.path?.edgeIds ?? [],
      });
    for (const row of expected.pathAttachments ?? [])
      contributions.push({
        kind: "path-attachment",
        sceneId: row.sceneId,
        edgeIds: row.path?.edgeIds ?? [],
      });
    expectations[variant.key] = {
      ...base,
      forbiddenSceneIds: expected.forbiddenSceneIds,
      blockedSceneIds: (expected.blockedCandidates ?? []).map(
        (row) => row.sceneId,
      ),
      expectedContributions: contributions,
      metrics: metricsOf(expected, variant.key),
    };
  }
  return {
    expectations,
    fixtureFiles: [...files].map(([file, digest]) => ({
      path: file,
      sha256: digest,
    })),
  };
}

export function readReceiptDir(dir) {
  if (!existsSync(dir))
    throw precheck(`receipt directory ${dir} does not exist`);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".receipt.json"))
    .sort();
  if (names.length === 0) throw precheck(`${dir} holds no receipt`);
  const listing = existsSync(path.join(dir, "files.sha256"))
    ? new Map(
        readFileSync(path.join(dir, "files.sha256"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [digest, name] = line.split(/\s+/u);
            return [name.replace(/^\.\//u, ""), digest];
          }),
      )
    : null;
  return names.map((name) => {
    const file = path.join(dir, name);
    const bytes = readBytes(file);
    const digest = sha256(bytes);
    if (listing && listing.get(name) !== digest)
      throw precheck(`${file} differs from files.sha256`);
    const validation = path.join(
      dir,
      name.replace(/\.receipt\.json$/u, ".validation.json"),
    );
    if (existsSync(validation) && readJson(validation).valid !== true)
      throw precheck(`${file} is recorded invalid by its validation file`);
    return {
      path: path.resolve(file),
      sha256: digest,
      receipt: JSON.parse(bytes),
    };
  });
}

/** Everything the verdict needs, with its bindings; no verdict yet. */
export function loadQualityInputs({
  root = DEFAULT_ROOT,
  goldDir,
  parityDir = null,
  allowListPath,
  ledgerPath = null,
  // The repository the procedure file is read from, at the S4 commit (the
  // tests' throwaway repository; the default is `root`).
  procedureRoot = root,
}) {
  const graphManifest = readJson(path.join(root, GRAPH_MANIFEST));
  const retrievalManifest = readJson(path.join(root, RETRIEVAL_MANIFEST));
  const allowBytes = readBytes(allowListPath);
  const allowList = JSON.parse(allowBytes);
  // The formal loader (K6/5: D, B and the p95 limit are the frozen file's,
  // read from the S4 commit; a draft, a placeholder review or a value other
  // than the contract's is a `[precheck]`), never a plain JSON read.
  const procedure = loadProcedureFile({
    root: procedureRoot,
    version: PROCEDURE_VERSION,
    commit: allowList.s4Commit,
    purpose: "formal",
  });
  if (procedure.path !== PROCEDURE_FILE)
    throw precheck(`the procedure file is not ${PROCEDURE_FILE}`);
  const policy = deriveLatencyPolicy(retrievalManifest, procedure);
  const { tolerance, source: toleranceSource } = readMetricTolerance(root);
  const { expectations, fixtureFiles } = loadExpectations({
    root,
    graphManifest,
  });
  const gold = readReceiptDir(goldDir);
  const parity = parityDir ? readReceiptDir(parityDir) : [];
  if (procedure.values?.dMs !== GRAPH_EVAL_D_MS)
    throw precheck("the procedure file and the frozen D disagree");
  const procedureDigest = procedure.sha256;
  for (const { receipt } of [...gold, ...parity]) {
    if (receipt.settings?.k64?.procedureFile?.sha256 !== procedureDigest)
      throw precheck(
        `${receipt.runId}: the receipt's procedure differs from ${PROCEDURE_FILE}`,
      );
    // K6/5 変える点 7: the receipt names the K6/5 freeze (K65_FREEZE).
    if (
      receipt.head?.k65?.freezeCommit !== K65_FREEZE.freezeCommit ||
      receipt.head?.k65?.sha256 !== K65_FREEZE.sha256
    )
      throw precheck(
        `${receipt.runId}: the receipt's head.k65 is not the K6/5 freeze (${K65_FREEZE.freezeCommit})`,
      );
  }
  let blocked = null;
  let ledgerBinding = null;
  if (ledgerPath) {
    const bytes = readBytes(ledgerPath);
    const ledger = JSON.parse(bytes);
    if (
      ledger.status !== "completed" ||
      ledger.s4Commit !== allowList.s4Commit ||
      ledger.candidate?.commit !== allowList.candidate
    )
      throw precheck(
        "the ledger is not a completed run under the allowed pair",
      );
    blocked = Object.fromEntries(
      Object.entries(ledger.variants ?? {}).filter(([, value]) =>
        String(value).startsWith("blocked"),
      ),
    );
    ledgerBinding = { path: path.resolve(ledgerPath), sha256: sha256(bytes) };
  }
  return {
    gold: gold.map((row) => row.receipt),
    parity: parity.map((row) => row.receipt),
    expectations,
    policy,
    tolerance,
    allowList,
    blocked,
    bindings: {
      script: CODE_FILES.map((file) => bound(root, file)),
      receipts: gold.map(({ path: file, sha256: digest }) => ({
        path: file,
        sha256: digest,
      })),
      parityReceipts: parity.map(({ path: file, sha256: digest }) => ({
        path: file,
        sha256: digest,
      })),
      // The file name only: the copy sits next to the verdict file, and a
      // checkout-local absolute path would not survive a deleted worktree.
      allowList: {
        path: path.basename(allowListPath),
        sha256: sha256(allowBytes),
      },
      ledger: ledgerBinding,
      procedure: { path: PROCEDURE_FILE, sha256: procedureDigest },
      manifests: [bound(root, GRAPH_MANIFEST), bound(root, RETRIEVAL_MANIFEST)],
      fixtures: fixtureFiles,
      k62: toleranceSource,
    },
  };
}

export function buildQualityVerdict(options) {
  const inputs = loadQualityInputs(options);
  const { bindings, ...rest } = inputs;
  const verdict = evaluateQualityVerdict(rest);
  return { ...verdict, bindings };
}

/** Recomputes every bound file's sha256; returns the mismatches. */
export function verifyBindings(
  output,
  { root = DEFAULT_ROOT, allowListDir = null, procedureRoot = root } = {},
) {
  if (output?.schema !== QUALITY_VERDICT_SCHEMA)
    throw precheck("not a quality verdict file");
  const mismatches = [];
  const check = (entry, base) => {
    if (!entry) return;
    const file = path.isAbsolute(entry.path)
      ? entry.path
      : path.join(base, entry.path);
    let digest = null;
    try {
      digest = sha256(readFileSync(file));
    } catch {
      /* a missing file is a mismatch */
    }
    if (digest !== entry.sha256) mismatches.push(entry.path);
  };
  const b = output.bindings ?? {};
  for (const entry of [
    ...(b.script ?? []),
    ...(b.receipts ?? []),
    ...(b.parityReceipts ?? []),
    b.ledger,
    ...(b.manifests ?? []),
    ...(b.fixtures ?? []),
    b.k62,
  ])
    check(entry, root);
  check(b.procedure, procedureRoot);
  // The allow list is bound by file name: it is read next to the verdict file.
  check(b.allowList, allowListDir ?? root);
  return mismatches;
}

const SYMBOL = {
  pass: "pass",
  fail: "fail",
  hold: "hold",
  "not-evaluable": "not-evaluable",
  "n/a": "n/a",
};

function fixed(value, digits = 4) {
  return typeof value === "number" ? value.toFixed(digits) : "-";
}

/** A Japanese Markdown summary of the verdict. */
export function renderSummary(output) {
  const c = output.conditions;
  const v = output.verdict;
  const lines = [];
  lines.push("# CP-4 品質の判定（手順外の補助の記録）");
  lines.push("");
  lines.push(
    "> この記録は CP-4 の正式の判定（DR-CP4-S6-3 の HOLD）ではなく、それを置き換えない。",
  );
  lines.push("");
  lines.push(
    `対象：S4 \`${output.allowList.s4Commit.slice(0, 8)}\`、候補 \`${output.allowList.candidate.slice(0, 8)}\`。受領書は書き換えていない。`,
  );
  lines.push("");
  lines.push(`**全体：${v.verdict}（${v.reasons.join("、") || "なし"}）**`);
  lines.push("");
  lines.push("## 条件（集計）");
  lines.push("");
  lines.push("| 条件 | 状態 | 根拠 |");
  lines.push("|---|---|---|");
  const g01 = c["g01-predeclared-improvement"];
  lines.push(
    `| G-01 の事前指定改善 | ${SYMBOL[g01.status]} | R+IR recall ${fixed(g01.rPlusIr?.recallAt8)} / nDCG ${fixed(g01.rPlusIr?.ndcgAt8, 5)} → Graph recall ${fixed(g01.graph?.recallAt8)} / nDCG ${fixed(g01.graph?.ndcgAt8, 5)}、事前指定と一致：${g01.matchesPredeclared ?? "-"} |`,
  );
  const gc = c["macro-non-regression"].components["g-case"];
  lines.push(
    `| macro 非回帰 | ${SYMBOL[c["macro-non-regression"].status]} | G-case ${gc.variants} variant：${SYMBOL[gc.status]}（recall ${fixed(gc.recallAt8?.rPlusIr)} → ${fixed(gc.recallAt8?.graph)}、nDCG ${fixed(gc.ndcgAt8?.rPlusIr, 5)} → ${fixed(gc.ndcgAt8?.graph, 5)}）。既存 24 件の Graph arm：not-evaluable |`,
  );
  const p = c["hybrid-p95"];
  lines.push(
    `| Hybrid p95 ≤ ${p.limitMs} ms | ${SYMBOL[p.status]} | R+IR arm ${fixed(p.hybridArm.p95Ms, 2)} ms（n=${p.hybridArm.n}）、Graph arm ${fixed(p.graphArm.p95Ms, 2)} ms（n=${p.graphArm.n}）。G-case の母集団で、P の 24 query ではない |`,
  );
  const e = c["evidence-validity"].components["edge-binding"];
  lines.push(
    `| Evidence 100％ | ${SYMBOL[c["evidence-validity"].status]} | edge の束縛だけ：${SYMBOL[e.status]}（${e.variants} variant、検査 ${e.checked} sample、検査できず ${e.skipped}）。残りは not-evaluable |`,
  );
  const fa = c["forbidden-contribution"].components;
  lines.push(
    `| 禁止寄与 0 | ${SYMBOL[c["forbidden-contribution"].status]} | (a) 禁止 Scene・blocked 候補：${SYMBOL[fa["a-forbidden-scene-or-blocked-candidate"].status]}（違反 ${fa["a-forbidden-scene-or-blocked-candidate"].violatingSamples} sample）、(b) 遅れた Graph：${SYMBOL[fa["b-late-graph-in-display"].status]}（違反 ${fa["b-late-graph-in-display"].violatingSamples} sample）。(c) は not-evaluable |`,
  );
  lines.push("");
  lines.push("## variant ごと");
  lines.push("");
  lines.push(
    "| variant | 改善 | macro（Δrecall／ΔnDCG） | edge の束縛 | 禁止 (a) | 禁止 (b) | 表示（first／follow／なし） | p95 ms R+IR／Graph（開示） |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of output.variants) {
    if (row.blocked) {
      lines.push(`| ${row.variantKey} | ${row.blocked} | | | | | | |`);
      continue;
    }
    const k = row.conditions;
    const fp = k["forbidden-contribution"].components;
    const d = row.displayed;
    lines.push(
      `| ${row.variantKey} | ${SYMBOL[k["g01-predeclared-improvement"].status]} | ${SYMBOL[k["macro-non-regression"].status]}（${fixed(k["macro-non-regression"].deltaRecallAt8, 3)}／${fixed(k["macro-non-regression"].deltaNdcgAt8, 3)}） | ${SYMBOL[row.edgeBinding.status]} | ${SYMBOL[fp?.["a-forbidden-scene-or-blocked-candidate"]?.status ?? "hold"]} | ${SYMBOL[fp?.["b-late-graph-in-display"]?.status ?? "hold"]} | ${d ? `${d.firstRender}／${d.followUp}／${d.notDisplayed}` : "-"} | ${row.latency ? `${fixed(row.latency.hybrid.p95Ms, 1)}／${fixed(row.latency.graph.p95Ms, 1)}` : "-"} |`,
    );
  }
  lines.push("");
  lines.push("## not-evaluable の一覧");
  lines.push("");
  for (const item of output.notEvaluable)
    lines.push(`- ${item.condition} / ${item.component}：${item.reason ?? ""}`);
  lines.push("");
  lines.push(
    `blocked の判定：${output.blockedDetermination}。p95 の上限は手順のファイル v2 の B と上限（K6/5。B=${output.policy.b}、D=${output.policy.d}。B は D から逆算しない）の ${output.policy.limit} ms、百分位 ${output.policy.percentile}、許容誤差 ${output.policy.metricTolerance}。`,
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const { values } = parseArgs({
    options: {
      "gold-dir": { type: "string" },
      "parity-dir": { type: "string" },
      "allow-list": { type: "string" },
      ledger: { type: "string" },
      out: { type: "string" },
      summary: { type: "string" },
      verify: { type: "string" },
      root: { type: "string" },
    },
  });
  const root = values.root ?? DEFAULT_ROOT;
  if (values.verify) {
    const mismatches = verifyBindings(readJson(values.verify), {
      root,
      allowListDir: path.dirname(path.resolve(values.verify)),
    });
    if (mismatches.length > 0) {
      console.error(`[precheck] bound files changed: ${mismatches.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("bindings match");
    return;
  }
  if (!values["gold-dir"] || !values["allow-list"] || !values.out)
    throw precheck("--gold-dir, --allow-list and --out are required");
  const output = buildQualityVerdict({
    root,
    goldDir: values["gold-dir"],
    parityDir: values["parity-dir"] ?? null,
    allowListPath: values["allow-list"],
    ledgerPath: values.ledger ?? null,
  });
  writeFileSync(values.out, `${JSON.stringify(output, null, 2)}\n`);
  if (values.summary) writeFileSync(values.summary, renderSummary(output));
  console.log(
    `${output.verdict.verdict}: ${output.verdict.reasons.join(", ")}`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
)
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
