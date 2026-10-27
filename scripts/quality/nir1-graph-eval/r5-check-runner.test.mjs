// CP-4 S1i: ① R5 の照合の run の入口。fake の製品の page と一時の SQLite だけ。
// 凍結した材料で実 Electron を起動せず、setup も実行しない。
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setupFrozenVariant } from "./frozen-setup-driver.mjs";
import {
  R5_CHECK_FORBIDS,
  R5_CHECK_RUN,
  R5_CHECK_SCOPE,
  SETUP_STOPS,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { admitFrozenDryRun } from "./admission.mjs";
import {
  R5_CHECK_RECORD_SCHEMA,
  assertR5CheckRecordForK64Freeze,
  isVerifiedR5CheckRecord,
  runR5Check,
  verifyR5CheckRecord,
} from "./r5-check-runner.mjs";
import {
  REPO_ROOT,
  frozenSetupFakeProduct,
  productReceipt,
} from "./test-support.mjs";
import { PRODUCT_NATIVE_ARTIFACT } from "../nir1-retrieval/contract.mjs";

const PARTIAL = loadFrozenSetupPlans({
  root: REPO_ROOT,
  stopsAt: SETUP_STOPS.seedPin,
});

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let counter = 0;
const uuid = () => `r5-${String(++counter).padStart(6, "0")}`;

/** A sealed §15.8 dry-run admission (the product .node) of the given fixtures. */
const dryRun = (fixturePaths) =>
  admitFrozenDryRun({
    fixtures: fixturePaths.map((file) => ({ path: file })),
    nativeSha256: productReceipt().artifacts[PRODUCT_NATIVE_ARTIFACT],
    productReceipt: productReceipt(),
  });

const SHARED = Object.freeze({
  root: REPO_ROOT,
  nativePath: "/nonexistent/grimodex-node.node",
  models: { ja: "ja", en: "en" },
  admission: dryRun([...new Set(PARTIAL.map((plan) => plan.fixturePath))]),
  candidate: { commit: "d".repeat(40), tree: "e".repeat(40), clean: true },
  launch: { native: "product" },
});

/** The real driver over one fake product per variant; records the sessions. */
function fakeSetupVariant({
  mutatePlanKey = null,
  mutate = null,
  stopProblems = {},
  failLaunch = null,
} = {}) {
  const sessions = [];
  const setupVariant = (args) => {
    const product = frozenSetupFakeProduct(
      args.plan.variantKey === mutatePlanKey && mutate ? { mutate } : {},
    );
    return setupFrozenVariant({
      ...args,
      deps: {
        uuid,
        startSession: async ({ label, extraEnv }) => {
          sessions.push({
            variant: args.plan.variantKey,
            label,
            env: Object.keys(extraEnv ?? {}),
            runId: args.shared.r5CheckRunId,
          });
          if (failLaunch === args.plan.variantKey)
            throw new Error("Electron did not launch");
          return {
            page: product.page,
            evidence: { problems: [] },
            stop: async () => {
              product.close();
              return {
                label,
                problems: stopProblems[args.plan.variantKey] ?? [],
                forbidden: [...product.forbidden],
              };
            },
          };
        },
      },
    });
  };
  return { sessions, setupVariant };
}

function deepKeys(value, out = new Set()) {
  if (value !== null && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      deepKeys(inner, out);
    }
  return out;
}

test("① の runner: 13 の variant を seed の pin の段まで setup し、各 variant の cold DB を読み直して R5 を照合し、r5CheckRecord を書く", async () => {
  const runDir = scratch("cp4-s1i-r5-");
  const fake = fakeSetupVariant();
  const record = await runR5Check({
    root: REPO_ROOT,
    runDir,
    plans: PARTIAL,
    shared: SHARED,
    deps: { setupVariant: fake.setupVariant },
  });
  assert.equal(record.schema, R5_CHECK_RECORD_SCHEMA);
  assert.equal(record.run, R5_CHECK_RUN);
  assert.equal(record.status, "match");
  assert.equal(record.gate.status, "match");
  assert.deepEqual(record.scope, [...R5_CHECK_SCOPE]);
  assert.deepEqual(record.notStarted, [...R5_CHECK_FORBIDS]);
  assert.deepEqual(record.candidate, SHARED.candidate);
  assert.deepEqual(record.workspace, {
    disposition: "discard",
    reuseFor: [],
    recheckInLaterPhases: ["sp-p1", "sp-p3-r5"],
    retainUntil: "k64-freeze-record-pushed",
  });
  // 1 つの run の ID を全 variant の setup が持つ。
  assert.match(record.runId, /^[0-9a-f-]{36}$/u);
  assert.ok(fake.sessions.every((row) => row.runId === record.runId));
  assert.equal(record.variants.length, 13);
  for (const row of record.variants) {
    assert.equal(row.setupStatus, "setup-through-seed-pin", row.variantKey);
    assert.equal(row.spP1.status, "match");
    assert.equal(row.spP2.ok, true);
    assert.equal(row.pins.length, 1);
    assert.equal(row.pins[0].entryId, row.seed.runtime);
    assert.equal(row.phases.at(-1), "seed-pin");
    assert.ok(row.seedPinStep.before && row.seedPinStep.after);
  }
  // variant ごとに自分の cold DB（使い回しなし）。
  assert.equal(new Set(record.variants.map((row) => row.db.path)).size, 13);
  // ① は author の session だけで、B-ROUTE の seam を渡さない。製品の page の
  // 禁止の入口（maintenance、query、Index の build、宣言、probe）は 1 度も呼ばない。
  assert.equal(fake.sessions.length, 13);
  assert.ok(
    fake.sessions.every(
      (row) => row.label === "author" && row.env.length === 0,
    ),
  );
  // Index の状態、B の seal、IR を書かない。
  const keys = deepKeys(record);
  for (const key of ["metadata", "generation", "dirty", "seal", "chronicle"])
    assert.ok(!keys.has(key), key);
  const written = JSON.parse(
    readFileSync(path.join(runDir, "r5-check-record.json"), "utf8"),
  );
  assert.equal(written.status, "match");
  assert.equal(written.variants.length, 13);
});

test("① の runner: 1 つの variant の setup が止まれば record は match にならず、その variant の理由と残りの結果を残す", async () => {
  const runDir = scratch("cp4-s1i-r5-blocked-");
  const fake = fakeSetupVariant({
    mutatePlanKey: "G-04/base",
    mutate: (name, input) =>
      name === "api.createCodexEntry" && input.name === "Mott"
        ? { ...input, type: "location" }
        : input,
  });
  const record = await runR5Check({
    root: REPO_ROOT,
    runDir,
    plans: PARTIAL,
    shared: SHARED,
    deps: { setupVariant: fake.setupVariant },
  });
  assert.notEqual(record.status, "match");
  assert.equal(record.gate.status, "precheck");
  const g04 = record.variants.find((row) => row.variantKey === "G-04/base");
  assert.notEqual(g04.setupStatus, "setup-through-seed-pin");
  assert.match(g04.error, /\[precheck\]|failed/u);
  assert.equal(
    record.variants.filter((row) => row.spP1?.status === "match").length,
    12,
  );
});

test("① の runner: ① の plan（seed の pin で止める 13 variant）以外は受けない", async () => {
  const complete = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: SETUP_STOPS.complete,
  });
  for (const plans of [complete, PARTIAL.slice(1), [...PARTIAL, PARTIAL[0]]])
    await assert.rejects(
      runR5Check({
        root: REPO_ROOT,
        runDir: scratch("cp4-s1i-r5-plan-"),
        plans,
        shared: SHARED,
        deps: {
          setupVariant: () => {
            throw new Error("must not set up");
          },
        },
      }),
      /\[precheck\] S1i r5-check/u,
    );
  // dry run でない admission（Graph arm を起動しうる）では走らない。
  await assert.rejects(
    runR5Check({
      root: REPO_ROOT,
      runDir: scratch("cp4-s1i-r5-adm-"),
      plans: PARTIAL,
      shared: { ...SHARED, admission: { kind: "graph-case" } },
      deps: {
        setupVariant: () => {
          throw new Error("must not set up");
        },
      },
    }),
    /\[precheck\] S1i r5-check/u,
  );
});

