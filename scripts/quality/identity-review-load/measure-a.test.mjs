// 測定 A の駆動の試験（fake の page。Electron・AI は使わない）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRosterIndex } from "./measure-a-metrics.mjs";
import {
  cellStatus,
  measureABody,
  planCells,
  registrationEntries,
  runCompleted,
} from "./run-measure-a.mjs";

const roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [
        { surface: "al", level: "L2" },
        { surface: "a", level: "L1" },
      ],
    },
    { id: "e2", type: "location", name: "beta", aliases: [] },
    {
      id: "e3",
      type: "other",
      name: "gamma",
      aliases: [{ surface: "gm", level: "L3" }],
    },
  ],
};

test("planCells：4 作品で 47 run・35 process（§5 の表）", () => {
  const cells = planCells(["g-ja-2", "g-ja-3", "g-ja-4", "m-ja-2"]);
  assert.equal(cells.length, 35);
  assert.equal(
    cells.reduce((n, c) => n + c.steps.length, 0),
    47,
  );
  const g = planCells(["g-ja-2"]);
  assert.equal(g.length, 8); // 行列 5・基準・決定性・累積
  assert.deepEqual(
    g.find((c) => c.kind === "cumulative").steps,
    [25, 50, 75, 100],
  );
  assert.equal(g.find((c) => c.kind === "baseline").level, null);
  // 単独は m-ja-2 だけ。
  assert.equal(
    planCells(["m-ja-2"]).filter((c) => c.kind === "solo").length,
    3,
  );
  assert.equal(
    planCells(["g-ja-2"]).filter((c) => c.kind === "solo").length,
    0,
  );
  // 絞り込み。
  assert.deepEqual(
    planCells(["g-ja-2"], { only: ["matrix-L2", "empty"] }).map((c) => c.id),
    ["g-ja-2-matrix-L2", "g-ja-2-empty"],
  );
});

test("registrationEntries：段ごとの登録。型は Codex の型。空の基準は 0 件", () => {
  const l0 = registrationEntries(roster, "L0");
  assert.deepEqual(
    l0.map((e) => [e.id, e.type, e.aliases.length]),
    [
      ["e1", "character", 0],
      ["e2", "location", 0],
      ["e3", "lore", 0],
    ],
  );
  assert.deepEqual(
    registrationEntries(roster, "L2")
      .find((e) => e.id === "e1")
      .aliases.sort(),
    ["a", "al"],
  );
  assert.deepEqual(
    registrationEntries(roster, "L3").find((e) => e.id === "e3").aliases,
    ["gm"],
  );
  // L2-1char は 1 字の別名を除く。
  assert.deepEqual(
    registrationEntries(roster, "L2-1char").find((e) => e.id === "e1").aliases,
    ["al"],
  );
  assert.deepEqual(registrationEntries(roster, null), []);
});

function fakePage(calls, { createdOverride } = {}) {
  const api = {
    registerRoster: async (input) => {
      calls.push(["register", input.entries.length]);
      return { created: createdOverride ?? input.entries.length };
    },
    extractStructure: async (input) => {
      calls.push(["extract", input.folderPercent, input.persist]);
      return {
        folderPercent: input.folderPercent,
        observed: { prepass: { status: "complete" } },
        entityProposalCount: 1,
        rows: [
          {
            keyHash: "x1",
            bindingKind: "create-new",
            scenes: [[1, 1]],
            coarseClass: "person",
            candidates: [],
            typeStatus: "resolved",
            status: "unreviewed",
            bulkApprovable: true,
          },
        ],
      };
    },
  };
  globalThis.window = { identityLoad: api };
  return { evaluate: async (fn, arg) => fn(arg) };
}

