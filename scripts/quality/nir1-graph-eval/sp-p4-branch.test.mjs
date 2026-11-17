// DR-CP4-O-1 (3): SP-P4 の setup の分岐（S2 `branch: single-pre-step-copy`）。
// fake の製品の page（一時の SQLite）と凍結した fixture から導いた plan だけで、
// seed の pin の段の直前の写しから 2 つの側を作ることを確かめる。凍結した材料で
// 実 Electron を起動せず、setup も実行しない（fixture は fs で読むだけ）。
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  SP_P4_BRANCH,
  branchCarryOf,
  assertPreStepClosedWithoutShm,
  observeClosedWorkspaceFiles,
  seedPinStepIndex,
  setupFrozenVariant,
  setupIrRowsOfPlans,
} from "./frozen-setup-driver.mjs";
import { SETUP_STOPS, loadFrozenSetupPlans } from "./frozen-setup-plan.mjs";
import { SP_P4 } from "./frozen-diagnostics.mjs";
import { SEED_PIN_PHASE } from "./seed-pin-setup.mjs";
import { loadSetupReceipt } from "./setup-receipt.mjs";
import {
  REPO_ROOT,
  completeSetupExtension,
  frozenSetupFakeProduct,
} from "./test-support.mjs";

const COMPLETE = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.complete,
});
const PARTIAL = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.seedPin,
});
const planOf = (plans, key) => plans.find((plan) => plan.variantKey === key);

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let counter = 0;
const uuid = () => `rt-${String(++counter).padStart(6, "0")}`;
const SEAM_ENV = "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
const SHARED = Object.freeze({
  root: REPO_ROOT,
  server: null,
  observer: null,
  nativePath: "/nonexistent/grimodex-node.node",
  models: { ja: "ja", en: "en" },
  admission: null,
  tmpRoot: null,
  candidate: { commit: "a".repeat(40), tree: "b".repeat(40), clean: true },
  launch: { native: "product", nativeSha256: "c".repeat(64) },
  setupMain: Object.freeze({
    setupMain: {
      path: "dist-electron/main-setup-ir.cjs",
      sha256: "e".repeat(64),
    },
    table: { path: "t", sha256: "f".repeat(64), rows: [] },
    productMain: { path: "dist-electron/main.cjs", sha256: "a".repeat(64) },
    reproducedProductMainSha256: "a".repeat(64),
    inputDiff: { removed: [], added: ["t"], inputs: 1 },
    env: { GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1" },
  }),
});

function product(plan, opts = {}) {
  return frozenSetupFakeProduct({
    ...opts,
    extend: completeSetupExtension({
      irSeeds: new Map(
        setupIrRowsOfPlans([plan]).map((row) => [
          row.body,
          row.interpretationSeed,
        ]),
      ),
    }),
  });
}

// `onStop(label, n)` runs after the fake product closed its DB (the n-th stop
// of the label); `stopEvidence(label, n)` is the launcher's `stop` evidence.
function sessions(fake, { onStop = null, stopEvidence = null } = {}) {
  const started = [];
  const stops = new Map();
  return {
    started,
    startSession: async ({ label, extraEnv, setupMain }) => {
      const seam = Object.hasOwn(extraEnv ?? {}, SEAM_ENV);
      started.push(label);
      fake.extension.beginSession({ label, seam, setupMain });
      return {
        page: fake.page,
        userData: "/nonexistent",
        evidence: { label, problems: [] },
        stop: async () => {
          fake.close();
          const n = (stops.get(label) ?? 0) + 1;
          stops.set(label, n);
          onStop?.(label, n);
          return { label, problems: [], ...(stopEvidence?.(label, n) ?? {}) };
        },
      };
    },
  };
}

async function run(
  plan,
  setupDir,
  branch,
  { wal = false, limits = {}, ...hooks } = {},
) {
  const fake = product(plan, { wal });
  const started = sessions(fake, hooks);
  const result = await setupFrozenVariant({
    plan,
    setupDir,
    shared: SHARED,
    branch,
    deps: {
      startSession: started.startSession,
      uuid,
      sleep: async () => {},
      limits: { bSealMs: 50, maintenanceMs: 50, ...limits },
    },
  });
  return { ...result, started: started.started, fake };
}

const sha = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

function pinsOf(file, projectId) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT p.scene_id AS sceneId, p.entry_id AS entryId FROM scene_codex_pins p JOIN tree_nodes t ON t.id = p.scene_id WHERE t.project_id = ? ORDER BY p.scene_id, p.entry_id",
      )
      .all(projectId)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