test("① の runner: 同じ case の別の variant の受領書を返した行も、受領書の SP-P2 の記録が変わった行も、record を match にしない", async () => {
  const runDir = scratch("cp4-s1i-r5-swap-");
  const fake = fakeSetupVariant();
  const byKey = new Map();
  const record = await runR5Check({
    root: REPO_ROOT,
    runDir,
    plans: PARTIAL,
    shared: SHARED,
    deps: {
      setupVariant: async (args) => {
        const result = await fake.setupVariant(args);
        byKey.set(args.plan.variantKey, result);
        // G-08/graph-recovered に G-08/base-usable の受領書（と cold DB）を返す。
        return args.plan.variantKey === "G-08/graph-recovered"
          ? byKey.get("G-08/base-usable")
          : result;
      },
    },
  });
  const swapped = record.variants.find(
    (row) => row.variantKey === "G-08/graph-recovered",
  );
  assert.match(swapped.error, /G-08\/base-usable/u);
  assert.equal(record.gate.status, "precheck");
  assert.equal(record.status, "mismatch");
  // 受領書の SP-P2 の記録（段の後の問いの Scene の version）だけが変わった行:
  // R5 の照合（封印した受領書と DB の読み直し）は match でも record は mismatch。
  const tamper = fakeSetupVariant();
  const tampered = await runR5Check({
    root: REPO_ROOT,
    runDir: scratch("cp4-s1i-r5-sp-p2-"),
    plans: PARTIAL,
    shared: SHARED,
    deps: {
      setupVariant: async (args) => {
        const result = await tamper.setupVariant(args);
        if (args.plan.variantKey !== "G-05/base") return result;
        const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
        receipt.seedPinStep.after.queryScene.version += 1;
        writeFileSync(result.receiptPath, `${JSON.stringify(receipt)}\n`);
        return { receipt, receiptPath: result.receiptPath };
      },
    },
  });
  assert.equal(tampered.gate.status, "match");
  const g05 = tampered.variants.find((row) => row.variantKey === "G-05/base");
  assert.deepEqual(g05.spP2.findings, ["SP-P2:query-scene-changed"]);
  assert.equal(tampered.status, "mismatch");
});

