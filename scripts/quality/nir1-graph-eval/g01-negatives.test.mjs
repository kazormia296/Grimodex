// DR-CP4-O-1 (5): K24-G01-N2〜N4 の段の Electron を使わない部分。偽の page
// （製品の writer の代わり）と注入した Index の metadata で、宣言の前の版の用意、
// 宣言の後の mutation、B の seal の待ち、SP-P1 の照合し直し、blocked を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessG01Negative } from "./frozen-diagnostics.mjs";
import {
  G01_NEGATIVE_POLL_MS,
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  prepareG01NegativeBeforeDeclaration,
  runG01NegativeStep,
  waitG01NegativeSealed,
} from "./g01-negatives.mjs";
import { B_SEAL_WAIT_MS } from "./frozen-setup-driver.mjs";
import { TRACE_MAINTENANCE_SEAM } from "./trace-record.mjs";

const TARGET = {
  sceneId: "g01-mira",
  entityId: "g01-mira-entity",
  seedEntityId: "g01-orin",
  querySceneId: "g01-query",
};
const IDS = {
  projectId: "p",
  scenes: {
    "g01-mira": "s-mira",
    "g01-query": "s-query",
    "g01-review": "s-review",
  },
  entities: { "g01-orin": "e-orin", "g01-mira-entity": "e-mira" },
};

function fakePage(handlers) {
  const calls = [];
  const diagnostic = new Proxy(
    {},
    {
      get: (_, name) => async (input) => {
        calls.push([name, input]);
        return handlers[name](input);
      },
    },
  );
  globalThis.window = { cp4Harness: { diagnostic } };
  return { calls, page: { evaluate: async (fn, arg) => fn(arg) } };
}

const metadata = (b, dirty = false, chronicle = 3) => ({
  b: { generation: b, dirty },
  chronicle: { generation: chronicle, dirty: false },
});

test("O-1 (5): 宣言の前に N3 は同じ bytes の版、N4 は Draft の版と元の本文の再保存を用意し、N2 は何もしない", async () => {
  const { calls, page } = fakePage({
    sameBytesVersion: () => ({
      ok: true,
      value: { revisionId: "v1", created: true, sha256: "s" },
    }),
    draftThenOriginal: (input) => ({
      ok: true,
      value: {
        revisionId: "v2",
        draftSha256: `d${input.suffix}`,
        originalSha256: "o",
        afterSha256: "o",
      },
    }),
  });
  assert.deepEqual(
    await prepareG01NegativeBeforeDeclaration({
      id: "K24-G01-N2",
      page,
      ids: IDS,
      target: TARGET,
    }),
    { prepared: null, blocked: null },
  );
  const n3 = await prepareG01NegativeBeforeDeclaration({
    id: "K24-G01-N3",
    page,
    ids: IDS,
    target: TARGET,
  });
  assert.equal(n3.prepared.revisionId, "v1");
  const n4 = await prepareG01NegativeBeforeDeclaration({
    id: "K24-G01-N4",
    page,
    ids: IDS,
    target: TARGET,
  });
  assert.equal(n4.prepared.draftSha256, "d Draft.");
  assert.deepEqual(
    calls.map((row) => row[0]),
    ["sameBytesVersion", "draftThenOriginal"],
  );
  assert.deepEqual(calls[1][1], {
    projectId: "p",
    sceneId: "s-mira",
    suffix: " Draft.",
  });
  // 作れなければ blocked（数えない）。
  const failing = fakePage({
    sameBytesVersion: () => ({ ok: false, error: "no version" }),
    draftThenOriginal: () => ({
      ok: true,
      value: {
        revisionId: "v",
        draftSha256: "d",
        originalSha256: "o",
        afterSha256: "d",
      },
    }),
  });
  assert.equal(
    (
      await prepareG01NegativeBeforeDeclaration({
        id: "K24-G01-N3",
        page: failing.page,
        ids: IDS,
        target: TARGET,
      })
    ).blocked.reason,
    "before-declaration",
  );
  assert.equal(
    (
      await prepareG01NegativeBeforeDeclaration({
        id: "K24-G01-N4",
        page: failing.page,
        ids: IDS,
        target: TARGET,
      })
    ).blocked.reason,
    "before-declaration",
  );
  await assert.rejects(
    prepareG01NegativeBeforeDeclaration({
      id: "K24-G01-N1",
      page,
      ids: IDS,
      target: TARGET,
    }),
    /\[precheck\]/u,
  );
});