test("measureABody：累積の列は同じ workspace で F25→F50→F75→F100 を順に流し、決定を入れない", async () => {
  const calls = [];
  const page = fakePage(calls);
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: "L2", steps: [25, 50, 75, 100] },
    persist: "skip",
  });
  assert.deepEqual(calls, [
    ["register", 3],
    ["extract", 25, false],
    ["extract", 50, false],
    ["extract", 75, false],
    ["extract", 100, false],
  ]);
  assert.deepEqual(
    out.runs.map((r) => r.label),
    ["F25", "F50", "F75", "F100"],
  );
  assert.ok(
    out.runs.every(
      (r) => r.completed && r.persistAttempt.status === "not-attempted",
    ),
  );
  assert.equal(out.runs[0].metrics.categoryCounts.notInRoster, 1);
});

test("measureABody：空の基準は登録せず、persist=try は保存を試す（失敗したら理由の code で skip に落とす）", async () => {
  const calls = [];
  const page = fakePage(calls);
  const index = await buildRosterIndex(roster, async (s) => s);
  await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
  });
  assert.deepEqual(calls, [["extract", 100, false]]);
  // try：1 回目（persist:true）が失敗する fake。
  const calls2 = [];
  globalThis.window = {
    identityLoad: {
      registerRoster: async () => ({ created: 0 }),
      extractStructure: async (input) => {
        calls2.push(input.persist);
        if (input.persist) throw new Error("[x] NATIVE_PERSIST_FAILED code=7");
        return {
          observed: { prepass: { status: "complete" } },
          entityProposalCount: 1,
          rows: [],
        };
      },
    },
  };
  const out = await measureABody({
    page: { evaluate: async (fn, arg) => fn(arg) },
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
    persist: "try",
  });
  assert.deepEqual(calls2, [true, false]);
  assert.equal(out.runs[0].persistAttempt.status, "failed");
  assert.ok(out.runs[0].persistAttempt.codes.includes("NATIVE_PERSIST_FAILED"));
});

test("measureABody：登録の件数が違えば止まる", async () => {
  const page = fakePage([], { createdOverride: 1 });
  const index = await buildRosterIndex(roster, async (s) => s);
  await assert.rejects(
    measureABody({
      page,
      projectId: "p",
      roster,
      index,
      cell: { level: "L0", steps: [100] },
    }),
    /REGISTRATION_COUNT_DIFFERS/u,
  );
});

test("runCompleted／cellStatus：prepass が complete でない run・提案 0 件・AI の痕跡は採用しない", () => {
  assert.equal(
    runCompleted({
      observed: { prepass: { status: "complete" } },
      entityProposalCount: 3,
    }),
    true,
  );
  assert.equal(
    runCompleted({
      observed: { prepass: { status: "failed" } },
      entityProposalCount: 3,
    }),
    false,
  );
  assert.equal(
    runCompleted({
      observed: { prepass: { status: "complete" } },
      entityProposalCount: 0,
    }),
    false,
  );
  const good = {
    ipc: { commandNames: ["codex_create"] },
    aiRows: { verified: true, tables: { ai_usage: 0, ai_audit_events: 0 } },
    egress: { nonLoopbackDestinationCount: 0, sampleCount: 5 },
  };
  const value = {
    runs: [{ completed: true, persistAttempt: { status: "not-attempted" } }],
  };
  assert.equal(cellStatus(good, value), "ok");
  assert.equal(
    cellStatus(
      { ...good, ipc: { commandNames: ["send_chat_message"] } },
      value,
    ),
    "ai-detected",
  );
  assert.equal(
    cellStatus(
      { ...good, aiRows: { verified: true, tables: { ai_usage: 1 } } },
      value,
    ),
    "ai-detected",
  );
  assert.equal(
    cellStatus({ ...good, aiRows: { verified: false, tables: {} } }, value),
    "ai-unverified",
  );
  assert.equal(
    cellStatus(
      { ...good, egress: { nonLoopbackDestinationCount: 1, sampleCount: 5 } },
      value,
    ),
    "egress-detected",
  );
  assert.equal(
    cellStatus(good, {
      runs: [{ completed: false, persistAttempt: { status: "not-attempted" } }],
    }),
    "extract-unverified",
  );
});