async function branchOf(key) {
  const plan = planOf(COMPLETE, key);
  const dir = scratch("cp4-sp-p4-");
  const pre = await run(plan, path.join(dir, "pre-step"), {
    stage: SP_P4_BRANCH.preStep,
  });
  const sides = {};
  for (const side of SP_P4_BRANCH.sides)
    sides[side] = await run(plan, path.join(dir, side), {
      stage: SP_P4_BRANCH.side,
      side,
      carry: pre.branch.carry,
      preStepDb: pre.branch.preStepDb,
    });
  return { plan, pre, sides };
}

test("O-1 (3): SP-P4 の 8 variant で、seed の pin の段の直前の写しから 2 つの側を作り、段は片側だけで行い、どちらも測定点まで進む", async () => {
  for (const key of SP_P4.variants) {
    const { plan, pre, sides } = await branchOf(key);
    const seedIndex = seedPinStepIndex(plan);
    // pre-step: author の session だけ、段の直前まで（① と同じ並び）。
    assert.equal(
      pre.receipt.status,
      "sp-p4-pre-step",
      pre.receipt.errors.join("\n"),
    );
    assert.deepEqual(pre.started, ["author"]);
    const partial = planOf(PARTIAL, key);
    assert.deepEqual(
      pre.receipt.phases.map((row) => row.name),
      partial.steps.slice(0, seedIndex).map((row) => row.phase),
      key,
    );
    assert.ok(!pre.receipt.phases.some((row) => row.name === SEED_PIN_PHASE));
    assert.equal(pre.branch.preStepDb.sha256, sha(pre.branch.preStepDb.path));
    assert.equal(pre.branch.carry.seedPinIndex, seedIndex);
    // 写しは seed の pin を持たない（fixture の pin だけ）。
    const projectId = pre.receipt.logicalToRuntime.projectId;
    const fixturePins = pinsOf(pre.branch.preStepDb.path, projectId);
    for (const [side, result] of Object.entries(sides)) {
      const { receipt } = result;
      assert.equal(
        receipt.status,
        "sp-p4-branch-complete",
        `${key}/${side}: ${receipt.errors.join("\n")}`,
      );
      assert.equal(receipt.seedPinBranch.side, side);
      assert.equal(
        receipt.seedPinBranch.preStepDb.sha256,
        pre.branch.preStepDb.sha256,
      );
      // 同じ論理→runtime の対応（段より前に作った行）。
      assert.equal(receipt.logicalToRuntime.projectId, projectId);
      assert.deepEqual(
        receipt.logicalToRuntime.scenes,
        pre.receipt.logicalToRuntime.scenes,
      );
      assert.ok(receipt.measurementPoint, `${key}/${side}: measurement point`);
      assert.equal(receipt.readBack.logicalRuntimeCheck.ok, true);
      const pins = pinsOf(
        path.resolve(REPO_ROOT, receipt.coldDatabase.path),
        projectId,
      );
      const seedPin = {
        sceneId: receipt.logicalToRuntime.scenes[plan.querySceneId],
        entryId:
          receipt.logicalToRuntime.entities[
            plan.steps[seedIndex].input.seedEntityId
          ],
      };
      const hasSeed = pins.some(
        (row) =>
          row.sceneId === seedPin.sceneId && row.entryId === seedPin.entryId,
      );
      if (side === "with-seed-pin-step") {
        assert.equal(hasSeed, true, key);
        assert.equal(receipt.seedPin.ok, true);
        assert.equal(receipt.seedPinBranch.resumedFrom, seedIndex);
        assert.ok(
          receipt.phases.some(
            (row) => row.name === SEED_PIN_PHASE && !row.preStep,
          ),
        );
      } else {
        assert.equal(hasSeed, false, key);
        assert.deepEqual(pins, fixturePins);
        assert.deepEqual(receipt.seedPin, { skipped: "without-seed-pin-step" });
        assert.equal(receipt.seedPinBranch.resumedFrom, seedIndex + 1);
        assert.ok(!receipt.phases.some((row) => row.name === SEED_PIN_PHASE));
      }
      // 分岐の受領書は ④⑤ の Graph arm の setup として読めない（fail closed）。
      assert.throws(
        () => loadSetupReceipt({ root: REPO_ROOT, file: result.receiptPath }),
        /\[precheck\]/u,
      );
    }
  }
});

