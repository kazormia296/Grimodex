// 測定 A の駆動の試験（fake の page。Electron・AI は使わない）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertOutputClean,
  classifyS5Surfaces,
  planStoredRuns,
  summarizeStoredProposals,
} from "./lib.mjs";
import { buildRosterIndex } from "./measure-a-metrics.mjs";
import {
  clearPreviousInventoryOutputs,
  readWorkSource,
  sha256Text,
  surfacesFileWithProvenance,
} from "./sources.mjs";
import {
  cellStatus,
  candidateFileState,
  loadCandidates,
  loadCandidateHashes,
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
        counts: { bulkApprovable: 1 }, // 下の 1 行（bulkApprovable: true）と同じ数
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
          counts: { bulkApprovable: 0 },
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

test("cell の dir の名前は、起動前の検査が測る長さに収まり、既定の出力先は検査を通る", async () => {
  const path = await import("node:path");
  const { planCells: plan } = await import("./run-measure-a.mjs");
  const { WORKS } = await import("./lib.mjs");
  const { B1_LEVELS } = await import("./run-measure-b.mjs");
  const { cellDirName } = await import("./launcher-common.mjs");
  const { LONGEST_CELL_DIR_NAME, MAX_SOCKET_PATH_ESTIMATE } =
    await import("./run-inventory.mjs");
  const works = Object.keys(WORKS);
  // A：runCell は `A-${cell.id}` を cellDirName で dir の名前にする。solo は全作品で作って最長を測る。
  const aIds = plan(works, { soloWorks: works, only: null }).map(
    (cell) => `A-${cell.id}`,
  );
  // B：`B-${mode}-${work}-${level}` と乾いた実行の `B-dry-${work}`。
  const bIds = works.flatMap((work) => [
    `B-dry-${work}`,
    ...["trial", "b1", "b2"].flatMap((mode) =>
      B1_LEVELS.map((level) => `B-${mode}-${work}-${level}`),
    ),
  ]);
  const ids = [...aIds, ...bIds];
  const names = ids.map(cellDirName);
  assert.ok(aIds.length > 0 && bIds.length > 0);
  // 名前は互いに重ならず、後始末が見分ける接頭辞（B- と B-dry-）を保つ。
  assert.equal(new Set(names).size, ids.length);
  ids.forEach((id, i) => {
    assert.equal(id.startsWith("B-dry-"), names[i].startsWith("B-dry-"));
    assert.equal(id.slice(0, 2), names[i].slice(0, 2));
  });
  // 目録の dir（`${mode}-${work}`）も含めて最長を測る。
  const inventoryNames = works.flatMap((work) =>
    ["inventory", "extract-empty"].map((mode) => `${mode}-${work}`),
  );
  const longest = Math.max(
    ...[...names, ...inventoryNames].map((n) => n.length),
  );
  assert.ok(
    longest <= LONGEST_CELL_DIR_NAME,
    `longest cell dir name ${longest} > ${LONGEST_CELL_DIR_NAME}`,
  );
  // 既定の出力先で、検査の式が上限に収まる。
  const estimate = path.join(
    "/home/grimodex/identity-review-load-2026-11",
    "run",
    "x".repeat(LONGEST_CELL_DIR_NAME),
    "user-data",
    "SingletonSocket",
  ).length;
  assert.ok(estimate <= MAX_SOCKET_PATH_ESTIMATE, `default output ${estimate}`);
  assert.throws(() => cellDirName("C-x"), /CELL_ID_PREFIX/u);
});

test("measureABody：renderer の一括承認可の数と metrics の合計が違えば止まる。seedDrops は metrics に記録する", async () => {
  const index = await buildRosterIndex(roster, async (s) => s);
  const withExtract = (extra) => {
    globalThis.window = {
      identityLoad: {
        registerRoster: async (input) => ({ created: input.entries.length }),
        extractStructure: async () => ({
          observed: { prepass: { status: "complete" } },
          entityProposalCount: 2,
          ...extra,
          rows: [
            {
              keyHash: "alpha",
              bindingKind: "bind-existing",
              bindExistingEntityId: "e1",
              scenes: [[1, 1]],
              coarseClass: "person",
              candidates: [],
              typeStatus: "resolved",
              status: "unreviewed",
              bulkApprovable: true,
            },
            {
              keyHash: "zzz",
              bindingKind: "create-new",
              scenes: [[1, 1]],
              coarseClass: "person",
              candidates: [],
              typeStatus: "resolved",
              status: "unreviewed",
              bulkApprovable: true,
            },
          ],
        }),
      },
    };
    return { evaluate: async (fn, arg) => fn(arg) };
  };
  const input = (page) => ({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
  });
  const seedDrops = { relationalTerms: 3, foldedDismissed: 0 };
  const out = await measureABody(
    input(withExtract({ counts: { bulkApprovable: 2 }, seedDrops })),
  );
  const m = out.runs[0].metrics;
  assert.equal(m.bulkApprovable.total, 2);
  assert.equal(m.categoryCounts.bulkBind, 1);
  assert.equal(m.categoryCounts.notInRoster, 1);
  assert.deepEqual(m.seedDrops, seedDrops);
  await assert.rejects(
    measureABody(input(withExtract({ counts: { bulkApprovable: 3 } }))),
    /BULK_APPROVABLE_COUNT_DIFFERS renderer=3 metrics=2/u,
  );
  // renderer の数が無い（undefined・非整数）なら照合できないので、黙って飛ばさず止める（fail-closed）。
  for (const missing of [
    {},
    { counts: {} },
    { counts: { bulkApprovable: "2" } },
  ])
    await assert.rejects(
      measureABody(input(withExtract(missing))),
      /BULK_APPROVABLE_COUNT_MISSING/u,
    );
});

/**
 * 保存つきの fake の page。persist:true の抽出が「DB」に run を足し、readStoredProposals は renderer と同じく
 * 今回の run（最後に保存した run）とそれ以外を分けて、本物の純関数で件数に縮約する。
 */
function fakeStoredPage({
  readFails = false,
  persistFails = false,
  unlisted = [],
  // run を保存した後で、その段が失敗する folder（renderer の extractStructure は、この run を採用しない）。
  failAfterRunSteps = [],
} = {}) {
  const db = []; // 保存済みの run（古い順）。
  const adopted = []; // db と同じ並び。その段が成功して採用された run か。
  const reads = [];
  const entityCountOfStep = { 25: 2, 50: 3, 75: 4, 100: 5 };
  globalThis.window = {
    identityLoad: {
      registerRoster: async (input) => ({ created: input.entries.length }),
      extractStructure: async (input) => {
        if (input.persist && persistFails)
          throw new Error("[x] NATIVE_PERSIST_FAILED code=7");
        const n = entityCountOfStep[input.folderPercent];
        if (input.persist) {
          db.push(
            Array.from({ length: n }, () => ({
              kind: "codex.entity.bind",
              status: "unreviewed",
              applied: false,
            })),
          );
          const failsAfterRun = failAfterRunSteps.includes(input.folderPercent);
          adopted.push(!failsAfterRun);
          if (failsAfterRun)
            throw new Error("[artifact] SEED_PROPOSAL_SET_DIFFERS seedOnly=1");
        }
        return {
          folderPercent: input.folderPercent,
          observed: { prepass: { status: "complete" } },
          entityProposalCount: n,
          relationProposalCount: 0,
          baseDetailProposalCount: 0,
          phaseProposalCount: 0,
          counts: { bulkApprovable: 0 },
          rows: [],
        };
      },
      readStoredProposals: async () => {
        reads.push(db.length);
        if (readFails) throw new Error("[x] NATIVE_READ_FAILED code=9");
        // renderer と同じ組み立て：製品の列挙（新しい順。unlisted の run は落ちる）に、保存した run を足す。
        const ids = db.map((_, i) => `run-${i}`);
        const listedIds = [...ids]
          .reverse()
          .filter((id) => !unlisted.includes(id));
        const runs = planStoredRuns({
          listedIds,
          trackedIds: ids.filter((_, i) => adopted[i]),
          failedIds: ids.filter((_, i) => !adopted[i]),
        }).map((plan) => ({
          ...plan,
          runStatus: "completed",
          setStatus: "draft",
          proposals: db[ids.indexOf(plan.runId)],
        }));
        return summarizeStoredProposals({
          runs,
          listedCount: listedIds.length,
        });
      },
    },
  };
  return { page: { evaluate: async (fn, arg) => fn(arg) }, reads };
}

test("measureABody：保存つき（try）の累積の列は、段ごとに保存済みの未 review の件数を読み、前の回の run の分を分けて持つ", async () => {
  const { page, reads } = fakeStoredPage();
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [25, 50, 75, 100] },
    persist: "try",
  });
  assert.deepEqual(reads, [1, 2, 3, 4]);
  const stored = out.runs.map((r) => r.storedUnreviewed);
  assert.ok(stored.every((v) => v.status === "measured"));
  // 前の回の run の未 review が、決定なしのまま段ごとに積み上がる（2、2+3、2+3+4）。
  assert.deepEqual(
    stored.map((v) => v.unreviewed.priorRuns),
    [0, 2, 5, 9],
  );
  assert.deepEqual(
    stored.map((v) => v.unreviewed.currentRun),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    stored.map((v) => v.unreviewed.total),
    [2, 5, 9, 14],
  );
  // 同じ段の projection の件数と合う（道具の読みの検査）。
  assert.ok(stored.every((v) => v.projectionCheck.ok === true));
  // 件数と製品の語だけ。原稿の語が混ざらない。
  for (const run of out.runs) assertOutputClean(run.storedUnreviewed, ["昔々"]);
});

