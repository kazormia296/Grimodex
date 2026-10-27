// DR-CP4-O-1 (3): SP-P4 の setup の分岐（S2 `branch: single-pre-step-copy`）。
// fake の製品の page（一時の SQLite）と凍結した fixture から導いた plan だけで、
// seed の pin の段の直前の写しから 2 つの側を作ることを確かめる。凍結した材料で
// 実 Electron を起動せず、setup も実行しない（fixture は fs で読むだけ）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  SP_P4_BRANCH,
  branchCarryOf,
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

function product(plan) {
  return frozenSetupFakeProduct({
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

function sessions(fake) {
  const started = [];
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
          return { label, problems: [] };
        },
      };
    },
  };
}

async function run(plan, setupDir, branch) {
  const fake = product(plan);
  const started = sessions(fake);
  const result = await setupFrozenVariant({
    plan,
    setupDir,
    shared: SHARED,
    branch,
    deps: {
      startSession: started.startSession,
      uuid,
      sleep: async () => {},
      limits: { bSealMs: 50, maintenanceMs: 50 },
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