test("O-1 (3): 分岐の入力の検査（① は分岐しない、側の欠け、写しの bytes の違い）", async () => {
  const plan = planOf(COMPLETE, "G-02/base");
  const dir = scratch("cp4-sp-p4-bad-");
  const pre = await run(plan, path.join(dir, "pre"), { stage: "pre-step" });
  const partialPlan = planOf(PARTIAL, "G-02/base");
  await assert.rejects(
    setupFrozenVariant({
      plan: partialPlan,
      setupDir: path.join(dir, "partial"),
      shared: { ...SHARED, r5CheckRunId: "r" },
      branch: { stage: "pre-step" },
    }),
    /\[precheck\].*sp-p4-branch/u,
  );
  await assert.rejects(
    setupFrozenVariant({
      plan,
      setupDir: path.join(dir, "bad-side"),
      shared: SHARED,
      branch: {
        stage: "side",
        side: "both",
        carry: pre.branch.carry,
        preStepDb: pre.branch.preStepDb,
      },
    }),
    /\[precheck\].*sp-p4-branch/u,
  );
  const wrong = await run(plan, path.join(dir, "wrong"), {
    stage: "side",
    side: "with-seed-pin-step",
    carry: pre.branch.carry,
    preStepDb: { path: pre.branch.preStepDb.path, sha256: "0".repeat(64) },
  });
  assert.equal(wrong.receipt.status, "blocked");
  assert.match(wrong.receipt.precheck.message, /pre-step DB copy differs/u);
  // 持ち越しは素のデータだけ。
  assert.throws(() => branchCarryOf({ cache: new Map() }), /\[artifact\]/u);
  assert.deepEqual(branchCarryOf({ page: {}, foreshadowVersions: { a: 1 } }), {
    foreshadowVersions: { a: 1 },
  });
});

// DR-CP4-S6-7: the closed workspace DB's files beside it.
const dbOf = (setupDir) => path.join(setupDir, "workspace", "grimodex.db");
const filesOf = (setupDir) =>
  readdirSync(path.join(setupDir, "workspace"))
    .filter((name) => name.startsWith("grimodex.db"))
    .sort();
/** The header's journal mode bytes (18, 19): 02 02 is WAL (read without SQLite). */
function journalBytes(file) {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(2);
    readSync(fd, header, 0, 2, 18);
    return header.toString("hex");
  } finally {
    closeSync(fd);
  }
}
const writeShm = (setupDir) =>
  writeFileSync(path.join(setupDir, "workspace", "grimodex.db-shm"), "shm");
const noFile = { exists: false, bytes: 0 };
const SIGNALLED = {
  stop: { closed: false, signalled: [{ pid: 1, signal: "SIGKILL" }] },
};

test("DR-CP4-S6-7（s9r1 の停止の回帰）: WAL mode の DB の pre-step は、harness の read-only の読みが -shm と空の -wal を残しても通り、stop 直後の観測と写しの sha256 を残す", async () => {
  const plan = planOf(COMPLETE, "G-02/base");
  const setupDir = path.join(scratch("cp4-sp-p4-wal-"), "pre");
  const { receipt, branch } = await run(
    plan,
    setupDir,
    { stage: SP_P4_BRANCH.preStep },
    { wal: true },
  );
  assert.equal(
    receipt.status,
    SP_P4_BRANCH.status["pre-step"],
    receipt.errors.join("\n"),
  );
  // The test made s9r1's condition (not an empty pass): the DB is WAL mode,
  // and the harness's own read-only reads left a -shm and an empty -wal.
  const live = dbOf(setupDir);
  assert.equal(journalBytes(live), "0202");
  assert.deepEqual(filesOf(setupDir), [
    "grimodex.db",
    "grimodex.db-shm",
    "grimodex.db-wal",
  ]);
  assert.equal(statSync(`${live}-wal`).size, 0);
  // What the stop left, observed before those reads: nothing.
  const closed = { walMode: true, wal: noFile, shm: noFile };
  assert.deepEqual(receipt.sessions.at(-1).closedFiles, closed);
  assert.deepEqual(receipt.seedPinBranch.closedFiles, closed);
  // The cold copy is the closed DB's main file (the reads wrote nothing).
  assert.equal(branch.preStepDb.sha256, sha(live));
  assert.equal(receipt.coldDatabase.sha256, sha(live));
});

