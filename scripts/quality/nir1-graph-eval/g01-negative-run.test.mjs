// DR-CP4-O-16: A の runner が呼ぶ K24-G01-N2〜N4 の hook（g01-negative-run.mjs）。
// 偽の page と使い捨ての SQLite で、宣言の前後の段、Main の開き直し、graph の
// sample の聞き直し、照合と結果を確かめる（Electron を起動しない）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  G01_CONTROL_ATTEMPTS,
  G01_CONTROL_GAP_MS,
  G01_SAMPLE_ATTEMPTS,
} from "./g01-negatives.mjs";
import { createG01NegativeRun, rowProbeOf } from "./g01-negative-run.mjs";
import { TRACE_MAINTENANCE_SEAM } from "./trace-record.mjs";
import { INDEX_KEYS } from "./workspace-db.mjs";
import { REPO_ROOT } from "./test-support.mjs";

const TARGET = {
  caseId: "G-01",
  variantId: "v1",
  sceneId: "g01-mira",
  entityId: "g01-mira-entity",
  seedEntityId: "g01-orin",
  querySceneId: "g01-query",
};
const IDS = {
  projectId: "p",
  querySceneId: "s-query",
  scenes: { "g01-mira": "s-mira", "g01-query": "s-query" },
  entities: { "g01-orin": "e-orin", "g01-mira-entity": "e-mira" },
};

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "s5b-neg-run-"));
  const file = path.join(dir, "grimodex.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT, sort_order TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT, type TEXT);
    CREATE TABLE codex_relations (id TEXT, project_id TEXT, from_codex_id TEXT, to_codex_id TEXT, relation_type TEXT);
    CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
    CREATE TABLE narrative_semantic_index_metadata (project_id TEXT, index_key TEXT, generation INTEGER, dirty_cache_flag INTEGER, source_digest TEXT, dependency_set_digest TEXT, producer_id TEXT, producer_version TEXT);
  `);
  db.prepare(
    "INSERT INTO tree_nodes VALUES ('s-query', 'p', 'scene', NULL, 'a')",
  ).run();
  db.prepare(
    "INSERT INTO tree_nodes VALUES ('s-mira', 'p', 'scene', NULL, 'b')",
  ).run();
  for (const id of ["e-orin", "e-mira"])
    db.prepare("INSERT INTO codex_entries VALUES (?, 'p', 'character')").run(
      id,
    );
  db.prepare(
    "INSERT INTO scene_codex_pins VALUES ('s-query', 'e-orin', '2026-10-28T00:00:00Z')",
  ).run();
  for (const [key, generation] of [
    [INDEX_KEYS.b, 4],
    [INDEX_KEYS.chronicle, 2],
  ])
    db.prepare(
      "INSERT INTO narrative_semantic_index_metadata VALUES ('p', ?, ?, 0, NULL, NULL, NULL, NULL)",
    ).run(key, generation);
  db.close();
  const set = (key, generation, dirty) => {
    const handle = new DatabaseSync(file);
    handle
      .prepare(
        "UPDATE narrative_semantic_index_metadata SET generation = ?, dirty_cache_flag = ? WHERE index_key = ?",
      )
      .run(generation, dirty ? 1 : 0, key);
    handle.close();
  };
  return { dir, file, set };
}

function fakeSession(label, handlers, events) {
  const page = {
    evaluate: async (fn, arg) => {
      globalThis.window = {
        cp4Harness: {
          diagnostic: new Proxy(
            {},
            {
              get: (_, name) => async (input) => {
                events.push(`${label}:${String(name)}`);
                return handlers[name](input);
              },
            },
          ),
          buildIndex: async () => {
            events.push(`${label}:buildIndex`);
            return handlers.buildIndex?.() ?? { ok: true };
          },
        },
      };
      try {
        return await fn(arg);
      } finally {
        delete globalThis.window;
      }
    },
  };
  return {
    label,
    page,
    addon: async () =>
      JSON.stringify({ begins: 1, cacheHits: 0, lateCached: 0 }),
  };
}

const reachedProbe = () => ({
  ok: true,
  value: {
    parent: {
      graphOutcome: "graph-ready",
      graphOnly: {
        sceneId: "s-mira",
        pinEntityId: "e-mira",
        edges: [{ from: "e-orin", to: "e-mira" }],
      },
    },
    child: null,
  },
});

test("O-16: 起動の env に B-ROUTE の seam を重ね、graph の sample は中立の間だけ聞き直して決まった sample を返す", async () => {
  const run = createG01NegativeRun({ id: "K24-G01-N2", target: TARGET });
  const env = run.launchEnv({ CI: "true" });
  assert.equal(
    env[TRACE_MAINTENANCE_SEAM.triggerEnv],
    TRACE_MAINTENANCE_SEAM.trigger,
  );
  const outcomes = ["graph-late", "graph-late", "graph-ready"];
  let takes = 0;
  run.state.readCounters = async () => ({
    begins: 0,
    cacheHits: 0,
    lateCached: 0,
  });
  const taken = await run.askGraph(async () => {
    takes += 1;
    return {
      row: {
        phase: "measured",
        repeat: 0,
        arm: "graph",
        graph: { outcome: "graph-late" },
        followUp: { child: { outcome: outcomes.shift() } },
      },
    };
  });
  assert.equal(takes, 3);
  assert.equal(taken.row.followUp.child.outcome, "graph-ready");
  assert.deepEqual(taken.row.negativeRetry, {
    limit: G01_SAMPLE_ATTEMPTS,
    gapMs: G01_CONTROL_GAP_MS,
  });
  assert.equal(run.state.graphTries[0].tries.length, 3);
  // 捨てた take は件数と理由を残す。
  assert.equal(run.state.graphTries[0].discardedTakes, 2);
  assert.deepEqual(
    run.state.graphTries[0].discarded.map((row) => [
      row.reason,
      row.childOutcome,
    ]),
    [
      ["neutral-answer", "graph-late"],
      ["neutral-answer", "graph-late"],
    ],
  );
  assert.deepEqual(rowProbeOf({ graph: { outcome: "graph-ready" } }), {
    parent: { graphOutcome: "graph-ready" },
    child: null,
  });
});

test("O-16: 宣言の前の段（N2 は何もしない、N3 は版を用意、作れなければ blocked で止める）と、凍結した G-01 の対象", async () => {
  const ws = workspace();
  try {
    const events = [];
    const session = fakeSession(
      "s0",
      {
        sameBytesVersion: () => ({
          ok: true,
          value: { revisionId: "v1", sha256: "o" },
        }),
      },
      events,
    );
    const proc = { session, dbPath: ws.file };
    const n2 = createG01NegativeRun({ id: "K24-G01-N2", root: REPO_ROOT });
    assert.equal(n2.state.target.entityId, "g01-mira-entity");
    assert.equal(
      await n2.beforeDeclaration({ page: session.page, ids: IDS, proc }),
      null,
    );
    const n3 = createG01NegativeRun({ id: "K24-G01-N3", target: TARGET });
    assert.equal(
      await n3.beforeDeclaration({ page: session.page, ids: IDS, proc }),
      null,
    );
    assert.equal(n3.state.before.prepared.revisionId, "v1");
    const failing = fakeSession(
      "s1",
      {
        sameBytesVersion: () => ({ ok: false, error: "no version" }),
      },
      events,
    );
    const bad = createG01NegativeRun({ id: "K24-G01-N3", target: TARGET });
    await assert.rejects(
      bad.beforeDeclaration({
        page: failing.page,
        ids: IDS,
        proc: { ...proc, session: failing },
      }),
      (error) => error.negativeBlocked?.reason === "before-declaration",
    );
    assert.throws(
      () => createG01NegativeRun({ id: "K24-G01-N1", target: TARGET }),
      /\[precheck\]/u,
    );
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test("O-16: 宣言の後は対照・mutation・Main の開き直し（新しい封印と Chronicle）・SP-P1 を行い、開き直した session を返し、照合で結果を出す", async () => {
  const ws = workspace();
  try {
    const events = [];
    const handlers = {
      graphProbe: reachedProbe,
      resaveBody: () => {
        ws.set(INDEX_KEYS.b, 4, true);
        return {
          ok: true,
          value: {
            before: { sha256: "o", version: 1 },
            after: { sha256: "o", version: 2 },
          },
        };
      },
    };
    const first = fakeSession("s0", handlers, events);
    const proc = { session: first, dbPath: ws.file };
    const run = createG01NegativeRun({ id: "K24-G01-N2", target: TARGET });
    let opened = 0;
    const relaunch = async (label) => {
      opened += 1;
      events.push(`launch:${label}`);
      ws.set(INDEX_KEYS.b, 5, false);
      const reopened = fakeSession(label, handlers, events);
      reopened.addon = async () =>
        JSON.stringify({ begins: 9, cacheHits: 0, lateCached: 0 });
      return reopened;
    };
    const stopped = [];
    const session = await run.afterDeclaration({
      page: first.page,
      ids: IDS,
      proc,
      relaunch,
      stop: async (value) => stopped.push(value?.label ?? null),
    });
    assert.equal(session.label, "measure-reopen-0");
    assert.equal(opened, 1);
    // DR-CP4-Q-1 (P3-2): askGraph reads the counters of the reopened Main.
    assert.deepEqual(await run.state.readCounters(), {
      begins: 9,
      cacheHits: 0,
      lateCached: 0,
    });
    assert.equal(run.state.ids, IDS);
    assert.deepEqual(stopped, ["s0"]);
    assert.equal(run.state.control.status, "reached");
    assert.equal(run.state.step.spP1Recheck.status, "match");
    assert.equal(run.state.step.sealAttempts[0].outcome, "sealed");
    assert.ok(
      events.indexOf("s0:graphProbe") < events.indexOf("s0:resaveBody"),
    );
    assert.ok(
      events.indexOf("s0:resaveBody") <
        events.indexOf("launch:measure-reopen-0"),
    );
    assert.ok(events.includes("measure-reopen-0:buildIndex"));
    // The measurement point is the reopened Main's seal.
    assert.deepEqual(run.measurementProbe({ bGeneration: 4, other: 1 }), {
      bGeneration: 5,
      chronicleGeneration: 2,
      other: 1,
      negativeReopen: true,
    });
    const row = (repeat, final) => ({
      phase: "measured",
      repeat,
      arm: "graph",
      followUp: { parent: { seed: "e-orin" }, child: null },
      graph: { outcome: "graph-ready" },
      a3AtStart: { eligible: true },
      finalSceneIds: final,
      negativeRetry: { limit: G01_SAMPLE_ATTEMPTS, gapMs: G01_CONTROL_GAP_MS },
    });
    const assessed = run.assess({
      samples: [row(0, ["s-query"]), row(1, ["s-query"])],
      ids: IDS,
    });
    assert.equal(assessed.assessment.outcome, "established");
    assert.equal(
      assessed.samples.every((entry) => entry.frameReached),
      true,
    );
    assert.equal(
      run.assess({ samples: [row(0, ["s-mira"])], ids: IDS }).assessment
        .outcome,
      "not-established",
    );
    // 上限が定数でない sample は照合で止める。
    assert.throws(
      () =>
        run.assess({
          samples: [{ ...row(0, []), negativeRetry: { limit: 5, gapMs: 250 } }],
          ids: IDS,
        }),
      /\[precheck\]/u,
    );
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test("Q-1（P3-2）: graph の sample の聞き直しは全回の owner の counter の差分と cached を記録し、捨てた take の返却 Scene を残す（判定には使わない）", async () => {
  const run = createG01NegativeRun({ id: "K24-G01-N2", target: TARGET });
  // counter を読めない（afterDeclaration の前）なら聞かない。
  await assert.rejects(
    run.askGraph(async () => ({ row: {} })),
    /\[artifact\].*counter/u,
  );
  let reads = 0;
  const steps = [
    { begins: 0, cacheHits: 0, lateCached: 0 },
    { begins: 1, cacheHits: 0, lateCached: 0 },
    { begins: 1, cacheHits: 0, lateCached: 0 },
    { begins: 2, cacheHits: 1, lateCached: 0 },
  ];
  run.state.readCounters = async () => steps[Math.min(reads++, 3)];
  run.state.ids = IDS;
  const outcomes = ["graph-late", "graph-ready"];
  const finals = [
    ["s-query", "s-mira"],
    ["s-query", "s-other"],
  ];
  await run.askGraph(async () => ({
    row: {
      phase: "measured",
      repeat: 3,
      arm: "graph",
      graph: { outcome: outcomes.shift() },
      finalSceneIds: finals.shift(),
      followUp: { child: null },
    },
  }));
  const tries = run.state.graphTries[0];
  assert.deepEqual([tries.phase, tries.repeat], ["measured", 3]);
  assert.deepEqual(
    tries.tries.map((row) => [row.counters, row.cached]),
    [
      [{ begins: 1, cacheHits: 0, lateCached: 0 }, false],
      [{ begins: 1, cacheHits: 1, lateCached: 0 }, true],
    ],
  );
  // 捨てた回に宣言の Scene（g01-mira）が出たかを開示する。
  assert.deepEqual(tries.discarded[0].returnedSceneIds, [
    "g01-query",
    "g01-mira",
  ]);
  assert.equal(tries.discarded[0].declaredSceneReturned, true);
  // 決まった sample の照合は捨てた回の Scene を使わない。
  run.state.control = {
    retry: { limit: G01_CONTROL_ATTEMPTS, gapMs: G01_CONTROL_GAP_MS },
  };
  assert.equal(
    run
      .assess({
        samples: [
          {
            phase: "measured",
            repeat: 3,
            arm: "graph",
            followUp: { parent: { seed: "e-orin" }, child: null },
            graph: { outcome: "graph-ready" },
            finalSceneIds: ["s-query"],
            negativeRetry: {
              limit: G01_SAMPLE_ATTEMPTS,
              gapMs: G01_CONTROL_GAP_MS,
            },
          },
        ],
        ids: IDS,
      })
      .samples[0].returnedSceneIds.includes("g01-mira"),
    false,
  );
});
