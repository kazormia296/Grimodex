// CP-4 S1i: ① R5 の照合の run の入口（S2 observation-prep の stepOrder.phases の
// `r5-seed-pin-check`、r5Gate.exempt の行、r5CheckRecordRule）。
//
// 13 の variant のそれぞれについて、新しい workspace に凍結した setup を seed の
// pin の段と SP-P2 の記録まで作り（frozen-setup-driver.mjs の部分実行）、setup の
// 受領書を封印して読み、その variant の cold DB から問いの Scene の pin を読み
// 直して、`assertSeedPinsBeforeK64({ plan: "frozen" })` と SP-P1 を当て、
// r5CheckRecord を書く。Graph の arm、R／IR の query、評価の run、診断、trace、
// V-10 の probe、maintenance の有効化、setupTimeline、typed Revision、B と
// Chronicle の Index の build、Index の状態の記録は起動しない（S2 の禁止の集合。
// frozen-setup-plan.mjs の R5_CHECK_FORBIDS）。launch は §15.8 の dry run の
// admission（製品の `.node`、Graph は起動しない）だけを受ける。① の workspace は
// 捨て、④⑤ に使わない（setup-receipt.mjs の assertCompleteSetupReceipt）。
//
// 凍結した材料で走らせるのは integrator（S4 の前の ①）。この lane は走らせない。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/r5-check-runner.mjs --run <name> \
//     --product-receipt <standard-build receipt> --ja-model <pinned> --en-model <pinned>

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import {
  frozenSetupFixturePins,
  prepareFrozenSetupShared,
  setupFrozenVariant,
} from "./frozen-setup-driver.mjs";
import {
  R5_CHECK_FORBIDS,
  R5_CHECK_RUN,
  R5_CHECK_SCOPE,
  SETUP_STOPS,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { isFrozenDryRunAdmission } from "./admission.mjs";
import { ROOT } from "./launcher.mjs";
import { SP1_CONTRACT, assessSeedPinStep } from "./seed-pin-setup.mjs";
import { assertSeedPinsBeforeK64, verifySeedPins } from "./seed-pin.mjs";
import { SETUP_STATUS_BY_STOP, loadSetupReceipt } from "./setup-receipt.mjs";
import { readQuerySceneSeedPins } from "./workspace-db.mjs";

export const R5_CHECK_RECORD_SCHEMA = "nir1-cp4-r5-check-record/1";

function fail(detail) {
  throw new Error(`[precheck] S1i r5-check: ${detail}`);
}

/** ① takes the 13 catalog variants, each planned to stop at the seed pin step. */
function assertR5CheckPlans(plans) {
  const keys = (plans ?? []).map((plan) => plan?.variantKey);
  if (
    keys.length !== GRAPH_EVAL_VARIANTS.length ||
    JSON.stringify(keys) !==
      JSON.stringify(GRAPH_EVAL_VARIANTS.map((row) => row.key))
  )
    fail(
      "the run needs the plans of the 13 catalog variants, in catalog order",
    );
  for (const plan of plans)
    if (plan.stopsAt !== SETUP_STOPS.seedPin || plan.run !== R5_CHECK_RUN)
      fail(`${plan.variantKey} is not planned to stop at the seed pin step`);
}

const sha256File = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** One variant's row of the record (no Index, B seal or IR state). */
function variantRow({ plan, receipt, receiptPath, root }) {
  const base = {
    caseId: plan.caseId,
    variantId: plan.variantId,
    variantKey: plan.variantKey,
    receipt: {
      path: path.relative(root, receiptPath),
      sha256: sha256File(receiptPath),
    },
    setupStatus: receipt.status,
    phases: (receipt.phases ?? []).map((row) => row.name),
  };
  if (receipt.status !== SETUP_STATUS_BY_STOP[SETUP_STOPS.seedPin])
    return {
      ...base,
      error: String(
        receipt.precheck?.message ?? receipt.errors?.[0] ?? receipt.status,
      ).split("\n")[0],
    };
  const setup = loadSetupReceipt({ root, file: receiptPath });
  if (
    setup.caseId !== plan.caseId ||
    setup.variantId !== plan.variantId ||
    setup.stopsAt !== SETUP_STOPS.seedPin
  )
    return {
      ...base,
      error: `the setup receipt is of ${setup.caseId}/${setup.variantId} (${setup.stopsAt}), not this variant's R5 check setup`,
    };
  const queryRuntime = setup.scenes[plan.querySceneId] ?? null;
  const seedRuntime = setup.entities[plan.seedPin.seedEntityId] ?? null;
  const read = readQuerySceneSeedPins(
    setup.coldDatabase.path,
    setup.projectId,
    queryRuntime,
  );
  const [spP1] = verifySeedPins([
    {
      caseId: plan.caseId,
      variantId: plan.variantId,
      querySceneId: queryRuntime,
      expectedSeed: seedRuntime,
      expectedSeedLogical: plan.seedPin.seedEntityId,
      entityRuntimeIds: setup.entities,
      read,
    },
  ]).rows;
  const fixturePins = frozenSetupFixturePins(plan, receipt.logicalToRuntime);
  const spP2 = assessSeedPinStep(receipt.seedPinStep, { fixturePins });
  return {
    row: {
      ...base,
      querySceneId: { logical: plan.querySceneId, runtime: queryRuntime },
      seed: { logical: plan.seedPin.seedEntityId, runtime: seedRuntime },
      projectId: setup.projectId,
      db: {
        path: path.relative(root, read.source.db.path),
        sha256: read.source.db.sha256,
      },
      sceneLive: read.sceneLive,
      pins: read.pins.map((pin) => ({ ...pin })),
      spP1: {
        status: spP1.status,
        productSeed: spP1.productSeed,
        pinCount: spP1.pinCount,
      },
      spP2,
      seedPinStep: {
        createdAt: receipt.seedPinStep?.createdAt ?? null,
        before: receipt.seedPinStep?.before ?? null,
        after: receipt.seedPinStep?.after ?? null,
      },
      logicalRuntimeCheck: receipt.readBack?.logicalRuntimeCheck ?? null,
    },
    gateCase: { caseId: plan.caseId, variantId: plan.variantId, setup, read },
  };
}

/**
 * S1j P2-1: the session evidence a variant's setup left that stops ① (an
 * egress, D-Bus, X11, process or start problem of any session, or no session
 * evidence at all: the launch itself failed). The remaining variants are not
 * launched (TASK §15.1: a new receiver is `[precheck]`).
 */
function isolationStop(plan, receipt) {
  const sessions = Array.isArray(receipt?.sessions) ? receipt.sessions : [];
  const problems = sessions.flatMap((row) =>
    Array.isArray(row?.problems) ? row.problems.map(String) : [],
  );
  if (sessions.length === 0)
    return {
      variantKey: plan.variantKey,
      setupStatus: receipt?.status ?? null,
      problems: [
        `no session evidence (the launch did not complete): ${String(receipt?.errors?.[0] ?? "").split("\n")[0]}`,
      ],
    };
  return problems.length > 0
    ? { variantKey: plan.variantKey, setupStatus: receipt.status, problems }
    : null;
}

/**
 * ① for the 13 variants: the partial setups, the sealed receipts, the reads
 * of each cold DB, the R5 gate and the record (written as
 * `<runDir>/r5-check-record.json`). `deps.setupVariant` replaces the driver
 * (tests). Never starts a Graph arm, a query, a diagnostic or a trace. A
 * variant whose sessions left an isolation problem stops the run: the
 * remaining variants are not launched and the record is `precheck`.
 */
export async function runR5Check({
  root = ROOT,
  runDir,
  plans,
  shared,
  deps = {},
}) {
  const {
    setupVariant = setupFrozenVariant,
    now = () => new Date().toISOString(),
    runId = randomUUID(),
  } = deps;
  assertR5CheckPlans(plans);
  // S1j P3: the admission admitFrozenDryRun returned, for these fixtures.
  const admitted = new Set(
    (shared?.admission?.fixtures ?? []).map((row) => row.path),
  );
  if (
    !isFrozenDryRunAdmission(shared?.admission) ||
    !plans.every((plan) => admitted.has(plan.fixturePath))
  )
    fail(
      "the launch admission is not the §15.8 dry run of these fixtures (admitFrozenDryRun: the product .node, Graph not activated)",
    );
  const runShared = { ...shared, r5CheckRunId: runId };
  const startedAt = now();
  const variants = [];
  const cases = [];
  let stop = null;
  for (const plan of plans) {
    const setupDir = path.join(runDir, "setup", plan.caseId, plan.variantId);
    const { receipt, receiptPath } = await setupVariant({
      plan,
      setupDir,
      shared: runShared,
    });
    stop = isolationStop(plan, receipt);
    if (stop) {
      variants.push({
        caseId: plan.caseId,
        variantId: plan.variantId,
        variantKey: plan.variantKey,
        setupStatus: receipt.status,
        error: `isolation: ${stop.problems.join("; ")}`.slice(0, 2000),
      });
      break;
    }
    try {
      const result = variantRow({ plan, receipt, receiptPath, root });
      if (result.row) {
        variants.push(result.row);
        cases.push(result.gateCase);
      } else variants.push(result);
    } catch (error) {
      variants.push({
        caseId: plan.caseId,
        variantId: plan.variantId,
        variantKey: plan.variantKey,
        setupStatus: receipt.status,
        error: String(error?.message ?? error).split("\n")[0],
      });
    }
  }
  let gate;
  try {
    const result = assertSeedPinsBeforeK64({
      cases,
      plan: "frozen",
      seedPlan: plans.map((plan) => plan.seedPin),
      stage: "r5-check",
    });
    gate = {
      status: result.status,
      rows: result.rows.map((row) => ({
        caseId: row.caseId,
        variantId: row.variantId,
        status: row.status,
        productSeed: row.productSeed,
        expectedSeed: row.expectedSeed,
        setupReceiptSha256: row.setupReceiptSha256,
        db: path.relative(root, row.db),
      })),
    };
  } catch (error) {
    gate = { status: "precheck", message: String(error?.message ?? error) };
  }
  const allRows =
    variants.length === plans.length &&
    variants.every(
      (row) => row.spP1?.status === "match" && row.spP2?.ok === true,
    );
  const started = new Set(variants.map((row) => row.variantKey));
  const record = {
    schema: R5_CHECK_RECORD_SCHEMA,
    run: R5_CHECK_RUN,
    runId,
    status: stop
      ? "precheck"
      : gate.status === "match" && allRows
        ? "match"
        : "mismatch",
    contracts: { sp1: { ...SP1_CONTRACT } },
    candidate: shared.candidate ?? null,
    launch: shared.launch ?? null,
    scope: [...R5_CHECK_SCOPE],
    notStarted: [...R5_CHECK_FORBIDS],
    workspace: {
      disposition: "discard",
      reuseFor: [],
      recheckInLaterPhases: ["sp-p1", "sp-p3-r5"],
      // S1j P2-3: the receipts and cold DBs stay until the ② record that
      // binds this record is pushed (verifyR5CheckRecord reads them).
      retainUntil: "k64-freeze-record-pushed",
    },
    startedAt,
    finishedAt: now(),
    ...(stop
      ? {
          stop,
          notStartedVariants: plans
            .map((plan) => plan.variantKey)
            .filter((key) => !started.has(key)),
        }
      : {}),
    gate,
    variants,
  };
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "r5-check-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const stableJson = (value) => JSON.stringify(value ?? null);

/** Records verifyR5CheckRecord recomputed (S1j P2-3). */
const VERIFIED_RECORDS = new WeakSet();

export function isVerifiedR5CheckRecord(value) {
  return (
    value !== null && typeof value === "object" && VERIFIED_RECORDS.has(value)
  );
}

/**
 * S1j P2-3: ①'s record, verified by recomputing it from its own sources:
 * each row's setup receipt (its bytes' sha256, sealed by loadSetupReceipt,
 * of this record's run), the variant's cold DB (read again, its sha256),
 * SP-P1 and SP-P2 recomputed, and the R5 gate recomputed over the 13 rows.
 * The record must say what the recomputation says, and that is `match`.
 * Returns the sealed verified record; `[precheck]` otherwise.
 */
export function verifyR5CheckRecord({ root = ROOT, file }) {
  const reject = (detail) => {
    throw new Error(`[precheck] S1i r5-check-record: ${detail}`);
  };
  const absolute = path.resolve(root, file);
  let bytes;
  let record;
  try {
    bytes = readFileSync(absolute);
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    reject(`${file} cannot be read`);
  }
  if (record?.schema !== R5_CHECK_RECORD_SCHEMA) reject("schema");
  if (record.run !== R5_CHECK_RUN) reject("run");
  if (typeof record.runId !== "string" || record.runId.length === 0)
    reject("runId");
  if (record.status !== "match")
    reject(`the record's status is ${String(record.status)}, not match`);
  if (stableJson(record.scope) !== stableJson(R5_CHECK_SCOPE))
    reject("scope is not S2's");
  if (stableJson(record.notStarted) !== stableJson(R5_CHECK_FORBIDS))
    reject("notStarted is not S2's forbidden set");
  if (stableJson(record.workspace?.reuseFor) !== stableJson([]))
    reject("the workspace is reused");
  const plans = loadFrozenSetupPlans({ root, stopsAt: SETUP_STOPS.seedPin });
  const rows = Array.isArray(record.variants) ? record.variants : [];
  if (
    stableJson(rows.map((row) => row?.variantKey)) !==
    stableJson(plans.map((plan) => plan.variantKey))
  )
    reject("the record does not hold the 13 variants in catalog order");
  const cases = [];
  const verified = [];
  plans.forEach((plan, at) => {
    const row = rows[at];
    const key = plan.variantKey;
    if (row.error !== undefined || !row.receipt || !row.spP1 || !row.spP2)
      reject(`${key}: the row has no complete result`);
    const receiptPath = path.resolve(root, row.receipt.path);
    let receiptBytes;
    try {
      receiptBytes = readFileSync(receiptPath);
    } catch {
      reject(`${key}: the setup receipt cannot be read`);
    }
    const receiptSha256 = createHash("sha256")
      .update(receiptBytes)
      .digest("hex");
    if (receiptSha256 !== row.receipt.sha256)
      reject(`${key}: the setup receipt's sha256 differs`);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const setup = loadSetupReceipt({ root, file: receiptPath });
    if (setup.r5CheckRunId !== record.runId)
      reject(
        `${key}: the setup receipt is of another run (${String(setup.r5CheckRunId)})`,
      );
    if (
      setup.caseId !== plan.caseId ||
      setup.variantId !== plan.variantId ||
      setup.stopsAt !== SETUP_STOPS.seedPin
    )
      reject(`${key}: the setup receipt is not this variant's R5 check setup`);
    const queryRuntime = setup.scenes[plan.querySceneId] ?? null;
    const seedRuntime = setup.entities[plan.seedPin.seedEntityId] ?? null;
    let read;
    try {
      read = readQuerySceneSeedPins(
        setup.coldDatabase.path,
        setup.projectId,
        queryRuntime,
      );
    } catch {
      reject(
        `${key}: the cold DB cannot be read (kept until the ② record is pushed)`,
      );
    }
    if (
      read.source.db.sha256 !== setup.coldDatabase.sha256 ||
      read.source.db.sha256 !== row.db?.sha256
    )
      reject(`${key}: the cold DB's sha256 differs`);
    const [spP1] = verifySeedPins([
      {
        caseId: plan.caseId,
        variantId: plan.variantId,
        querySceneId: queryRuntime,
        expectedSeed: seedRuntime,
        expectedSeedLogical: plan.seedPin.seedEntityId,
        entityRuntimeIds: setup.entities,
        read,
      },
    ]).rows;
    const spP2 = assessSeedPinStep(receipt.seedPinStep, {
      fixturePins: frozenSetupFixturePins(plan, receipt.logicalToRuntime),
    });
    if (spP1.status !== "match" || row.spP1.status !== spP1.status)
      reject(`${key}: SP-P1 recomputes as ${spP1.status}`);
    if (spP2.ok !== true || row.spP2.ok !== true)
      reject(`${key}: SP-P2 recomputes as ${spP2.findings.join(", ")}`);
    if (
      stableJson(row.pins) !== stableJson(read.pins) ||
      row.querySceneId?.runtime !== queryRuntime ||
      row.seed?.runtime !== seedRuntime
    )
      reject(`${key}: the pins or IDs are not the cold DB's`);
    cases.push({ caseId: plan.caseId, variantId: plan.variantId, setup, read });
    verified.push({
      variantKey: key,
      receiptSha256,
      coldDatabaseSha256: read.source.db.sha256,
      productSeed: spP1.productSeed,
    });
  });
  try {
    assertSeedPinsBeforeK64({
      cases,
      plan: "frozen",
      seedPlan: plans.map((plan) => plan.seedPin),
      stage: "r5-check",
    });
  } catch (error) {
    reject(`the R5 gate recomputes as ${String(error?.message ?? error)}`);
  }
  if (record.gate?.status !== "match") reject("the record's gate is not match");
  const sealed = deepFreeze({
    path: absolute,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    runId: record.runId,
    status: "match",
    candidate: record.candidate ?? null,
    rows: verified,
  });
  VERIFIED_RECORDS.add(sealed);
  return sealed;
}

/**
 * S1j P2-3: the entry ② (the K6/4 freeze commit) takes ①'s record through:
 * a record verifyR5CheckRecord recomputed as `match`, nothing else.
 */
export function assertR5CheckRecordForK64Freeze({ root = ROOT, file }) {
  const verified = verifyR5CheckRecord({ root, file });
  if (!isVerifiedR5CheckRecord(verified) || verified.status !== "match")
    throw new Error("[precheck] S1i r5-check-record: not a verified match");
  return verified;
}

function parseArgs(argv) {
  const options = {};
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["product-receipt", "ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  for (const name of Object.keys(options))
    if (
      ![
        "run",
        "product-receipt",
        "ja-model",
        "en-model",
        "native",
        "tmp",
      ].includes(name)
    )
      throw new Error(`[precheck] unsupported option --${name}`);
  return options;
}

async function main() {
  // S1j P2-3: `--verify <record>` recomputes ①'s record (before ②).
  if (process.argv[2] === "--verify") {
    if (process.argv.length !== 4)
      throw new Error(
        "usage: r5-check-runner.mjs --verify <r5-check-record.json>",
      );
    const verified = assertR5CheckRecordForK64Freeze({
      root: ROOT,
      file: process.argv[3],
    });
    process.stdout.write(
      `${JSON.stringify({ verified: true, sha256: verified.sha256, runId: verified.runId, candidate: verified.candidate })}\n`,
    );
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  const plans = loadFrozenSetupPlans({
    root: ROOT,
    stopsAt: SETUP_STOPS.seedPin,
  });
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  // A fresh run directory: ① never reuses a workspace of an earlier run.
  await mkdir(path.dirname(runDir), { recursive: true });
  await mkdir(runDir, { recursive: false });
  const shared = await prepareFrozenSetupShared({ runDir, options, plans });
  try {
    const record = await runR5Check({ root: ROOT, runDir, plans, shared });
    process.stdout.write(
      `${JSON.stringify({
        status: record.status,
        gate: record.gate.status,
        record: path.relative(ROOT, path.join(runDir, "r5-check-record.json")),
        variants: record.variants.map(
          (row) => `${row.variantKey}:${row.spP1?.status ?? row.setupStatus}`,
        ),
      })}\n`,
    );
    if (record.status !== "match") process.exitCode = 1;
  } finally {
    await shared.server?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
