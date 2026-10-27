// CP-4 S5-A: 正式の run の測定の process の組み立て（DR-CP4-N-1〜N-3）を、
// 偽の session と page（node の試験。Electron を起動しない）と使い捨ての SQLite
// で確かめる: 宣言の段は seed つきの query（V-10 の READY probe）より前、one-shot
// の process は測る 1 回の query の前に query を出さない（C5）、測定の前と query
// の時点の d2 の不一致は blocked（表で判定）、宣言の段の前後の不変量の違いと
// 測定の写しの pin の違いは [precheck]。

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { variantByKey } from "./constants.mjs";
import { ONE_SHOT_RECEIPT_LABEL } from "./frozen-k64-plan.mjs";
import { measureVariant } from "./frozen-k64-run.mjs";
import { loadFrozenSetupPlans } from "./frozen-setup-plan.mjs";
import { INDEX_KEYS } from "./workspace-db.mjs";
import {
  K64_CACHED_CHILD,
  REPO_ROOT,
  formalProcedure,
  k64Diagnostics,
  k64NativeRecord,
  k64Observation,
} from "./test-support.mjs";

const PLANS = loadFrozenSetupPlans({ root: REPO_ROOT, stopsAt: "complete" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PROJECT = "rt-p";
const QUERY = "rt-query";
const SEED = "rt-seed";

function coldDb(dir, { b, chronicle, pins = [SEED] }) {
  const file = path.join(dir, "cold.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT, parent_id TEXT, sort_order TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
    CREATE TABLE narrative_semantic_index_metadata (project_id TEXT, index_key TEXT, generation INTEGER, dirty_cache_flag INTEGER, source_digest TEXT, dependency_set_digest TEXT, producer_id TEXT, producer_version TEXT);
    CREATE TABLE narrative_scope_registries (project_id TEXT, registry_version TEXT, timeline_refs_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT);
    CREATE TABLE narrative_scene_scope_bindings (project_id TEXT, scene_id TEXT, query_identity_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT);
  `);
  for (const [id, order] of [
    [QUERY, "b"],
    ["rt-added", "a"],
  ])
    db.prepare(
      "INSERT INTO tree_nodes VALUES (?, ?, 'scene', NULL, NULL, ?)",
    ).run(id, PROJECT, order);
  for (const entry of new Set([SEED, ...pins]))
    db.prepare("INSERT INTO codex_entries VALUES (?, ?)").run(entry, PROJECT);
  pins.forEach((entry, at) =>
    db
      .prepare("INSERT INTO scene_codex_pins VALUES (?, ?, ?)")
      .run(QUERY, entry, `2026-10-28T00:00:0${at}Z`),
  );
  for (const [key, row] of [
    [INDEX_KEYS.b, b],
    [INDEX_KEYS.chronicle, chronicle],
  ])
    db.prepare(
      "INSERT INTO narrative_semantic_index_metadata VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)",
    ).run(PROJECT, key, row.generation, row.dirty ? 1 : 0);
  db.prepare(
    "INSERT INTO narrative_scope_registries VALUES (?, 'r1', '[]', 1, 'sha256:x', 't')",
  ).run(PROJECT);
  for (const scene of [QUERY, "rt-added"])
    db.prepare(
      "INSERT INTO narrative_scene_scope_bindings VALUES (?, ?, '{}', 1, 'sha256:y', 't')",
    ).run(PROJECT, scene);
  db.close();
  return file;
}

/**
 * A fake product: the page's harness entries and the evaluation addon. Every
 * page entry and launch is an event; `snapshotUsable(kind)` gives the
 * Chronicle snapshot of a query (`index`, `hybrid`, `graph`).
 */
function fakeProduct({ dir, snapshotUsable, onDeclare = () => {} }) {
  const events = [];
  let launches = 0;
  let workspaceDb = null;
  const harness = {
    openWorkspace: async (input) => {
      workspaceDb = path.join(input.workspacePath, "grimodex.db");
      events.push("openWorkspace");
      return { ok: true, value: {} };
    },
    call: async (cmd) => {
      events.push(`call:${cmd}`);
      return { ok: true, value: { authorityId: "ws-1" } };
    },
    declaration: {
      declare: async () => {
        events.push("declare");
        onDeclare(workspaceDb);
        return { ok: true };
      },
      state: async () => ({
        ok: true,
        snapshot: {
          declarationToken: "token-1",
          state: { kind: "declared", effective: true },
        },
      }),
    },
    buildRaw: async () => {
      events.push("buildRaw");
      return { ok: true, value: { ok: true } };
    },
    buildIndex: async () => {
      events.push("query:index");
      return {
        ok: true,
        durationMs: 5,
        probes: [{ initialSnapshot: { indexUsable: snapshotUsable("index") } }],
      };
    },
    measure: async () => {
      events.push("query:hybrid");
      return {
        status: "completed",
        timing: { tFetchMs: 1, tRawReadyMs: 5, tReturnMs: 9 },
        completion: { outcome: "ir-ready" },
        initialSnapshot: { indexUsable: snapshotUsable("hybrid") },
        rawSceneIds: [QUERY],
        finalSceneIds: [QUERY],
      };
    },
    hook: {
      prepare: async () => {
        events.push("hook.prepare");
        return { ok: true, value: {} };
      },
    },
    k64: {
      instrumented: async () => ({ fetchTiming: true }),
      sample: async () => {
        events.push("query:graph");
        const observation = k64Observation();
        observation.fetches[0].result.initialSnapshot = {
          indexUsable: snapshotUsable("graph"),
          querySupported: true,
        };
        observation.fetches[1].paths = {
          graphOnly: {
            sceneId: "rt-added",
            edges: [
              {
                relationType: "t",
                directionality: "directed",
                from: { entityId: SEED },
                to: { entityId: "rt-x" },
                evidence: [{ evidenceId: "e", quote: "plain quote" }],
              },
            ],
          },
          pathAttachments: [],
        };
        return { ok: true, value: observation };
      },
    },
  };
  const page = {
    evaluate: async (fn, arg) => {
      globalThis.window = { cp4Harness: harness };
      try {
        return await fn(arg);
      } finally {
        delete globalThis.window;
      }
    },
  };
  const status = {
    registrations: 1,
    worker: { state: "configured" },
    gateOpened: true,
    owner: {
      slot: "empty",
      cacheOccupied: false,
      profile: { restricted: true, inFlightStopped: true },
    },
  };
  const answers = {
    nir1GraphEvalStatus: () => status,
    nir1GraphEvalDiagnostics: () => ({
      ...k64Diagnostics(2, 1, 1),
      preparesReady: 1,
    }),
    nir1GraphEvalSamples: () => ({
      records: [k64NativeRecord(), K64_CACHED_CHILD],
    }),
    nir1GraphEvalClearSamples: () => ({ cleared: true }),
    nir1GraphEvalClearNextQueryCache: () => ({ cleared: false }),
  };
  const launchMeasurement = async ({ dir: processDir }) => {
    launches += 1;
    events.push("launch");
    const nonce = `0000000${launches}-0000-4000-8000-000000000000`.slice(-36);
    const userData = path.join(processDir, "user-data");
    const receiptDir = path.join(
      userData,
      ".grimodex-body-declaration-ci-receipts",
      sha256(Buffer.from(nonce)),
    );
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(
      path.join(receiptDir, "receipt.json"),
      JSON.stringify({
        version: 1,
        envNames: { nonce: "GRIMODEX_BODY_DECLARATION_CI_NONCE" },
        nonceDigest: `sha256:${"1".repeat(64)}`,
        approvedGrantCount: 1,
        approvedBindingDigests: [`sha256:${"2".repeat(64)}`],
      }),
    );
    const session = {
      page,
      userData,
      evidence: { problems: [] },
      addon: async (name) => JSON.stringify(answers[name]()),
      stderr: () => "",
      pids: () => [],
      stop: async () => {
        events.push("stop");
        return { problems: [], stop: { ok: true } };
      },
    };
    return { session, nonce, status };
  };
  return { events, launchMeasurement, dir, launches: () => launches };
}

function context({ key, spec, metadata, world, pins, setupB = 7 }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-run-"));
  const cold = coldDb(dir, { ...metadata, pins });
  let fakeNow = 0;
  const ctx = {
    spec: {
      variantKey: key,
      caseId: key.split("/")[0],
      variantId: key.split("/")[1],
      measurementPoint: null,
      kind: "steady-state",
      holding: false,
      indexState: { graph: "usable", chronicle: "usable" },
      declaration: null,
      oneShot: null,
      buildChronicleIndex: true,
      readyProbe: true,
      ...spec,
    },
    plan: PLANS.find((row) => row.variantKey === key),
    setup: {
      value: {
        coldDatabase: { path: cold, sha256: sha256(readFileSync(cold)) },
      },
    },
    shared: {
      run: "s5a-test",
      launchMeasurement: world(dir).launchMeasurement,
      startWindowSampler: () => ({ stop: () => [] }),
    },
    ids: {
      projectId: PROJECT,
      querySceneId: QUERY,
      scenes: { "q-logical": QUERY, "added-logical": "rt-added" },
      entities: { "seed-logical": SEED },
    },
    variant: variantByKey(key),
    oneShot: spec.oneShot ?? null,
    gateRow: {
      caseId: key.split("/")[0],
      variantId: key.split("/")[1],
      querySceneId: QUERY,
      expectedSeed: SEED,
    },
    setupProbe: { bGeneration: setupB },
    procedure: formalProcedure(),
    d2aMode: "restricted",
    queryBody: "q",
    revisionIds: [],
    expectedContribution: null,
    materialContribution: (paths) => ({
      basis: "material-revision",
      contribution: paths?.graphOnly?.sceneId === "rt-added",
      matched: [],
      unresolvedEdges: 0,
      observed: [],
    }),
    variantDir: path.join(dir, "variant"),
    clock: {
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
    },
  };
  return { ctx, dir };
}

const steadyState = {
  b: { generation: 7, dirty: false },
  chronicle: { generation: 3, dirty: false },
};

test("D1 (ii)／DR-CP4-N-1: 宣言の run は workspace を開いた後・seed つきの query（READY probe）の前に宣言し、AB/BA の 70 sample を取る", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-02/base",
    spec: { declaration: { sceneId: "added-logical" } },
    metadata: steadyState,
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.samples.length, 70);
    const { events } = world;
    const at = (name) => events.indexOf(name);
    assert.ok(at("openWorkspace") < at("declare"));
    assert.ok(at("declare") < at("buildRaw"));
    assert.ok(at("declare") < at("query:index"));
    assert.ok(at("declare") < at("query:graph"));
    assert.ok(at("declare") < at("query:hybrid"));
    assert.equal(events.filter((row) => row === "launch").length, 1);
    assert.equal(result.proc.declaration.verified, true);
    assert.equal(
      result.proc.declaration.invariants.before.sceneV1.sha256,
      result.proc.declaration.invariants.after.sceneV1.sha256,
    );
    assert.equal(result.proc.checks.seedPin.status, "match");
    // F6 on the Revisions, with the quotes hashed before the record.
    const graph = result.samples.find((row) => row.arm === "graph");
    assert.equal(graph.followUp.child.contributionBasis, "material-revision");
    assert.equal(JSON.stringify(result).includes("plain quote"), false);
    // The probe at every query, before the measurement too.
    assert.equal(result.probes.length, 71);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 P-4 (b) C5: one-shot は 70 の process をそれぞれ cold DB の新しい写しから起こし、測る 1 回の query の前に query を出さない", async () => {
  let world;
  const oneShot = {
    warmupProcessesPerArm: 5,
    measuredProcessesPerArm: 30,
    queriesPerProcess: 1,
    freshColdCopyPerProcess: true,
    receiptLabel: ONE_SHOT_RECEIPT_LABEL,
  };
  const { ctx, dir } = context({
    key: "G-08/chronicle-index-unusable",
    spec: {
      kind: "one-shot",
      holding: true,
      measurementPoint: "while-chronicle-index-unusable",
      indexState: { graph: "usable", chronicle: "unusable" },
      oneShot,
      buildChronicleIndex: false,
      readyProbe: false,
    },
    metadata: {
      b: { generation: 7, dirty: false },
      chronicle: { generation: 3, dirty: true },
    },
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => false })),
  });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(world.launches(), 70);
    assert.equal(result.samples.length, 70);
    assert.ok(
      result.samples.every((row) => row.measurement === ONE_SHOT_RECEIPT_LABEL),
    );
    // Each process: launch … exactly one query … stop; no Index build.
    const processes = [];
    for (const event of world.events) {
      if (event === "launch") processes.push([]);
      else processes.at(-1).push(event);
    }
    for (const events of processes) {
      const queries = events.filter((row) => row.startsWith("query:"));
      assert.equal(queries.length, 1);
      assert.notEqual(queries[0], "query:index");
      assert.equal(events.includes("declare"), false);
      assert.equal(events.at(-1), "stop");
    }
    assert.equal(new Set(result.processes.map((row) => row.process)).size, 70);
    assert.equal(
      result.samples.filter((row) => row.phase === "measured").length,
      60,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C5／DR-CP4-N-2: one-shot の query が C を使えると見たら blocked:index-state-holding で止め、それ以上 process を起こさない", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-08/both-indexes-unusable",
    spec: {
      kind: "one-shot",
      holding: true,
      measurementPoint: "while-both-indexes-unusable",
      indexState: { graph: "unusable", chronicle: "unusable" },
      oneShot: {
        warmupProcessesPerArm: 5,
        measuredProcessesPerArm: 30,
        receiptLabel: ONE_SHOT_RECEIPT_LABEL,
      },
      buildChronicleIndex: false,
      readyProbe: false,
    },
    metadata: {
      b: { generation: 7, dirty: true },
      chronicle: { generation: 3, dirty: true },
    },
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.blocked.harnessId, "index-state-holding");
    assert.equal(result.blocked.condition, "while-variant");
    assert.equal(result.blocked.contractBlockedId, "index-state-holding");
    assert.equal(world.launches(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-CP4-N-2／N-3: 測定の前に B が setup の generation でなければ blocked:b-sealed-binding で、seed つきの query を出さない（G-01 は Hold）", async () => {
  for (const [key, contract, hold] of [
    ["G-02/base", "b-sealed-binding", false],
    ["G-01/v1", null, true],
  ]) {
    let world;
    const { ctx, dir } = context({
      key,
      spec: {},
      metadata: steadyState,
      setupB: 6,
      world: (base) =>
        (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
    });
    try {
      const result = await measureVariant(ctx);
      assert.equal(result.status, "blocked");
      assert.equal(result.blocked.harnessId, "measurement-point-mismatch");
      assert.equal(result.blocked.condition, "graph");
      assert.equal(result.blocked.contractBlockedId, contract);
      assert.equal(result.blocked.hold, hold);
      assert.equal(world.events.includes("query:graph"), false);
      assert.equal(world.events.at(-1), "stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("K2/4 (S3-P3-6): 宣言の段で v1 の列が変われば測定の前に [precheck]（blocked にしない）。測定の写しの pin が違えば R5 の [precheck]", async () => {
  {
    const { ctx, dir } = context({
      key: "G-02/base",
      spec: { declaration: { sceneId: "added-logical" } },
      metadata: steadyState,
      world: (base) =>
        fakeProduct({
          dir: base,
          snapshotUsable: () => true,
          onDeclare: (file) => {
            const db = new DatabaseSync(file);
            db.exec(
              "UPDATE narrative_scene_scope_bindings SET source_token = 'sha256:z'",
            );
            db.close();
          },
        }),
    });
    try {
      await assert.rejects(
        measureVariant(ctx),
        /K2\/4: the declaration step changed sceneV1/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  {
    let world;
    const { ctx, dir } = context({
      key: "G-03/base",
      spec: {},
      metadata: steadyState,
      pins: [SEED, "rt-second"],
      world: (base) =>
        (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
    });
    try {
      await assert.rejects(measureVariant(ctx), /R5: .*multiple-pins/u);
      assert.equal(world.events.includes("query:graph"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