test("DR-CP4-S6-7: 製品が閉じた後に -shm を残していれば（DELETE／WAL どちらの mode でも）、harness の読みの後でも止まり、観測を受領書に残す", async () => {
  for (const wal of [false, true]) {
    const plan = planOf(COMPLETE, "G-02/base");
    const setupDir = path.join(scratch("cp4-sp-p4-shm-"), "pre");
    const result = await run(
      plan,
      setupDir,
      { stage: SP_P4_BRANCH.preStep },
      { wal, onStop: () => writeShm(setupDir) },
    );
    assert.equal(result.receipt.status, "failed", `wal ${wal}`);
    assert.match(result.receipt.errors.join("\n"), /kept a SHM file/u);
    assert.equal(result.branch, undefined);
    const closed = result.receipt.seedPinBranch.closedFiles;
    assert.equal(closed.shm.exists, true);
    assert.equal(closed.shm.bytes, 3);
    assert.equal(closed.walMode, wal);
  }
});

test("DR-CP4-S6-7: 最後の close の観測が効く（signal で終えた session の -shm は、開き直しが正常に閉じれば消え、開き直しの close が残せば止まる）", async () => {
  const plan = planOf(COMPLETE, "G-02/base");
  const limits = { freshnessSettleMs: 30 };
  // The author session ends by SIGKILL and leaves a -shm; the quiesce
  // reopening closes cleanly (a clean close of the last connection removes it).
  const cleared = path.join(scratch("cp4-sp-p4-last-"), "pre");
  const first = await run(
    plan,
    cleared,
    { stage: SP_P4_BRANCH.preStep },
    {
      wal: true,
      limits,
      onStop: (label, n) => {
        if (label === "author" && n === 1) writeShm(cleared);
      },
      stopEvidence: (label, n) =>
        label === "author" && n === 1 ? SIGNALLED : {},
    },
  );
  assert.equal(
    first.receipt.status,
    SP_P4_BRANCH.status["pre-step"],
    first.receipt.errors.join("\n"),
  );
  assert.deepEqual(first.started, ["author", "quiesce-1"]);
  assert.equal(first.receipt.quiesce.reopens.length, 1);
  assert.equal(first.receipt.quiesce.reopens[0].beforeEndedByClose, false);
  const rows = first.receipt.sessions;
  assert.equal(rows[0].closedFiles.shm.exists, true, "the first stop's");
  assert.equal(rows.at(-1).closedFiles.shm.exists, false, "the last stop's");
  assert.equal(first.receipt.seedPinBranch.closedFiles.shm.exists, false);
  // The reverse: the reopening's close leaves it.
  const left = path.join(scratch("cp4-sp-p4-last-"), "pre");
  const second = await run(
    plan,
    left,
    { stage: SP_P4_BRANCH.preStep },
    {
      wal: true,
      limits,
      onStop: (label) => {
        if (label.startsWith("quiesce")) writeShm(left);
      },
      stopEvidence: (label, n) =>
        label === "author" && n === 1 ? SIGNALLED : {},
    },
  );
  assert.equal(second.receipt.status, "failed");
  assert.match(second.receipt.errors.join("\n"), /kept a SHM file/u);
  assert.equal(second.receipt.seedPinBranch.closedFiles.shm.exists, true);
});