test("O-1 (5): mutation の後は setup と同じ規則（新しい B の generation が dirty でなく、Chronicle が使える）で待ち、上限は B_SEAL_WAIT_MS", async () => {
  let clock = 0;
  const reads = [metadata(4, true), metadata(5, true), metadata(5, false)];
  const ok = await waitG01NegativeSealed({
    readIndex: () => reads.shift() ?? metadata(5, false),
    before: metadata(4),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.waitedMs, 2 * G01_NEGATIVE_POLL_MS);
  // generation が進まなければ（clean のままでも）上限で blocked。
  clock = 0;
  const stuck = await waitG01NegativeSealed({
    readIndex: () => metadata(4, false),
    before: metadata(4),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.waitedMs, B_SEAL_WAIT_MS);
  // Chronicle の Index が dirty なら使えない。
  clock = 0;
  const chronicleDirty = await waitG01NegativeSealed({
    readIndex: () => ({
      b: { generation: 6, dirty: false },
      chronicle: { generation: 3, dirty: true },
    }),
    before: metadata(4),
    limitMs: 1000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(chronicleDirty.ok, false);
});

const pin = (entryId) => ({
  entryId,
  entryInProject: true,
  createdAt: "2026-10-28T00:00:00Z",
});
const pins = (rows) => ({
  sceneLive: true,
  pins: rows,
  source: { db: { path: "/w", ino: 1 } },
});

test("O-1 (5): 宣言の後の mutation は N2 が同じ本文の再保存、N3／N4 が用意した版の restore、その後に待ちと SP-P1 の照合し直し", async () => {
  const { calls, page } = fakePage({
    resaveBody: () => ({
      ok: true,
      value: {
        before: { sha256: "o", version: 3 },
        after: { sha256: "o", version: 4 },
      },
    }),
    restoreVersion: (input) => ({
      ok: true,
      value: {
        revisionId: input.revisionId,
        restoredSha256: input.revisionId === "v1" ? "o" : "d",
        afterSha256: input.revisionId === "v1" ? "o" : "d",
      },
    }),
  });
  const wait = async ({ before }) => ({
    ok: true,
    waitedMs: 7,
    metadata: before,
  });
  const base = {
    page,
    ids: IDS,
    target: TARGET,
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    wait,
  };
  const n2 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N2",
    before: null,
  });
  assert.equal(n2.blocked, null);
  assert.equal(n2.spP1Recheck.status, "match");
  const n3 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N3",
    before: { revisionId: "v1", sha256: "o" },
  });
  assert.equal(n3.blocked, null);
  const n4 = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N4",
    before: { revisionId: "v2", draftSha256: "d", originalSha256: "o" },
  });
  assert.equal(n4.blocked, null);
  assert.deepEqual(
    calls.map((row) => row[0]),
    ["resaveBody", "restoreVersion", "restoreVersion"],
  );
  // project の snapshot の restore は呼ばない（入口が無い）。
  assert.ok(!calls.some((row) => /snapshot/iu.test(row[0])));
  // SP-P1 が合わなければ照合の記録が mismatch（結果は inconclusive）。
  const moved = await runG01NegativeStep({
    ...base,
    id: "K24-G01-N2",
    before: null,
    readPins: () =>
      pins([
        pin("e-orin"),
        { ...pin("e-mira"), createdAt: "2026-10-28T00:00:01Z" },
      ]),
  });
  assert.equal(moved.spP1Recheck.status, "multiple-pins");
  assert.equal(
    assessG01Negative({
      id: "K24-G01-N2",
      spP1Recheck: moved.spP1Recheck,
      samples: [],
    }).outcome,
    "inconclusive",
  );
});