test("measureABody：途中の段が run を保存した後で失敗しても、その run は次の段の前の回の run に数えず、採用しなかった run として別に数える", async () => {
  const { page } = fakeStoredPage({ failAfterRunSteps: [50] });
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [25, 50, 75] },
    persist: "try",
  });
  const [s25, s50, s75] = out.runs.map((r) => r.storedUnreviewed);
  assert.equal(out.runs[1].persistAttempt.status, "failed");
  // F50 の保存は失敗した段なので読まない（未計測）。
  assert.equal(s50.status, "not-measured");
  assert.equal(s50.reason, "persist-failed");
  // F75：今回 4 件、前の回は採用した F25 の 2 件だけ。失敗した F50 の run の 3 件は採用しなかった run として別。
  assert.equal(s75.unreviewed.currentRun, 4);
  assert.equal(s75.unreviewed.priorRuns, s25.unreviewed.currentRun);
  assert.equal(s75.unreviewed.priorRuns, 2);
  assert.equal(s75.unreviewed.notAdoptedRuns, 3);
  assert.equal(s75.unreviewed.total, 9);
  assert.equal(s75.failedStageRunCount, 1);
  assert.equal(s75.priorRunCount, 1);
});

test("measureABody：製品の列挙から前の段の run が落ちても、保存した run を読んで前の回の未 review に数える", async () => {
  const { page } = fakeStoredPage({ unlisted: ["run-0"] });
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [25, 50, 75] },
    persist: "try",
  });
  const stored = out.runs.map((r) => r.storedUnreviewed);
  // run-0（F25 の 2 件）は一覧に無いが、F50 以降も前の回に数える（2、2+3）。
  assert.deepEqual(
    stored.map((v) => v.unreviewed.priorRuns),
    [0, 2, 5],
  );
  assert.deepEqual(
    stored.map((v) => v.trackedNotListedByProductCount),
    [1, 1, 1],
  );
});