test("① の runner: admission は dry run（dryRun true かつ Graph not-activated）の両方が要る", async () => {
  for (const admission of [
    { dryRun: false, graphArm: "not-activated" },
    { dryRun: true, graphArm: "activated" },
    // S1j P3: 値が同じでも admitFrozenDryRun が返したものでなければ受けない。
    { dryRun: true, graphArm: "not-activated" },
    // 13 の variant の fixture を覆わない admission も受けない。
    dryRun(["evals/nir1-graph/g02-directed-relation.v1.json"]),
    null,
  ])
    await assert.rejects(
      runR5Check({
        root: REPO_ROOT,
        runDir: scratch("cp4-s1i-r5-adm2-"),
        plans: PARTIAL,
        shared: { ...SHARED, admission },
        deps: {
          setupVariant: () => {
            throw new Error("must not set up");
          },
        },
      }),
      /\[precheck\] S1i r5-check: the launch admission/u,
    );
});

test("S1j P2-1: ある variant の session に隔離の problem（外部の socket、net log、D-Bus、X11、残った process）が出たら、残りの variant を起動せず record を precheck で書く", async () => {
  for (const [problems, failLaunch] of [
    [["sockets: G-OPEN:new-peer 203.0.113.9:443"], null],
    [["X11 entries present before changed or vanished: X1"], null],
    [["processes left: 1234"], null],
    [[], "G-02/base"],
  ]) {
    const runDir = scratch("cp4-s1j-r5-stop-");
    const fake = fakeSetupVariant({
      stopProblems: { "G-02/base": problems },
      failLaunch,
    });
    const record = await runR5Check({
      root: REPO_ROOT,
      runDir,
      plans: PARTIAL,
      shared: SHARED,
      deps: { setupVariant: fake.setupVariant },
    });
    assert.equal(record.status, "precheck");
    assert.equal(record.stop.variantKey, "G-02/base");
    assert.deepEqual(record.stop.problems.length > 0, true);
    // G-01 と G-02 の 2 つだけを起動し、残りの 11 は起動しない。
    assert.deepEqual(
      [...new Set(fake.sessions.map((row) => row.variant))],
      ["G-01/v1", "G-02/base"],
    );
    assert.deepEqual(
      record.notStartedVariants,
      PARTIAL.slice(2).map((plan) => plan.variantKey),
    );
    assert.equal(
      JSON.parse(
        readFileSync(path.join(runDir, "r5-check-record.json"), "utf8"),
      ).status,
      "precheck",
    );
    assert.throws(
      () =>
        verifyR5CheckRecord({
          root: REPO_ROOT,
          file: path.join(runDir, "r5-check-record.json"),
        }),
      /\[precheck\] S1i r5-check-record/u,
    );
  }
});