test("DR-CP4-S6-7: 観測は pre-step の session だけが受領書に残す（完全な setup と 2 つの側の受領書の形は変わらず、-shm が残っても止まらない）", async () => {
  const plan = planOf(COMPLETE, "G-02/base");
  const dir = scratch("cp4-sp-p4-only-");
  const leave = (setupDir) => () => writeShm(setupDir);
  const complete = path.join(dir, "complete");
  const whole = await run(plan, complete, null, {
    wal: true,
    onStop: leave(complete),
  });
  assert.equal(
    whole.receipt.status,
    "setup-complete",
    whole.receipt.errors.join("\n"),
  );
  assert.ok(whole.receipt.sessions.length > 0);
  assert.ok(whole.receipt.sessions.every((row) => !("closedFiles" in row)));
  assert.equal(whole.receipt.seedPinBranch, undefined);
  const pre = path.join(dir, "pre");
  const preStep = await run(
    plan,
    pre,
    { stage: SP_P4_BRANCH.preStep },
    { wal: true },
  );
  assert.ok(preStep.receipt.sessions.every((row) => "closedFiles" in row));
  for (const side of SP_P4_BRANCH.sides) {
    const sideDir = path.join(dir, side);
    const result = await run(
      plan,
      sideDir,
      {
        stage: SP_P4_BRANCH.side,
        side,
        carry: preStep.branch.carry,
        preStepDb: preStep.branch.preStepDb,
      },
      { wal: true, onStop: leave(sideDir) },
    );
    assert.equal(
      result.receipt.status,
      "sp-p4-branch-complete",
      result.receipt.errors.join("\n"),
    );
    assert.ok(result.receipt.sessions.every((row) => !("closedFiles" in row)));
    assert.ok(!("closedFiles" in result.receipt.seedPinBranch));
  }
});

test("DR-CP4-S6-7: observeClosedWorkspaceFiles は stat と header の 20 byte だけを読み、何も作らない（SQLite の接続を開かない）", () => {
  const dir = scratch("cp4-sp-p4-observe-");
  const file = path.join(dir, "grimodex.db");
  // No DB at all: nothing exists, the header is unreadable (null).
  assert.deepEqual(observeClosedWorkspaceFiles(file), {
    walMode: null,
    wal: noFile,
    shm: noFile,
  });
  // A rollback-journal DB, then a WAL one, closed cleanly: no sidecars.
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (a)");
  db.close();
  assert.deepEqual(observeClosedWorkspaceFiles(file), {
    walMode: false,
    wal: noFile,
    shm: noFile,
  });
  const wal = new DatabaseSync(file);
  wal.exec("PRAGMA journal_mode=WAL");
  wal.exec("INSERT INTO t VALUES (1)");
  wal.close();
  assert.equal(journalBytes(file), "0202");
  const before = readdirSync(dir).sort();
  assert.deepEqual(observeClosedWorkspaceFiles(file), {
    walMode: true,
    wal: noFile,
    shm: noFile,
  });
  assert.deepEqual(readdirSync(dir).sort(), before);
  // What is there is reported with its size (the reads below make them).
  writeFileSync(`${file}-shm`, "shm");
  writeFileSync(`${file}-wal`, "");
  assert.deepEqual(observeClosedWorkspaceFiles(file), {
    walMode: true,
    wal: { exists: true, bytes: 0 },
    shm: { exists: true, bytes: 3 },
  });
  // A read-only connection to a closed WAL DB leaves a -shm: the effect the
  // observation is taken before.
  rmSync(`${file}-shm`);
  rmSync(`${file}-wal`);
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.prepare("SELECT count(*) AS n FROM t").get();
  reader.close();
  assert.equal(observeClosedWorkspaceFiles(file).shm.exists, true);
});

test("DR-CP4-S6-7: pre-step の SHM の検査は、観測が無ければ（想定外）止まり、-shm があれば止まり、無ければ通る（fail closed）", () => {
  assert.throws(
    () => assertPreStepClosedWithoutShm(null),
    /\[artifact\] .*no observation/u,
  );
  assert.throws(
    () => assertPreStepClosedWithoutShm(undefined),
    /\[artifact\] .*no observation/u,
  );
  assert.throws(
    () => assertPreStepClosedWithoutShm({ walMode: true }),
    /kept a SHM file/u,
  );
  assert.throws(
    () =>
      assertPreStepClosedWithoutShm({
        walMode: true,
        wal: noFile,
        shm: { exists: true, bytes: 32768 },
      }),
    /kept a SHM file/u,
  );
  assert.doesNotThrow(() =>
    assertPreStepClosedWithoutShm({ walMode: true, wal: noFile, shm: noFile }),
  );
});