test("measureABody：保存しない段は 0 件でなく未計測（読みに行かない）。保存の失敗も未計測", async () => {
  const skip = fakeStoredPage();
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page: skip.page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
    persist: "skip",
  });
  assert.deepEqual(skip.reads, []);
  assert.deepEqual(out.runs[0].storedUnreviewed, {
    status: "not-measured",
    reason: "persist-skipped",
  });
  const failed = fakeStoredPage({ persistFails: true });
  const out2 = await measureABody({
    page: failed.page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
    persist: "try",
  });
  assert.deepEqual(failed.reads, []);
  assert.equal(out2.runs[0].storedUnreviewed.reason, "persist-failed");
});

test("measureABody：読みの失敗は理由だけ記録し、run の採用（completed）を落とさない", async () => {
  const { page } = fakeStoredPage({ readFails: true });
  const index = await buildRosterIndex(roster, async (s) => s);
  const out = await measureABody({
    page,
    projectId: "p",
    roster,
    index,
    cell: { level: null, steps: [100] },
    persist: "try",
  });
  const stored = out.runs[0].storedUnreviewed;
  assert.equal(stored.status, "not-measured");
  assert.equal(stored.reason, "read-failed");
  assert.ok(stored.error.codes.includes("NATIVE_READ_FAILED"));
  assert.equal(out.runs[0].completed, true);
});

