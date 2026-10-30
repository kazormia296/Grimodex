// CP-4 S5-A: 正式の run の測定の process の組み立て（DR-CP4-N-1〜N-3）を、
// 偽の session と page（node の試験。Electron を起動しない）と使い捨ての SQLite
// で確かめる: 宣言の段は seed つきの query（V-10 の READY probe）より前、one-shot
// の process は測る 1 回の query の前に query を出さない（C5）、測定の前と query
// の時点の d2 の不一致は blocked（表で判定）、宣言の段の前後の不変量の違いと
// 測定の写しの pin の違いは [precheck]。

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { K62_FREEZE, devVariant, variantByKey } from "./constants.mjs";
import { ONE_SHOT_RECEIPT_LABEL } from "./frozen-k64-plan.mjs";
import { createG01NegativeRun } from "./g01-negative-run.mjs";
import {
  BLOCKED_RECORD_SCHEMA,
  K64_DISCLOSURE,
  graphArmGated,
  measurementLaunchEnv,
  runKindVariantKeys,
  measureVariant,
  parseArgs,
  readSetups,
  runFrozenK64,
  writeVariantRecord,
} from "./frozen-k64-run.mjs";
import {
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import {
  FRESHNESS_CONSUMER_ID,
  INDEX_KEYS,
  freshnessSettled,
  readDeclarationInvariants,
  readFreshnessFeed,
  readIndexMetadata,
  waitFreshnessSettled,
} from "./workspace-db.mjs";
import {
  K64_CACHED_CHILD,
  REPO_ROOT,
  formalProcedure,
  ratification5,
  k64Diagnostics,
  k64NativeRecord,
  k64Observation,
} from "./test-support.mjs";

const PLANS = loadFrozenSetupPlans({ root: REPO_ROOT, stopsAt: "complete" });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PROJECT = "rt-p";
const QUERY = "rt-query";
const SEED = "rt-seed";

/**
 * DR-CP4-T-1: the product's Change Feed and the Freshness cursor. `feed`
 * null leaves the feed empty and no cursor (settled); otherwise events
 * 1..head and the cursor at `ack` (with an active run or a reservation).
 */
function writeFeed(db, feed) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_change_events (id TEXT PRIMARY KEY, project_id TEXT, canonical_sequence INTEGER, event_ordinal INTEGER);
    CREATE TABLE IF NOT EXISTS narrative_change_cursors (project_id TEXT, consumer_id TEXT, acknowledged_through_sequence INTEGER, active_run_id TEXT, reserved_through_sequence INTEGER);
  `);
  if (!feed) return;
  for (let sequence = 1; sequence <= feed.head; sequence += 1)
    for (let ordinal = 0; ordinal < (feed.ordinals ?? 1); ordinal += 1)
      db.prepare("INSERT INTO narrative_change_events VALUES (?, ?, ?, ?)").run(
        `e-${sequence}-${ordinal}`,
        PROJECT,
        sequence,
        ordinal,
      );
  if (feed.cursor === false) return;
  db.prepare("INSERT INTO narrative_change_cursors VALUES (?, ?, ?, ?, ?)").run(
    PROJECT,
    FRESHNESS_CONSUMER_ID,
    feed.ack,
    feed.activeRun ?? null,
    feed.reserved ?? null,
  );
}

function coldDb(dir, { b, chronicle, pins = [SEED], feed = null }) {
  const file = path.join(dir, "cold.db");
  const db = new DatabaseSync(file);
  writeFeed(db, feed);
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT, parent_id TEXT, sort_order TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
    CREATE TABLE narrative_semantic_index_metadata (project_id TEXT, index_key TEXT, generation INTEGER, dirty_cache_flag INTEGER, source_digest TEXT, dependency_set_digest TEXT, producer_id TEXT, producer_version TEXT);
    CREATE TABLE narrative_scope_registries (project_id TEXT, registry_version TEXT, timeline_refs_json TEXT, worldline_refs_json TEXT, narrative_layer_refs_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT);
    CREATE TABLE narrative_scene_scope_bindings (project_id TEXT, scene_id TEXT, scene_incarnation_id TEXT, compatibility_marker TEXT, query_identity_json TEXT, material_constraint_json TEXT, knowledge_holder_json TEXT, audience_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT);
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
    "INSERT INTO narrative_scope_registries VALUES (?, 'r1', '[]', '[]', '[]', 1, 'sha256:x', 't')",
  ).run(PROJECT);
  for (const scene of [QUERY, "rt-added"])
    db.prepare(
      "INSERT INTO narrative_scene_scope_bindings VALUES (?, ?, 'i', 'm', '{}', '{}', '{}', '{}', 1, 'sha256:y', 't')",
    ).run(PROJECT, scene);
  db.close();
  return file;
}

/**
 * A fake product: the page's harness entries and the evaluation addon. Every
 * page entry and launch is an event; `snapshotUsable(kind)` gives the
 * Chronicle snapshot of a query (`index`, `hybrid`, `graph`).
 *
 * DR-CP4-T-1: `freshness` ({ atMs, now }) plays the product's Freshness
 * scheduler: `atMs` after a launch (on the test's fake clock) it acknowledges
 * the copy's feed and, in the same write, dirties B and C (`invalidate.rs`
 * `suspend_project_in_tx`); `tick()` is its timer. With it, the Index build
 * rebuilds a dirty C and every query's snapshot is the copy's C.
 */
function fakeProduct({ dir, snapshotUsable, onDeclare = () => {}, freshness }) {
  const events = [];
  const launchArgs = [];
  let launches = 0;
  let seededQueries = 0;
  let workspaceDb = null;
  let launchedAt = null;
  let processed = false;
  let queries = 0;
  const writeDb = (write) => {
    const db = new DatabaseSync(workspaceDb);
    try {
      return write(db);
    } finally {
      db.close();
    }
  };
  const chronicleUsable = () => {
    const c = readIndexMetadata(workspaceDb, PROJECT).chronicle;
    return Boolean(c && !c.dirty);
  };
  const tick = () => {
    if (!freshness || processed || workspaceDb === null) return;
    if (
      freshness.now() - launchedAt < freshness.atMs &&
      queries < (freshness.atQuery ?? Infinity)
    )
      return;
    processed = true;
    events.push("freshness:ack");
    writeDb((db) => {
      db.exec("BEGIN");
      db.prepare(
        "UPDATE narrative_change_cursors SET acknowledged_through_sequence = (SELECT COALESCE(MAX(canonical_sequence), 0) FROM narrative_change_events WHERE project_id = ?1) WHERE project_id = ?1",
      ).run(PROJECT);
      db.prepare(
        "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE project_id = ?",
      ).run(PROJECT);
      db.exec("COMMIT");
    });
  };
  const usable = (kind) => {
    if (!freshness || kind === "index") return snapshotUsable(kind);
    queries += 1;
    tick();
    return chronicleUsable();
  };
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
      // DR-CP4-T-1: the query route rebuilds a dirty C (a new generation).
      if (freshness && !chronicleUsable())
        writeDb((db) =>
          db
            .prepare(
              "UPDATE narrative_semantic_index_metadata SET generation = generation + 1, dirty_cache_flag = 0 WHERE project_id = ? AND index_key = ?",
            )
            .run(PROJECT, INDEX_KEYS.chronicle),
        );
      return {
        ok: true,
        durationMs: 5,
        probes: [
          {
            initialSnapshot: {
              indexUsable: freshness ? chronicleUsable() : usable("index"),
            },
          },
        ],
      };
    },
    measure: async () => {
      events.push("query:hybrid");
      return {
        status: "completed",
        timing: { tFetchMs: 1, tRawReadyMs: 5, tReturnMs: 9 },
        completion: { outcome: "ir-ready" },
        initialSnapshot: { indexUsable: usable("hybrid") },
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
        seededQueries += 1;
        events.push("query:graph");
        const observation = k64Observation();
        observation.fetches[0].result.initialSnapshot = {
          indexUsable: usable("graph"),
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
      tick();
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
    // Review P3 (a): READY only after the first seeded query, so a READY
    // probe is a real query in the events.
    nir1GraphEvalDiagnostics: () => ({
      ...k64Diagnostics(2, 1, 1),
      preparesReady: seededQueries > 0 ? 1 : 0,
    }),
    nir1GraphEvalSamples: () => ({
      records: [k64NativeRecord(), K64_CACHED_CHILD],
    }),
    nir1GraphEvalClearSamples: () => ({ cleared: true }),
    nir1GraphEvalClearNextQueryCache: () => ({ cleared: false }),
  };
  const launchMeasurement = async ({ dir: processDir, d2aMode, bodySeam }) => {
    launches += 1;
    seededQueries = 0;
    workspaceDb = null;
    processed = false;
    queries = 0;
    launchedAt = freshness?.now() ?? null;
    events.push("launch");
    launchArgs.push({ d2aMode, bodySeam });
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
  return {
    events,
    launchArgs,
    launchMeasurement,
    dir,
    launches: () => launches,
    tick,
  };
}

function context({ key, spec, metadata, world, pins, setupB = 7, feed }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-run-"));
  const cold = coldDb(dir, { ...metadata, pins, feed });
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
    arms: ["hybrid", "graph"],
    g01Fallback: false,
    queryBody: "q",
    revisionIds: [],
    expectedContribution: null,
    seenPaths: [],
    materialContribution: (paths) => {
      ctx.seenPaths.push(paths);
      return {
        basis: "material-revision",
        contribution: paths?.graphOnly?.sceneId === "rt-added",
        matched: [],
        unresolvedEdges: 0,
        observed: [],
      };
    },
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
    // The declaring process alone opens the body declaration seam (P3 (e)).
    assert.deepEqual(world.launchArgs, [
      { d2aMode: "restricted", bodySeam: true },
    ]);
    // READY was reached through a seeded probe after the declaration.
    assert.ok(result.proc.checks.ownerReady.probes.length >= 1);
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
    // The resolver sees the child's paths with the quotes already hashed.
    assert.ok(ctx.seenPaths.length > 0);
    for (const paths of ctx.seenPaths) {
      const evidence = paths.graphOnly.edges[0].evidence[0];
      assert.equal(evidence.quote, undefined);
      assert.equal(evidence.quoteSha256, sha256(Buffer.from("plain quote")));
    }
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
    // A fresh byte copy of the cold DB per process (C1), at its own path,
    // removed after its stop with its digest kept (review P3 (h)).
    const copies = result.processes.map((row) => row.copy);
    assert.equal(new Set(copies.map((row) => row.path)).size, 70);
    assert.ok(
      copies.every(
        (row) => row.removed && /^[0-9a-f]{64}$/u.test(row.sha256After),
      ),
    );
    assert.equal(
      readdirSync(ctx.variantDir).filter((name) =>
        existsSync(path.join(ctx.variantDir, name, "workspace", "grimodex.db")),
      ).length,
      0,
    );
    // No body declaration seam in a process that does not declare (P3 (e)).
    assert.ok(world.launchArgs.every((row) => row.bodySeam === false));
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
      // A process that stops before its first query is stopped (no leak).
      assert.equal(world.events.at(-1), "stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("レビュー P2-4: unchanged の variant の query の時点の不一致は観測として記録し、止めない（readAs の 3 variant だけが止まる）", async () => {
  let calls = 0;
  const { ctx, dir } = context({
    key: "G-03/base",
    spec: {},
    metadata: steadyState,
    world: (base) =>
      fakeProduct({
        dir: base,
        // The Index build is usable; one hybrid query later is not.
        snapshotUsable: (kind) => !(kind === "hybrid" && ++calls === 3),
      }),
  });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.samples.length, 70);
    const observed = result.probes.filter((row) => row.mismatch);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].observedOnly, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C5（レビュー P3 (a)）: one-shot の query の時点の snapshot が無い（null）なら index-state-holding で止める", async () => {
  const { ctx, dir } = context({
    key: "G-08/chronicle-index-unusable",
    spec: {
      kind: "one-shot",
      holding: true,
      measurementPoint: "while-chronicle-index-unusable",
      indexState: { graph: "usable", chronicle: "unusable" },
      oneShot: {
        warmupProcessesPerArm: 5,
        measuredProcessesPerArm: 30,
        receiptLabel: ONE_SHOT_RECEIPT_LABEL,
      },
      buildChronicleIndex: false,
      readyProbe: false,
    },
    metadata: {
      b: { generation: 7, dirty: false },
      chronicle: { generation: 3, dirty: true },
    },
    world: (base) => fakeProduct({ dir: base, snapshotUsable: () => null }),
  });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.blocked.harnessId, "index-state-holding");
    // The read-as variant's B metadata is read at the query (P3 (i)).
    assert.equal(result.probes.at(-1).metadata.b.generation, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-CP4-N-10: G-01 の fallback は unrestricted の R+IR の process と restricted の Graph の process を直列に起こし、sample を AB/BA の順に並べる", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-01/v1",
    spec: { declaration: { sceneId: "added-logical" } },
    metadata: steadyState,
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  ctx.g01Fallback = true;
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.deepEqual(world.launchArgs, [
      { d2aMode: "unrestricted", bodySeam: false },
      { d2aMode: "restricted", bodySeam: true },
    ]);
    // The unrestricted process issues R+IR queries only; the declaration
    // and every seeded query are in the restricted one.
    const second = world.events.lastIndexOf("launch");
    assert.equal(world.events.slice(0, second).includes("query:graph"), false);
    assert.equal(world.events.slice(0, second).includes("declare"), false);
    assert.equal(world.events.slice(second).includes("query:hybrid"), false);
    assert.equal(result.samples.length, 70);
    assert.deepEqual(
      result.samples.slice(0, 4).map((row) => [row.arm, row.armProcess]),
      [
        ["hybrid", "hybrid-unrestricted"],
        ["graph", "graph-restricted"],
        ["graph", "graph-restricted"],
        ["hybrid", "hybrid-unrestricted"],
      ],
    );
    assert.equal(
      result.samples.find((row) => row.arm === "hybrid").d2aMode,
      "unrestricted",
    );
    assert.equal(result.proc.declaration.verified, true);
    assert.equal(result.armProcesses.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d10.parity: parity の run は unrestricted の R+IR の slot だけを取り、宣言も seed つきの query もしない", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-02/base",
    spec: { declaration: { sceneId: "added-logical" } },
    metadata: steadyState,
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  Object.assign(ctx, { arms: ["hybrid"], d2aMode: "unrestricted" });
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.samples.length, 35);
    assert.ok(result.samples.every((row) => row.arm === "hybrid"));
    assert.equal(world.events.includes("query:graph"), false);
    assert.equal(world.events.includes("declare"), false);
    assert.deepEqual(world.launchArgs, [
      { d2aMode: "unrestricted", bodySeam: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function recordInput(dir, key, extra = {}) {
  const plan = PLANS.find((row) => row.variantKey === key);
  return {
    ctx: {
      spec: {
        variantKey: key,
        kind: "steady-state",
        measurementPoint: null,
        indexState: { graph: "usable", chronicle: "usable" },
      },
      plan,
      setup: {
        path: path.join(dir, "setup-receipt.json"),
        sha256: "a".repeat(64),
        value: { logicalToRuntime: { projectId: PROJECT } },
      },
      variant: variantByKey(key),
      variantDir: path.join(dir, "record"),
      arms: ["hybrid", "graph"],
      d2aMode: "restricted",
      g01Fallback: false,
      gateRow: { expectedSeed: SEED },
      windowSamples: [],
      run: { startedAtMs: 1, finishedAtMs: 2 },
      ...extra,
    },
    runId: `t/${key}`,
    runKind: "gold",
    dev: false,
    admitted: {
      head: { runStartedAtUtc: "2026-10-28T00:00:00.000Z" },
      ratification5: ratification5(),
      procedure: formalProcedure(),
    },
    candidate: {
      commit: "b".repeat(40),
      tree: "c".repeat(40),
      clean: true,
      harnessFiles: {},
    },
    priorAttempts: [{ runName: "earlier", status: "stopped" }],
    problems: [],
  };
}

test("レビュー P1-1: blocked の variant は集計を通さず、表の判定・probe・途中までの sample（sha つき）を blocked の記録に残す（空、途中まで）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-record-"));
  try {
    const blocked = {
      harnessId: "index-state-holding",
      condition: "while-variant",
      unmetPreconditions: ["index-state-holding"],
      contractBlockedId: "index-state-holding",
      hold: false,
      precheck: false,
    };
    for (const samples of [
      [],
      [
        {
          variantKey: "G-08/both-indexes-unusable",
          phase: "warmup",
          repeat: 0,
          arm: "hybrid",
        },
      ],
    ]) {
      const input = recordInput(dir, "G-08/both-indexes-unusable");
      const row = await writeVariantRecord({
        ...input,
        result: {
          status: "blocked",
          blocked,
          probes: [{ at: "at-query", indexUsable: true }],
          samples,
        },
      });
      assert.equal(row.status, "blocked");
      const record = JSON.parse(
        readFileSync(
          path.join(input.ctx.variantDir, "blocked-record.json"),
          "utf8",
        ),
      );
      assert.equal(record.schemaVersion, BLOCKED_RECORD_SCHEMA);
      assert.deepEqual(record.blocked, blocked);
      assert.equal(record.samples.length, samples.length);
      assert.equal(
        record.samplesSha256,
        sha256(Buffer.from(JSON.stringify(samples))),
      );
      assert.deepEqual(record.priorAttempts, [
        { runName: "earlier", status: "stopped" },
      ]);
      assert.equal(
        existsSync(path.join(input.ctx.variantDir, "receipt.json")),
        false,
      );
      rmSync(input.ctx.variantDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("レビュー P1-2: parity の run は R+IR の slot だけの receipt（g-case-parity-unrestricted）を作り、列が違えば sample を sha つきで残して拒む", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-parity-"));
  try {
    const key = "G-02/base";
    const hybridRows = [];
    for (const [phase, count] of [
      ["warmup", 5],
      ["measured", 30],
    ])
      for (let repeat = 0; repeat < count; repeat += 1)
        hybridRows.push({
          variantKey: key,
          arm: "hybrid",
          phase,
          repeat,
          trigger: "user-operation",
          seeded: false,
          graphEnabled: false,
          d2aMode: "unrestricted",
          tFetch: 1,
          tRawReady: 5,
          tReturn: 9,
          status: "completed",
          irOutcome: "ready",
          irCompletion: "ir-ready",
          rawSceneIds: [QUERY],
          finalSceneIds: [QUERY],
        });
    const input = recordInput(dir, key, {
      arms: ["hybrid"],
      d2aMode: "unrestricted",
    });
    const row = await writeVariantRecord({
      ...input,
      runKind: "parity",
      result: { status: "measured", samples: hybridRows, probes: [] },
    });
    const receipt = JSON.parse(
      readFileSync(path.join(input.ctx.variantDir, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.runKind, "g-case-parity-unrestricted");
    assert.deepEqual(receipt.settings.d2aModes, { hybrid: "unrestricted" });
    assert.deepEqual(receipt.settings.k64Disclosure, { ...K64_DISCLOSURE });
    assert.deepEqual(receipt.priorAttempts, input.priorAttempts);
    assert.notEqual(row.status, "receipt-refused");
    // A dev parity (shape check) is a preview without the Gold summaries.
    const devInput = recordInput(dir, key, {
      arms: ["hybrid"],
      d2aMode: "unrestricted",
      variant: devVariant({
        key: "dev:dev-g05-shape.v1/base",
        expectedGraph: "available",
      }),
    });
    devInput.ctx.variantDir = path.join(dir, "dev");
    const devRow = await writeVariantRecord({
      ...devInput,
      dev: true,
      runKind: "parity",
      result: {
        status: "measured",
        samples: hybridRows.map((row) => ({
          ...row,
          variantKey: "dev:dev-g05-shape.v1/base",
        })),
        probes: [],
      },
    });
    assert.notEqual(devRow.status, "receipt-refused", devRow.error);
    const short = recordInput(dir, key, {
      arms: ["hybrid"],
      d2aMode: "unrestricted",
    });
    short.ctx.variantDir = path.join(dir, "short");
    const refused = await writeVariantRecord({
      ...short,
      runKind: "parity",
      result: { status: "measured", samples: hybridRows.slice(1), probes: [] },
    });
    assert.equal(refused.status, "receipt-refused");
    const kept = JSON.parse(
      readFileSync(path.join(short.ctx.variantDir, "samples.json"), "utf8"),
    );
    assert.equal(kept.samples.length, 34);
    assert.match(kept.samplesSha256, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("レビュー P2-5: 完全な setup の受領書が run の候補（commit と tree）でないなら [precheck]", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-setups-"));
  try {
    const plan = PLANS.find((row) => row.variantKey === "G-02/base");
    const receipt = path.join(dir, "setup-receipt.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        status: "setup-complete",
        fixture: {
          path: plan.fixturePath,
          sha256: plan.fixtureSha256,
          variantId: plan.variantId,
        },
        candidate: { commit: "1".repeat(40), tree: "2".repeat(40) },
      }),
    );
    const map = path.join(dir, "setups.json");
    writeFileSync(map, JSON.stringify({ [plan.variantKey]: receipt }));
    await assert.rejects(
      readSetups({
        file: map,
        plans: [plan],
        dev: false,
        candidate: { commit: "3".repeat(40), tree: "2".repeat(40) },
      }),
      /not the run's candidate/u,
    );
    // The tree alone differing is refused too.
    await assert.rejects(
      readSetups({
        file: map,
        plans: [plan],
        dev: false,
        candidate: { commit: "1".repeat(40), tree: "4".repeat(40) },
      }),
      /not the run's candidate/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("レビュー P3 (d): 宣言の前後の不変量の読取は列が欠けた表で止まる（黙って飛ばさない）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-columns-"));
  try {
    const file = coldDb(dir, steadyState);
    assert.equal(readDeclarationInvariants(file, PROJECT).sceneV1.rows, 2);
    const db = new DatabaseSync(file);
    db.exec("ALTER TABLE narrative_scene_scope_bindings DROP COLUMN version");
    db.close();
    assert.throws(
      () => readDeclarationInvariants(file, PROJECT),
      /lacks version/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("再レビュー P3: 正式の run は --variant と --dev-g01-fallback を拒み、dev の形の確認では受ける", () => {
  const formal = [
    "--run",
    "r",
    "--setups",
    "s.json",
    "--ja-model",
    "j",
    "--en-model",
    "e",
    "--candidate",
    "c",
    "--prep-commit",
    "p",
    "--k62-commit",
    "k",
    "--k64-commit",
    "k",
    "--product-receipt",
    "pr.json",
    // S5-B (DR-CP4-O-16): a formal Graph-arm run names ④'s SP-P4 receipt.
    "--sp-p4-receipt",
    "sp.json",
  ];
  assert.equal(parseArgs(formal)["run-kind"], "gold");
  assert.throws(
    () => parseArgs([...formal, "--variant", "G-02/base"]),
    /--variant is a dev shape-check option/u,
  );
  assert.throws(
    () => parseArgs([...formal, "--dev-g01-fallback", "true"]),
    /dev shape-check option/u,
  );
  assert.throws(
    () => parseArgs([...formal, "--d2a-mode", "unrestricted"]),
    /--d2a-mode is gone/u,
  );
  const dev = [
    "--run",
    "r",
    "--setups",
    "s.json",
    "--ja-model",
    "j",
    "--en-model",
    "e",
    "--k62-commit",
    "k",
    "--dev-fixture",
    "f.json",
  ];
  assert.equal(parseArgs([...dev, "--variant", "X/y"]).variant, "X/y");
});

test("再レビュー P3（P1-1 の runFrozenK64 の層）: setup が blocked の variant は blocked の記録として残り、集計の receipt を作らない", async (t) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${K62_FREEZE.commit}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
  } catch {
    t.skip("the K6/2 freeze commit is not in this clone (shallow checkout)");
    return;
  }
  const fixturePath =
    "scripts/quality/nir1-graph-eval/dev-fixtures/dev-harbor-graph-case.v1.json";
  const plan = loadDevGraphCasePlans({
    root: REPO_ROOT,
    fixturePath,
    stopsAt: "complete",
  }).find((row) => row.variantId === "base-usable");
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-s5a-blocked-run-"));
  const run = `s5a-test-blocked-${process.pid}`;
  const runDir = path.join(REPO_ROOT, ".artifacts/cp4", run);
  // The parents this test creates (a CI checkout has no .artifacts) are
  // removed after it; the ones that existed stay.
  const created = [".artifacts", ".artifacts/cp4"]
    .map((dir) => path.join(REPO_ROOT, dir))
    .filter((dir) => !existsSync(dir));
  const exitCode = process.exitCode;
  try {
    const receipt = path.join(dir, "setup-receipt.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        status: "blocked",
        fixture: {
          kind: "dev",
          path: plan.fixturePath,
          sha256: plan.fixtureSha256,
          variantId: plan.variantId,
        },
        blocked: {
          harnessId: "b-seal-not-published",
          condition: "any",
          unmetPreconditions: ["b-sealed-binding"],
          contractBlockedId: "b-sealed-binding",
          hold: false,
        },
      }),
    );
    const map = path.join(dir, "setups.json");
    writeFileSync(map, JSON.stringify({ [plan.variantKey]: receipt }));
    await runFrozenK64([
      "--run",
      run,
      "--dev-fixture",
      fixturePath,
      "--setups",
      map,
      "--variant",
      plan.variantKey,
      "--ja-model",
      "j",
      "--en-model",
      "e",
      "--k62-commit",
      K62_FREEZE.commit,
      "--eval-build",
      path.join(dir, "no-eval-build"),
    ]);
    const variantDir = path.join(runDir, "DEV-HARBOR_base-usable");
    const record = JSON.parse(
      readFileSync(path.join(variantDir, "blocked-record.json"), "utf8"),
    );
    assert.equal(record.status, "blocked-at-setup");
    assert.equal(record.blocked.harnessId, "b-seal-not-published");
    assert.equal(record.blocked.contractBlockedId, "b-sealed-binding");
    assert.equal(existsSync(path.join(variantDir, "receipt.json")), false);
    // Nothing was launched: no renderer build, no observer.
    assert.equal(existsSync(path.join(runDir, "renderer-dist")), false);
    const report = JSON.parse(
      readFileSync(path.join(runDir, "run-report.json"), "utf8"),
    );
    assert.equal(report.variants[plan.variantKey].status, "blocked-at-setup");
  } finally {
    process.exitCode = exitCode;
    rmSync(dir, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
    for (const dir of created.reverse())
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  }
});

// ---- S5-B の統合（DR-CP4-O-16）-------------------------------------------

test("S5-B 統合: Graph を要求する run の種類（gold、negative）は ④ の SP-P4 の gate の後だけ、parity は除外。13 variant のどれを測るかは run の種類で決まる", () => {
  const prep = {
    d10: {
      parity: {
        variants: PLANS.map((row) => row.variantKey).filter(
          (key) => !key.startsWith("G-01/"),
        ),
        unrestrictedRunsPerVariant: 1,
      },
    },
  };
  assert.equal(PLANS.length, 13);
  const all = PLANS.map((row) => row.variantKey);
  const pick = (runKind) => {
    const keys = runKindVariantKeys({ runKind, prep, dev: false });
    return all.filter((key) => keys === null || keys.has(key));
  };
  assert.deepEqual(pick("gold"), all);
  assert.deepEqual(pick("negative"), ["G-01/v1"]);
  assert.deepEqual(
    pick("parity"),
    all.filter((key) => key !== "G-01/v1"),
  );
  assert.equal(graphArmGated("gold"), true);
  assert.equal(graphArmGated("negative"), true);
  assert.equal(graphArmGated("parity"), false);
  const formal = [
    "--run",
    "r",
    "--setups",
    "s.json",
    "--ja-model",
    "j",
    "--en-model",
    "e",
    "--candidate",
    "c",
    "--prep-commit",
    "p",
    "--k62-commit",
    "k",
    "--k64-commit",
    "k",
    "--product-receipt",
    "pr.json",
  ];
  assert.throws(() => parseArgs(formal), /--sp-p4-receipt is required/u);
  assert.throws(
    () =>
      parseArgs([...formal, "--run-kind", "negative", "--sp-p4-receipt", "s"]),
    /--negative K24-G01-N2\|N3\|N4 is required/u,
  );
  assert.equal(
    parseArgs([...formal, "--run-kind", "parity"])["run-kind"],
    "parity",
  );
  assert.equal(
    parseArgs([
      ...formal,
      "--run-kind",
      "negative",
      "--negative",
      "K24-G01-N3",
      "--sp-p4-receipt",
      "s",
    ]).negative,
    "K24-G01-N3",
  );
});

test("S5-B 統合: negative の run は宣言の前と後に B の段を呼び、後の段の開き直した Main で測り、graph の各 sample を B の聞き直しで取る", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-01/v1",
    spec: { declaration: { sceneId: "added-logical" } },
    metadata: steadyState,
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  const calls = [];
  let asked = 0;
  ctx.negative = {
    beforeDeclaration: async ({ proc }) => {
      calls.push(["before", world.events.length, proc.session !== null]);
      world.events.push("negative:before");
      return null;
    },
    afterDeclaration: async ({ relaunch, stop, proc }) => {
      world.events.push("negative:after");
      await stop(proc.session);
      const session = await relaunch("measure-reopen-0");
      calls.push(["after", session.bodyNonce]);
      return session;
    },
    askGraph: async (take) => {
      asked += 1;
      return take();
    },
    measurementProbe: (base) => ({ ...base, negativeReopen: true }),
  };
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.samples.length, 70);
    const at = (name) => world.events.indexOf(name);
    assert.ok(at("openWorkspace") < at("negative:before"));
    assert.ok(at("negative:before") < at("declare"));
    assert.ok(at("declare") < at("buildRaw"));
    // The control and the mutation come after the Raw vectors and the
    // Chronicle Index, before any measured or READY query.
    assert.ok(at("buildRaw") < at("negative:after"));
    assert.ok(at("query:index") < at("negative:after"));
    assert.ok(at("negative:after") < at("query:graph"));
    assert.equal(ctx.setupProbe.negativeReopen, true);
    // The reopened Main opens the same workspace, then measures.
    assert.equal(world.launches(), 2);
    assert.equal(
      world.events.filter((row) => row === "openWorkspace").length,
      2,
    );
    assert.equal(typeof calls[1][1], "string");
    // Every Graph-arm slot (warm-up 5 + measured 30) goes through askGraph.
    assert.equal(asked, 35);
    assert.equal(result.proc.declaration.verified, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5-B 統合（変異 I9）: 宣言の前に開き直した Main の宣言は、その Main の body declaration の nonce の seam の受領書で確かめる", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-01/v1",
    spec: { declaration: { sceneId: "added-logical" } },
    metadata: steadyState,
    world: (base) =>
      (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
  });
  ctx.negative = {
    beforeDeclaration: async ({ relaunch, stop, proc }) => {
      await stop(proc.session);
      const session = await relaunch("before-declaration-reopen-0");
      // The reopened Main has its own user data: only its nonce's receipt.
      const userData = path.join(dir, "reopened-user-data");
      const receiptDir = path.join(
        userData,
        ".grimodex-body-declaration-ci-receipts",
        sha256(Buffer.from(session.bodyNonce)),
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
      return { ...session, userData };
    },
    afterDeclaration: async ({ proc }) => proc.session,
    askGraph: (take) => take(),
    measurementProbe: (base) => base,
  };
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.proc.declaration.verified, true);
    assert.equal(world.launches(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function formalArgs(run, extra = []) {
  // The receipts the admission's call reads (the injected admission ignores
  // their content).
  const inputs = mkdtempSync(path.join(tmpdir(), "s5b-formal-"));
  writeFileSync(path.join(inputs, "eval-build.json"), "{}");
  writeFileSync(path.join(inputs, "pr.json"), "{}");
  return [
    "--run",
    run,
    "--setups",
    "s.json",
    "--ja-model",
    "j",
    "--en-model",
    "e",
    "--candidate",
    "c".repeat(40),
    "--prep-commit",
    "5".repeat(40),
    "--k62-commit",
    "6".repeat(40),
    "--k64-commit",
    "4".repeat(40),
    "--product-receipt",
    path.join(inputs, "pr.json"),
    "--sp-p4-receipt",
    "sp.json",
    "--eval-build",
    inputs,
    ...extra,
  ];
}

/** Injected formal admission (the frozen descriptor's shape; no git). */
function formalDeps(log, overrides = {}) {
  const candidate = { commit: "c".repeat(40), tree: "t".repeat(40) };
  return {
    assertCandidate: () => {
      log.push("candidate");
      return candidate;
    },
    readK64Head: () => {
      log.push("k64");
      return {};
    },
    admitFormal: () => {
      log.push("admit");
      return {
        candidate,
        pins: [],
        procedure: formalProcedure(),
        s2: {
          commit: "5".repeat(40),
          files: {
            observationPrep: { value: {}, path: "o", sha256: "0".repeat(64) },
            g01Addendum: { value: {}, path: "g", sha256: "0".repeat(64) },
            declarationAddendum: {
              value: {},
              path: "d",
              sha256: "0".repeat(64),
            },
          },
        },
        admission: {
          candidateHead: candidate.commit,
          ratification5: ratification5(),
          head: {
            k62: {},
            k64: {},
            observationPrep: { commit: "5".repeat(40) },
          },
        },
      };
    },
    readGate: (input) => {
      log.push(["gate", input.candidateCommit]);
      return { summary: { status: "passed" } };
    },
    planRun: ({ plans }) => {
      log.push("plan");
      return plans.map((plan) => ({
        variantKey: plan.variantKey,
        caseId: plan.caseId,
        variantId: plan.variantId,
        g01Mode: { mode: "restricted" },
      }));
    },
    readSetupsFn: async ({ plans }) => {
      log.push("setups");
      return new Map(
        plans.map((plan) => [plan.variantKey, { blocked: false, value: {} }]),
      );
    },
    listAttemptsFn: () => [],
    selectParityFn: () => {
      log.push("parity");
      return { used: "parity-1", attempts: [] };
    },
    startAttemptFn: () => {
      log.push("attempt");
      throw new Error("[precheck] test: stop after the ledger");
    },
    // No built addon in a CI checkout (the digest is the admission's input).
    defaultAddonSha256Of: () => "a".repeat(64),
    ...overrides,
  };
}

async function runFormal(run, deps, extra) {
  const runDir = path.join(REPO_ROOT, ".artifacts/cp4", run);
  // The parents this test creates (a CI checkout has no .artifacts) go after.
  const created = [".artifacts", ".artifacts/cp4"]
    .map((dir) => path.join(REPO_ROOT, dir))
    .filter((dir) => !existsSync(dir));
  const exitCode = process.exitCode;
  try {
    await runFrozenK64(formalArgs(run, extra), deps);
    return JSON.parse(
      readFileSync(path.join(runDir, "run-report.json"), "utf8"),
    );
  } finally {
    process.exitCode = exitCode;
    rmSync(runDir, { recursive: true, force: true });
    for (const dir of created.reverse())
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  }
}

test("レビュー P2-β (a): 13 variant の gold と negative は ④ の SP-P4 の gate を試行の台帳と起動より前に呼び、gate が拒めば台帳も起動も起きない", async () => {
  for (const extra of [
    [],
    ["--run-kind", "negative", "--negative", "K24-G01-N2"],
  ]) {
    const log = [];
    const report = await runFormal(
      `s5b-gate-order-${process.pid}-${extra.length}`,
      formalDeps(log),
      extra,
    );
    const names = log.map((row) => (Array.isArray(row) ? row[0] : row));
    assert.ok(names.indexOf("gate") > names.indexOf("admit"));
    assert.ok(names.indexOf("gate") < names.indexOf("plan"));
    assert.ok(names.indexOf("gate") < names.indexOf("attempt"));
    assert.deepEqual(
      log.find((row) => Array.isArray(row)),
      ["gate", "c".repeat(40)],
    );
    if (extra.length === 0)
      assert.ok(names.indexOf("parity") < names.indexOf("attempt"));
    assert.match(report.problems.join("\n"), /stop after the ledger/u);
  }
  const refused = [];
  const report = await runFormal(
    `s5b-gate-refused-${process.pid}`,
    formalDeps(refused, {
      readGate: () => {
        refused.push("gate");
        throw new Error("[precheck] S5-B gate: SP-P4 is sp-n7");
      },
    }),
  );
  assert.deepEqual(refused, ["candidate", "k64", "admit", "gate"]);
  assert.match(report.problems.join("\n"), /S5-B gate: SP-P4 is sp-n7/u);
  // parity は gate を呼ばない（S2 で除外）。
  const parity = [];
  await runFormal(
    `s5b-gate-parity-${process.pid}`,
    formalDeps(parity, {
      readGate: () => {
        parity.push("gate");
        throw new Error("never");
      },
    }),
    ["--run-kind", "parity"],
  );
  assert.ok(!parity.includes("gate"));
});

test("レビュー P2-β (b): B-ROUTE の seam の env は negative の起動にだけ入り、gold と parity には入らない", () => {
  const nonce = "8c7f4a3e-6b1d-4c2a-9e5f-0a1b2c3d4e5f";
  const trigger = "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
  const gold = measurementLaunchEnv({ bodySeam: true, nonce, negative: null });
  assert.equal(gold.GRIMODEX_BODY_DECLARATION_CI_NONCE, nonce);
  assert.equal(gold[trigger], undefined);
  assert.deepEqual(
    measurementLaunchEnv({ bodySeam: false, nonce, negative: null }),
    {},
  );
  const negative = measurementLaunchEnv({
    bodySeam: true,
    nonce,
    negative: createG01NegativeRun({ id: "K24-G01-N2", root: REPO_ROOT }),
  });
  assert.equal(negative[trigger], "nir1-graph-index-build");
  assert.equal(negative.GRIMODEX_BODY_DECLARATION_CI_NONCE, nonce);
});

// DR-CP4-T-1: the measurement process waits for the product's Freshness to
// reach the cold DB's feed head before the declaration step, the Raw vectors
// and the Chronicle Index (parity-1 G-08/graph-index-unusable: C turned dirty
// at the 12th query when the Freshness acknowledged the setup's last event).

test("DR-CP4-T-1: 落ち着きの判定は ack ≥ head かつ進行中の run も予約も無いときだけで、壊れた読みは落ち着かない", () => {
  const base = {
    head: 22,
    acknowledged: 22,
    activeRun: false,
    reserved: false,
  };
  assert.equal(freshnessSettled(base), true);
  assert.equal(freshnessSettled({ ...base, head: 0, acknowledged: 0 }), true);
  assert.equal(freshnessSettled({ ...base, acknowledged: 21 }), false);
  assert.equal(freshnessSettled({ ...base, activeRun: true }), false);
  assert.equal(freshnessSettled({ ...base, reserved: true }), false);
  for (const bad of [
    null,
    {},
    { ...base, head: Number.NaN },
    { ...base, acknowledged: "22" },
    { ...base, activeRun: undefined },
  ])
    assert.equal(freshnessSettled(bad), false);
});

test("DR-CP4-T-1: Freshness の feed の読取は read-only で、未処理の件数・cursor・進行中の run を返し、製品の WAL の commit を読む", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-t1-feed-"));
  try {
    const at = (name, feed) => {
      const file = path.join(dir, `${name}.db`);
      const db = new DatabaseSync(file);
      writeFeed(db, feed);
      db.close();
      return file;
    };
    // Behind by one sequence of two events (G-08/graph-index-unusable 21／22).
    const behind = at("behind", { head: 22, ack: 21, ordinals: 2 });
    const before = sha256(readFileSync(behind));
    assert.deepEqual(readFreshnessFeed(behind, PROJECT), {
      consumerId: FRESHNESS_CONSUMER_ID,
      head: 22,
      cursor: true,
      acknowledged: 21,
      activeRun: false,
      reserved: false,
      pendingEvents: 2,
      pendingSequences: 1,
    });
    assert.equal(sha256(readFileSync(behind)), before);
    // An empty feed without a cursor is settled; events without one are not.
    const empty = readFreshnessFeed(at("empty", null), PROJECT);
    assert.equal(empty.head, 0);
    assert.equal(empty.cursor, false);
    assert.equal(freshnessSettled(empty), true);
    const noCursor = readFreshnessFeed(
      at("no-cursor", { head: 3, cursor: false }),
      PROJECT,
    );
    assert.equal(noCursor.acknowledged, 0);
    assert.equal(noCursor.pendingEvents, 3);
    assert.equal(freshnessSettled(noCursor), false);
    // A run that reserved the range is in progress even at the head.
    const running = readFreshnessFeed(
      at("running", { head: 5, ack: 5, activeRun: "run-1", reserved: 5 }),
      PROJECT,
    );
    assert.equal(running.activeRun, true);
    assert.equal(running.reserved, true);
    assert.equal(freshnessSettled(running), false);
    // Not immutable: a commit the product's connection left in the WAL is
    // read (the cursor advanced, not yet checkpointed).
    const wal = at("wal", { head: 22, ack: 21 });
    const writer = new DatabaseSync(wal);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer
      .prepare(
        "UPDATE narrative_change_cursors SET acknowledged_through_sequence = 22",
      )
      .run();
    assert.ok(readFileSync(`${wal}-wal`).length > 0);
    assert.equal(readFreshnessFeed(wal, PROJECT).acknowledged, 22);
    writer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-CP4-T-1: 待ちは追いついていればすぐ抜け、cursor が進めば落ち着いた時点で抜け、上限を使い切れば settled: false を返す", async () => {
  const fakeClock = () => {
    let now = 0;
    let sleeps = 0;
    return {
      now: () => now,
      sleep: async (ms) => {
        sleeps += 1;
        if (sleeps > 10_000) throw new Error("the wait never ended");
        now += ms;
      },
      sleeps: () => sleeps,
    };
  };
  const state = (acknowledged, extra = {}) => ({
    head: 22,
    acknowledged,
    activeRun: false,
    reserved: false,
    pendingEvents: 22 - acknowledged,
    ...extra,
  });
  {
    const clock = fakeClock();
    const out = await waitFreshnessSettled({
      read: () => state(22),
      limitMs: 15_000,
      intervalMs: 100,
      ...clock,
    });
    assert.equal(out.settled, true);
    assert.equal(out.polls, 1);
    assert.equal(out.waitedMs, 0);
    assert.equal(clock.sleeps(), 0);
    assert.deepEqual(out.initial, out.final);
  }
  {
    // The cursor advances at the 4th read; a reservation holds it first.
    const clock = fakeClock();
    let reads = 0;
    const out = await waitFreshnessSettled({
      read: () => {
        reads += 1;
        if (reads < 3) return state(21);
        if (reads === 3) return state(21, { activeRun: true, reserved: true });
        return state(22);
      },
      limitMs: 15_000,
      intervalMs: 100,
      ...clock,
    });
    assert.equal(out.settled, true);
    assert.equal(out.polls, 4);
    assert.equal(out.waitedMs, 300);
    assert.equal(out.initial.pendingEvents, 1);
    assert.equal(out.final.pendingEvents, 0);
  }
  {
    const clock = fakeClock();
    const out = await waitFreshnessSettled({
      read: () => state(21),
      limitMs: 15_000,
      intervalMs: 100,
      ...clock,
    });
    assert.equal(out.settled, false);
    assert.equal(out.polls, 151);
    assert.equal(out.waitedMs, 15_000);
    assert.equal(out.limitMs, 15_000);
    assert.equal(out.intervalMs, 100);
    assert.equal(out.final.pendingEvents, 1);
  }
});

/** The test clock ticks the fake product's Freshness timer on each sleep. */
function freshnessClock(ctx, worldOf) {
  const sleep = ctx.clock.sleep;
  ctx.clock.sleep = async (ms) => {
    await sleep(ms);
    worldOf().tick();
  };
}

const graphHeld = {
  kind: "graph-held-unusable",
  holding: true,
  measurementPoint: "while-graph-index-unusable",
  indexState: { graph: "unusable", chronicle: "usable" },
};

test("DR-CP4-T-1: 定常状態の process は Freshness が cold DB の feed を処理して C を汚すまで待ってから C を作り、query の間 C は使えるまま（待たなければ途中で汚れる）", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-08/graph-index-unusable",
    spec: graphHeld,
    metadata: {
      b: { generation: 7, dirty: true },
      chronicle: { generation: 3, dirty: false },
    },
    feed: { head: 22, ack: 21 },
    world: (base) =>
      (world = fakeProduct({
        dir: base,
        // Like parity-1: about 2 s after the launch, or at the 12th query.
        freshness: { atMs: 1_000, atQuery: 12, now: () => ctx.clock.now() },
      })),
  });
  freshnessClock(ctx, () => world);
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(result.samples.length, 70);
    const at = (name) => world.events.indexOf(name);
    assert.ok(at("openWorkspace") < at("freshness:ack"));
    assert.ok(at("freshness:ack") < at("buildRaw"));
    assert.ok(at("freshness:ack") < at("query:index"));
    const queries = result.probes.filter((row) => row.at === "at-query");
    assert.equal(queries.length, 70);
    assert.ok(queries.every((row) => row.indexUsable === true));
    // The probe discloses the wait and the feed at the measurement.
    const before = result.probes[0];
    assert.equal(before.at, "before-measurement");
    const { settle, beforeMeasurement } = before.freshnessFeed;
    assert.equal(settle.settled, true);
    assert.ok(settle.polls > 1);
    assert.equal(settle.limitMs, 15_000);
    assert.equal(settle.intervalMs, 100);
    assert.equal(settle.initial.pendingEvents, 1);
    assert.equal(settle.final.pendingEvents, 0);
    assert.equal(beforeMeasurement.pendingEvents, 0);
    assert.equal(beforeMeasurement.head, 22);
    assert.deepEqual(result.proc.checks.freshnessSettle, before.freshnessFeed);
    // C was rebuilt by the Index build after the invalidation; B is held.
    assert.equal(before.metadata.chronicle.generation, 4);
    assert.equal(before.metadata.b.dirty, true);
    assert.equal(before.metadata.b.generation, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-CP4-T-1: 待ちが上限を使い切れば既存の index-build-timeout（while- は blocked:index-state-holding、ほかは Hold と [precheck]、G-01 も）で、query・宣言・Raw の前に止める", async () => {
  for (const [key, spec, condition, contract, precheck] of [
    [
      "G-08/graph-index-unusable",
      graphHeld,
      "while-variant",
      "index-state-holding",
      false,
    ],
    [
      "G-02/base",
      { declaration: { sceneId: "added-logical" } },
      "other-variant",
      null,
      true,
    ],
    ["G-01/v1", {}, "other-variant", null, true],
  ]) {
    let world;
    const { ctx, dir } = context({
      key,
      spec,
      metadata: steadyState,
      feed: { head: 22, ack: 21 },
      world: (base) =>
        (world = fakeProduct({ dir: base, snapshotUsable: () => true })),
    });
    try {
      const result = await measureVariant(ctx);
      assert.equal(result.status, "blocked", key);
      assert.equal(result.blocked.harnessId, "index-build-timeout");
      assert.equal(result.blocked.condition, condition);
      assert.equal(result.blocked.contractBlockedId, contract);
      assert.equal(result.blocked.hold, contract === null);
      assert.equal(result.blocked.precheck, precheck);
      assert.deepEqual(
        result.blocked.unmetPreconditions,
        contract ? ["index-state-holding"] : [],
      );
      assert.equal(
        world.events.some(
          (row) =>
            row.startsWith("query:") || row === "declare" || row === "buildRaw",
        ),
        false,
        key,
      );
      assert.equal(world.events.at(-1), "stop");
      const settle = result.probe.freshnessFeed.settle;
      assert.equal(settle.settled, false);
      assert.equal(settle.polls, 151);
      assert.equal(settle.limitMs, 15_000);
      assert.equal(settle.final.pendingEvents, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("DR-CP4-T-1: one-shot は process ごとに新しい写しで同じ待ちをし、測る 1 回の query の前に Freshness が処理し終える", async () => {
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
    feed: { head: 22, ack: 21 },
    world: (base) =>
      (world = fakeProduct({
        dir: base,
        freshness: { atMs: 1_000, atQuery: 1, now: () => ctx.clock.now() },
      })),
  });
  freshnessClock(ctx, () => world);
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "measured");
    assert.equal(world.launches(), 70);
    const processes = [];
    for (const event of world.events) {
      if (event === "launch") processes.push([]);
      else processes.at(-1).push(event);
    }
    for (const events of processes) {
      const ack = events.indexOf("freshness:ack");
      const query = events.findIndex((row) => row.startsWith("query:"));
      assert.ok(ack >= 0 && ack < query);
    }
    const before = result.probes.filter(
      (row) => row.at === "before-measurement",
    );
    assert.equal(before.length, 70);
    assert.ok(
      before.every(
        (row) =>
          row.freshnessFeed.settle.settled === true &&
          row.freshnessFeed.settle.initial.pendingEvents === 1 &&
          row.freshnessFeed.beforeMeasurement.pendingEvents === 0,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-CP4-T-1（帰結）: B が使える variant の cold DB に未処理のイベントがあれば、Freshness が B を汚した後の probe が blocked:b-sealed-binding で止める（汚れた B の Graph arm を測らない）", async () => {
  let world;
  const { ctx, dir } = context({
    key: "G-02/base",
    spec: {},
    metadata: steadyState,
    feed: { head: 31, ack: 29 },
    world: (base) =>
      (world = fakeProduct({
        dir: base,
        freshness: { atMs: 1_000, atQuery: 12, now: () => ctx.clock.now() },
      })),
  });
  freshnessClock(ctx, () => world);
  try {
    const result = await measureVariant(ctx);
    assert.equal(result.status, "blocked");
    assert.equal(result.blocked.harnessId, "measurement-point-mismatch");
    assert.equal(result.blocked.condition, "graph");
    assert.equal(result.blocked.contractBlockedId, "b-sealed-binding");
    assert.equal(result.probe.freshnessFeed.settle.settled, true);
    assert.equal(result.probe.freshnessFeed.settle.initial.pendingEvents, 2);
    assert.equal(world.events.includes("query:graph"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
