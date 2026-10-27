// レビュー P2-3: trace の page の待ちの規則（renderer/trace-cycle.ts、純粋）。
// counted query の親の選び方、cycle end、公開の判定を直接押さえる。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cycleEndOf,
  publishedOf,
  selectCountedFetch,
} from "./renderer/trace-cycle.ts";

const row = (seq, extra = {}) => ({
  seq,
  sceneId: "q",
  refreshTrigger: null,
  calledAt: seq * 100,
  resolvedAt: seq * 100 + 60,
  status: "completed",
  tRawReadyMs: seq * 100 + 50,
  ...extra,
});

test("P2-3: 親はその操作の後のその場面の最初の fetch で、graph-ready の取り直しと別の場面と前の seq は親にしない", () => {
  const rows = [
    row(1),
    row(2, { refreshTrigger: "graph-ready" }),
    row(3, { sceneId: "o" }),
    row(4),
  ];
  assert.equal(
    selectCountedFetch(rows, { sceneId: "q", afterSeq: 1, sinceAt: 150 }).seq,
    4,
  );
  assert.equal(
    selectCountedFetch(rows, { sceneId: "q", afterSeq: 0, sinceAt: 0 }).seq,
    1,
  );
  assert.equal(
    selectCountedFetch(rows, { sceneId: "q", afterSeq: 4, sinceAt: 0 }),
    null,
  );
  assert.equal(
    selectCountedFetch([row(1), row(2, { refreshTrigger: "graph-ready" })], {
      sceneId: "q",
      afterSeq: 1,
      sinceAt: 0,
    }),
    null,
  );
});

test("P2-3: cycle end は子の公開・子の不完了・親の不完了・T_show・guard の順の規則で決まる", () => {
  const input = (extra = {}) => ({
    parentSeq: 1,
    tShowMs: 2_000,
    now: 200,
    elapsedMs: 100,
    limitMs: 30_000,
    ...extra,
  });
  const child = row(2, { refreshTrigger: "graph-ready" });
  assert.equal(
    cycleEndOf([row(1), child], [{ at: 170, fetchSeq: 2 }], input()),
    "child-published",
  );
  // A returned child not yet shown keeps the cycle open.
  assert.equal(cycleEndOf([row(1), child], [], input()), null);
  // A non-graph-ready fetch is never the child.
  assert.equal(
    cycleEndOf([row(1), row(2)], [{ at: 170, fetchSeq: 2 }], input()),
    null,
  );
  assert.equal(
    cycleEndOf([row(1), { ...child, status: "cancelled" }], [], input()),
    "child-ended",
  );
  assert.equal(
    cycleEndOf([row(1, { status: "cancelled" })], [], input()),
    "parent-ended",
  );
  assert.equal(
    cycleEndOf([row(1)], [], input({ now: 150 + 2_000 })),
    "t-show-elapsed",
  );
  assert.equal(cycleEndOf([row(1)], [], input({ now: 2_149 })), null);
  assert.equal(
    cycleEndOf(
      [row(1, { resolvedAt: null })],
      [],
      input({ elapsedMs: 30_000 }),
    ),
    "harness-limit",
  );
  assert.equal(cycleEndOf([row(1, { resolvedAt: null })], [], input()), null);
});

test("P2-3: 公開はその場面の最初の fetch が commit に出たか、completed 以外で返ったとき", () => {
  const rows = [row(1, { sceneId: "o" })];
  assert.deepEqual(
    publishedOf(rows, [{ at: 175, fetchSeq: 1 }], {
      sceneId: "o",
      sinceAt: 0,
      now: 180,
    }),
    { seq: 1, at: 175, published: true },
  );
  assert.equal(
    publishedOf(rows, [], { sceneId: "o", sinceAt: 0, now: 180 }),
    null,
  );
  assert.deepEqual(
    publishedOf([row(1, { sceneId: "o", status: "cancelled" })], [], {
      sceneId: "o",
      sinceAt: 0,
      now: 180,
    }),
    { seq: 1, at: 180, published: false },
  );
  assert.equal(
    publishedOf([row(1, { sceneId: "o", resolvedAt: null })], [], {
      sceneId: "o",
      sinceAt: 0,
      now: 180,
    }),
    null,
  );
  assert.equal(
    publishedOf(rows, [{ at: 175, fetchSeq: 1 }], {
      sceneId: "o",
      sinceAt: 101,
      now: 180,
    }),
    null,
  );
});