test("cellStatus：保存済みの提案を読む command が IPC に載っても、AI の痕跡にならない", () => {
  const good = {
    ipc: {
      commandNames: [
        "narrative_extraction_claim_task",
        "narrative_extraction_list_resumable_runs",
        "narrative_extraction_get_run_review_bundle",
        "narrative_extraction_get_run",
      ],
    },
    aiRows: { verified: true, tables: { ai_usage: 0, ai_audit_events: 0 } },
    egress: { nonLoopbackDestinationCount: 0, sampleCount: 5 },
  };
  const value = {
    runs: [{ completed: true, persistAttempt: { status: "ok" } }],
  };
  assert.equal(cellStatus(good, value), "ok");
});

// ---- DR-ILM-38：S5 の hash を renderer へ渡し、内訳（件数だけ）を metrics に載せる -------------------------------------

const s5Roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [],
      ambiguousSurfaces: [
        { surface: "swap", sceneRanges: [[1, 3]] },
        { surface: "move", sceneRanges: [[1, 3]] },
      ],
    },
    {
      id: "e2",
      type: "character",
      name: "beta",
      aliases: [],
      ambiguousSurfaces: [
        { surface: "swap", sceneRanges: [[4, 9]] },
        { surface: "third", sceneRanges: [[1, 9]] },
      ],
    },
  ],
};

function s5Page(inputs) {
  const rows = [
    {
      surfaceHash: "swap",
      keyHash: "swap",
      bindingKind: "create-new",
      scenes: [],
      coarseClass: "person",
      candidates: [],
      typeStatus: "resolved",
      status: "unreviewed",
      bulkApprovable: false,
    },
  ];
  globalThis.window = {
    identityLoad: {
      registerRoster: async (input) => ({ created: input.entries.length }),
      // renderer の代わり：host が渡した S5 の hash と、seed の集合（move・swap）から、件数だけ返す。
      extractStructure: async (input) => {
        inputs.push(input);
        return {
          observed: { prepass: { status: "complete" } },
          entityProposalCount: 1,
          counts: { bulkApprovable: 0 },
          s5Breakdown: classifyS5Surfaces({
            s5Hashes: input.s5Hashes,
            seedHashes: ["swap", "move"],
            proposalHashes: ["swap"],
            candidateHashes: input.s5CandidateHashes,
          }),
          rows,
        };
      },
    },
  };
  return { evaluate: async (fn, arg) => fn(arg) };
}