test("S1j P2-3: ① の記録は、受領書と cold DB から R5 を計算し直して一致するときだけ検証を通り、② はその検証した記録だけを受ける", async () => {
  const runDir = scratch("cp4-s1j-r5-verify-");
  const fake = fakeSetupVariant();
  const record = await runR5Check({
    root: REPO_ROOT,
    runDir,
    plans: PARTIAL,
    shared: SHARED,
    deps: { setupVariant: fake.setupVariant },
  });
  assert.equal(record.status, "match");
  const file = path.join(runDir, "r5-check-record.json");
  const verified = verifyR5CheckRecord({ root: REPO_ROOT, file });
  assert.equal(isVerifiedR5CheckRecord(verified), true);
  assert.equal(verified.runId, record.runId);
  assert.equal(verified.status, "match");
  assert.equal(verified.rows.length, 13);
  assert.equal(
    assertR5CheckRecordForK64Freeze({ root: REPO_ROOT, file }).sha256,
    verified.sha256,
  );
  assert.equal(isVerifiedR5CheckRecord({ ...verified }), false);
  const original = readFileSync(file, "utf8");
  const tamper = (change) => {
    const value = JSON.parse(original);
    change(value);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const g05 = (value) =>
    value.variants.find((row) => row.variantKey === "G-05/base");
  for (const [label, change] of [
    ["schema", (value) => (value.schema = "nir1-cp4-r5-check-record/0")],
    ["runId", (value) => (value.runId = "another-run")],
    ["the pins", (value) => (g05(value).pins = [])],
    ["SP-P1", (value) => (g05(value).spP1.status = "mismatch")],
    ["the receipt", (value) => (g05(value).receipt.sha256 = "0".repeat(64))],
    ["the cold DB", (value) => (g05(value).db.sha256 = "0".repeat(64))],
    [
      "an error row",
      (value) => {
        const row = g05(value);
        for (const key of Object.keys(row))
          if (!["caseId", "variantId", "variantKey", "receipt"].includes(key))
            delete row[key];
        row.error = "failed";
      },
    ],
    ["13 variants", (value) => value.variants.pop()],
    ["notStarted", (value) => value.notStarted.pop()],
  ]) {
    tamper(change);
    assert.throws(
      () => verifyR5CheckRecord({ root: REPO_ROOT, file }),
      /\[precheck\] S1i r5-check-record/u,
      label,
    );
  }
  writeFileSync(file, original);
  assert.equal(verifyR5CheckRecord({ root: REPO_ROOT, file }).status, "match");
  // 別の run の受領書（同じ case と variant）に差し替えた記録は通らない。
  const other = scratch("cp4-s1j-r5-other-");
  await runR5Check({
    root: REPO_ROOT,
    runDir: other,
    plans: PARTIAL,
    shared: SHARED,
    deps: { setupVariant: fakeSetupVariant().setupVariant },
  });
  const swapped = JSON.parse(original);
  const otherRecord = JSON.parse(
    readFileSync(path.join(other, "r5-check-record.json"), "utf8"),
  );
  const at = swapped.variants.findIndex(
    (row) => row.variantKey === "G-05/base",
  );
  swapped.variants[at] = otherRecord.variants[at];
  writeFileSync(file, `${JSON.stringify(swapped, null, 2)}\n`);
  assert.throws(
    () => verifyR5CheckRecord({ root: REPO_ROOT, file }),
    /\[precheck\] S1i r5-check-record.*G-05\/base.*run/u,
  );
  writeFileSync(file, original);
  // cold DB を消した（②の記録を push する前に捨てた）記録は検証できない。
  const cold = path.join(REPO_ROOT, g05(JSON.parse(original)).db.path);
  const kept = `${cold}.kept`;
  cpSync(cold, kept);
  rmSync(cold);
  assert.throws(
    () => verifyR5CheckRecord({ root: REPO_ROOT, file }),
    /\[precheck\]/u,
  );
  cpSync(kept, cold);
  assert.equal(verifyR5CheckRecord({ root: REPO_ROOT, file }).status, "match");
  // match でない記録（precheck）は ② に渡せない。
  tamper((value) => (value.status = "mismatch"));
  assert.throws(
    () => assertR5CheckRecordForK64Freeze({ root: REPO_ROOT, file }),
    /\[precheck\] S1i r5-check-record/u,
  );
});