test("O-1 (5): restore の経路が使えない、版の bytes が違う、B が戻らなければ blocked（case の判定に数えない）", async () => {
  const wait = async () => ({ ok: true, waitedMs: 1 });
  const cases = [
    [
      { restoreVersion: () => ({ ok: false, error: "restore unavailable" }) },
      "K24-G01-N3",
      { revisionId: "v1", sha256: "o" },
      "mutation",
    ],
    [
      {
        restoreVersion: () => ({
          ok: true,
          value: { restoredSha256: "x", afterSha256: "x" },
        }),
      },
      "K24-G01-N3",
      { revisionId: "v1", sha256: "o" },
      "mutation",
    ],
    [
      {
        restoreVersion: () => ({
          ok: true,
          value: { restoredSha256: "o", afterSha256: "o" },
        }),
      },
      "K24-G01-N4",
      { revisionId: "v2", draftSha256: "d" },
      "mutation",
    ],
    [
      {
        resaveBody: () => ({
          ok: true,
          value: { before: { sha256: "o" }, after: { sha256: "p" } },
        }),
      },
      "K24-G01-N2",
      null,
      "mutation",
    ],
    [{}, "K24-G01-N3", null, "mutation"],
  ];
  for (const [handlers, id, before, reason] of cases) {
    const { page } = fakePage(handlers);
    const step = await runG01NegativeStep({
      id,
      page,
      ids: IDS,
      target: TARGET,
      before,
      readIndex: () => metadata(4),
      readPins: () => pins([pin("e-orin")]),
      wait,
    });
    assert.equal(step.blocked?.reason, reason, id);
    assert.equal(
      assessG01Negative({ id, blocked: step.blocked }).outcome,
      "blocked",
    );
  }
  const { page } = fakePage({
    resaveBody: () => ({
      ok: true,
      value: { before: { sha256: "o" }, after: { sha256: "o" } },
    }),
  });
  const notSealed = await runG01NegativeStep({
    id: "K24-G01-N2",
    page,
    ids: IDS,
    target: TARGET,
    before: null,
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    wait: async () => ({ ok: false, waitedMs: B_SEAL_WAIT_MS }),
  });
  assert.equal(notSealed.blocked.reason, "b-seal-not-current");
});

test("O-1 (5): 測定の Main は B-ROUTE の journey seam、sample は論理 ID（frame を読む入口が無ければ null）", () => {
  const env = g01NegativeLaunchEnv({
    nonce: "8c7f4a3e-6b1d-4c2a-9e5f-0a1b2c3d4e5f",
    base: { CI: "true" },
  });
  assert.equal(
    env[TRACE_MAINTENANCE_SEAM.triggerEnv],
    TRACE_MAINTENANCE_SEAM.trigger,
  );
  const sample = g01NegativeSampleOf({
    row: {
      phase: "measured",
      repeat: 2,
      arm: "graph",
      followUp: { parent: { seed: "e-orin" } },
      finalSceneIds: ["s-review", "zz"],
    },
    ids: IDS,
  });
  assert.deepEqual(sample, {
    phase: "measured",
    repeat: 2,
    arm: "graph",
    seedRequested: "g01-orin",
    frameReached: null,
    returnedSceneIds: ["g01-review", "unmapped:zz"],
  });
  assert.deepEqual(
    assessG01Negative({
      id: "K24-G01-N4",
      spP1Recheck: { status: "match" },
      samples: [sample],
    }).reasons,
    ["g01-mira-entity-reached:unobservable"],
  );
});

test("O-1 (5)（変異 G4）: restore の答えの版の bytes が用意した版と違えば、本文が一致して見えても blocked", async () => {
  const { page } = fakePage({
    restoreVersion: () => ({
      ok: true,
      value: { restoredSha256: "other", afterSha256: "o" },
    }),
  });
  const step = await runG01NegativeStep({
    id: "K24-G01-N3",
    page,
    ids: IDS,
    target: TARGET,
    before: { revisionId: "v1", sha256: "o" },
    readIndex: () => metadata(4),
    readPins: () => pins([pin("e-orin")]),
    wait: async () => ({ ok: true, waitedMs: 1 }),
  });
  assert.equal(step.blocked?.reason, "mutation");
});