test("measureABody：S5 の hash（名簿の全体から。水準で削らない）と候補の照合を renderer へ渡し、返った内訳を metrics に載せる", async () => {
  const index = await buildRosterIndex(s5Roster, async (s) => s);
  const inputs = [];
  const out = await measureABody({
    page: s5Page(inputs),
    projectId: "p",
    roster: s5Roster,
    index,
    cell: { level: "L0", steps: [100] },
    // 候補の hash（S5 でない other も含む）。renderer へは S5 に当たるものだけを渡す。
    candidateHashes: ["third", "other", "swap"],
  });
  // L0 でも S5 は 3 件（swap の重複は 1 件）。
  assert.deepEqual(inputs[0].s5Hashes, ["move", "swap", "third"]);
  assert.deepEqual(inputs[0].s5CandidateHashes.sort(), ["swap", "third"]);
  const columns = out.runs[0].metrics.identityColumns;
  assert.equal(columns.s5.roster, 3);
  assert.equal(columns.s5.seen, 1);
  assert.deepEqual(
    [
      columns.s5.breakdown.notSeed,
      columns.s5.breakdown.seedNotProposed,
      columns.s5.breakdown.proposed,
    ],
    [1, 1, 1],
  );
  assert.deepEqual(columns.s5.breakdown.candidate, {
    inCandidate: 2,
    notSeedInCandidate: 1,
    neitherSeedNorCandidate: 0,
  });
  // 候補が未計測（null）なら、候補の数は 0 でなく null。
  const inputs2 = [];
  const out2 = await measureABody({
    page: s5Page(inputs2),
    projectId: "p",
    roster: s5Roster,
    index,
    cell: { level: "L3", steps: [100] },
    candidateHashes: null,
  });
  assert.equal(inputs2[0].s5CandidateHashes, null);
  assert.equal(
    out2.runs[0].metrics.identityColumns.s5.breakdown.candidate,
    null,
  );
  // 出力に表記の文字列（この合成では hash が表記そのまま）の欄を作らない：内訳は件数だけ。
  assert.deepEqual(
    Object.keys(out2.runs[0].metrics.identityColumns.s5.breakdown).sort(),
    ["candidate", "notSeed", "proposed", "seedNotProposed"],
  );
});

test("measureABody：renderer が内訳を返さない run（seed が読めない・欄の無い renderer）は、内訳を 0 でなく null（未計測）にする", async () => {
  const index = await buildRosterIndex(s5Roster, async (s) => s);
  const page = fakePage([]);
  const out = await measureABody({
    page,
    projectId: "p",
    roster: s5Roster,
    index,
    cell: { level: null, steps: [100] },
  });
  assert.equal(out.runs[0].metrics.identityColumns.s5.breakdown, null);
  assert.equal(out.runs[0].metrics.identityColumns.s5.roster, 3);
});

test("loadCandidateHashes：候補の一覧を host 側で hash にする。file が無い・壊れている・空は 0 でなく null（未計測）", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ilm-cand-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "surfaces"), { recursive: true });
  const write = (name, body) => {
    const file = path.join(dir, "surfaces", name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const hash = async (surface) => `h:${surface.length}:${surface}`;
  // 重複は 1 件に畳む。seed の側（surfaces.seed）は読まない。
  assert.deepEqual(
    await loadCandidateHashes(
      write("a.json", { seed: ["s1"], candidate: ["c1", "c2", "c1"] }),
      hash,
    ),
    ["h:2:c1", "h:2:c2"],
  );
  assert.equal(
    await loadCandidateHashes(path.join(dir, "surfaces", "none.json"), hash),
    null,
  );
  assert.equal(
    await loadCandidateHashes(write("b.json", "{not json"), hash),
    null,
  );
  assert.equal(
    await loadCandidateHashes(write("c.json", { candidate: [] }), hash),
    null,
  );
  assert.equal(
    await loadCandidateHashes(write("d.json", { seed: ["s"] }), hash),
    null,
  );
  assert.equal(
    await loadCandidateHashes(write("e.json", { candidate: ["x", 1] }), hash),
    null,
  );
  // 既定の hash は表記を返さない（16 桁の hex）。
  const [real] = await loadCandidateHashes(
    write("f.json", { candidate: ["swap"] }),
  );
  assert.match(real, /^[0-9a-f]{16}$/u);
});

// ---- DR-ILM-41：候補の file の出所の照合 --------------------------------------------------------------------------

test("surfacesFileWithProvenance：surfaces に使った scenes の sha256 を添える（元の object は変えない。形が違えば止める）", () => {
  const surfaces = { seed: ["s"], candidate: ["c"] };
  const sha = sha256Text("scenes-body");
  assert.match(sha, /^[0-9a-f]{64}$/u);
  const out = surfacesFileWithProvenance(surfaces, sha);
  assert.deepEqual(out, { seed: ["s"], candidate: ["c"], scenesSha256: sha });
  assert.equal("scenesSha256" in surfaces, false);
  assert.throws(
    () => surfacesFileWithProvenance(null, sha),
    /SURFACES_NOT_OBJECT/u,
  );
  assert.throws(
    () => surfacesFileWithProvenance([], sha),
    /SURFACES_NOT_OBJECT/u,
  );
  assert.throws(
    () => surfacesFileWithProvenance(surfaces, null),
    /SCENES_SHA256_INVALID/u,
  );
  assert.throws(
    () => surfacesFileWithProvenance(surfaces, "zz"),
    /SCENES_SHA256_INVALID/u,
  );
});

test("candidateFileState：verified／unverified／stale／absent を分ける（stale は照合できないものを verified にしない）", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ilm-cand-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const scenes = put("scenes.json", "scenes-body-v1");
  const sha = sha256Text("scenes-body-v1");
  const cand = ["c1", "c2"];
  // verified：inventory が使った scenes と今の scenes が同じ。
  assert.equal(
    candidateFileState(
      put("v.json", { candidate: cand, scenesSha256: sha }),
      scenes,
    ),
    "verified",
  );
  // unverified：照合用の hash が無い古い file（使うが、照合できていない）。
  assert.equal(
    candidateFileState(put("u.json", { candidate: cand }), scenes),
    "unverified",
  );
  // stale：scenes が変わった（hash が違う）。scenes が読めないときも stale。
  assert.equal(
    candidateFileState(
      put("s.json", {
        candidate: cand,
        scenesSha256: sha256Text("scenes-body-v0"),
      }),
      scenes,
    ),
    "stale",
  );
  assert.equal(
    candidateFileState(
      put("s2.json", { candidate: cand, scenesSha256: sha }),
      path.join(dir, "no-scenes.json"),
    ),
    "stale",
  );
  // absent：無い・壊れている・空・文字列でない要素。hash があっても、候補が使えなければ absent（stale にしない）。
  assert.equal(
    candidateFileState(path.join(dir, "none.json"), scenes),
    "absent",
  );
  assert.equal(
    candidateFileState(put("b.json", "{not json"), scenes),
    "absent",
  );
  assert.equal(
    candidateFileState(
      put("e.json", { candidate: [], scenesSha256: sha }),
      scenes,
    ),
    "absent",
  );
  assert.equal(
    candidateFileState(
      put("n.json", { candidate: ["x", 1], scenesSha256: sha }),
      scenes,
    ),
    "absent",
  );
});

test("loadCandidates：stale は候補があっても使わず（hashes は null）、unverified・verified は使う。absent も null", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ilm-cand-load-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };
  const scenes = put("scenes.json", "scenes-v1");
  const sha = sha256Text("scenes-v1");
  const hash = async (surface) => `h:${surface}`;
  const cand = ["c1", "c2"];
  assert.deepEqual(
    await loadCandidates(
      put("v.json", { candidate: cand, scenesSha256: sha }),
      scenes,
      hash,
    ),
    { state: "verified", hashes: ["h:c1", "h:c2"] },
  );
  assert.deepEqual(
    await loadCandidates(put("u.json", { candidate: cand }), scenes, hash),
    { state: "unverified", hashes: ["h:c1", "h:c2"] },
  );
  assert.deepEqual(
    await loadCandidates(
      put("s.json", { candidate: cand, scenesSha256: sha256Text("scenes-v0") }),
      scenes,
      hash,
    ),
    { state: "stale", hashes: null },
  );
  assert.deepEqual(
    await loadCandidates(path.join(dir, "none.json"), scenes, hash),
    { state: "absent", hashes: null },
  );
});

test("candidateFileState：hash の欄があるのに形が壊れている（null・数値・短い文字列）file は stale（unverified にしない）", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ilm-cand-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scenes = path.join(dir, "scenes.json");
  writeFileSync(scenes, "scenes");
  const file = path.join(dir, "c.json");
  for (const bad of [null, 0, 12345, "", "abc", "G".repeat(64)]) {
    writeFileSync(
      file,
      JSON.stringify({ candidate: ["c"], scenesSha256: bad }),
    );
    assert.equal(candidateFileState(file, scenes), "stale", String(bad));
  }
  // 欄が無いのは unverified（古い file）。
  writeFileSync(file, JSON.stringify({ candidate: ["c"] }));
  assert.equal(candidateFileState(file, scenes), "unverified");
});

test("readWorkSource：scenes の生の本文（JSON.parse の前の utf8）から hash を取る。inventory が書いた hash を測定 A が同じ値で照合できる", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ilm-raw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 整形が不揃いな JSON（再直列化すると別の文字列になる）。BOM・CRLF も含める。
  const raw = '\ufeff{ "scenes" :[ 1 ,\r\n 2 ] }\r\n';
  const scenes = path.join(dir, "scenes.json");
  writeFileSync(scenes, raw);
  const read = readWorkSource(scenes);
  assert.equal(read.text, raw);
  assert.equal(read.sha256, sha256Text(raw));
  assert.notEqual(
    read.sha256,
    sha256Text(JSON.stringify(JSON.parse(raw.replace(/^\ufeff/u, "")))),
  );
  // inventory 側（readWorkSource の hash を surfaces に添える）→ 測定 A 側（candidateFileState）で verified になる。
  const file = path.join(dir, "surfaces.json");
  writeFileSync(
    file,
    JSON.stringify(
      surfacesFileWithProvenance(
        { seed: ["s"], candidate: ["c"] },
        read.sha256,
      ),
    ),
  );
  assert.equal(candidateFileState(file, scenes), "verified");
  // scenes を 1 文字変えれば stale。
  writeFileSync(scenes, raw + " ");
  assert.equal(candidateFileState(file, scenes), "stale");
});

test("clearPreviousInventoryOutputs：inventory の mode は前の surfaces も消す。extract-empty は消さない。他の作品の file は消さない", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ilm-clear-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inventory");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, "surfaces"), { recursive: true });
  const seed = () => {
    for (const name of [
      "w1.json",
      "w1.rows.json",
      "w1.rejected.json",
      "w1.failed.json",
      "w2.json",
    ])
      writeFileSync(path.join(dir, name), "{}");
    for (const name of ["w1.json", "w2.json"])
      writeFileSync(path.join(root, "surfaces", name), "{}");
  };
  const exists = (...parts) => existsSync(path.join(root, ...parts));
  seed();
  clearPreviousInventoryOutputs({
    dir,
    output: root,
    workKey: "w1",
    mode: "extract-empty",
  });
  assert.equal(exists("inventory", "w1.json"), false);
  assert.equal(exists("inventory", "w1.failed.json"), false);
  assert.equal(
    exists("surfaces", "w1.json"),
    true,
    "extract-empty は surfaces を消さない",
  );
  seed();
  clearPreviousInventoryOutputs({
    dir,
    output: root,
    workKey: "w1",
    mode: "inventory",
  });
  assert.equal(
    exists("surfaces", "w1.json"),
    false,
    "inventory は前の surfaces を消す",
  );
  assert.equal(exists("surfaces", "w2.json"), true, "他の作品は消さない");
  assert.equal(exists("inventory", "w2.json"), true);
});
