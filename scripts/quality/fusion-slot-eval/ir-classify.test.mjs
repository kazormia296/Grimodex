import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySample,
  compareAdmitted,
  irCandidatesOutsideRaw,
  summarizeQueries,
} from "./ir-classify.mjs";

// 作った値だけ（作品の本文に由来しない）。
const ready = { indexUsable: true, querySupported: true };
const base = {
  status: "completed",
  initialSnapshot: ready,
  completion: { outcome: "ir-ready" },
  resultKind: "fused",
  irStatus: "available",
  rows: [{ position: 1, kind: "raw" }],
  rawCount: 1,
  rawPositions: [1],
};

test("分類は計画 §3 の順に outcome で判定する", () => {
  assert.equal(
    classifySample({ ...base, initialSnapshot: { ...ready, querySupported: false } }).category,
    "unsupported",
  );
  assert.equal(
    classifySample({ ...base, initialSnapshot: { ...ready, indexUsable: false } }).category,
    "ir-not-built",
  );
  assert.equal(
    classifySample({ ...base, completion: { outcome: "timeout" }, resultKind: "raw" }).category,
    "ir-timeout",
  );
  for (const outcome of ["ir-unavailable", "failed", "cancelled", "invalidated"])
    assert.equal(classifySample({ ...base, completion: { outcome } }).category, "fault");
  assert.equal(classifySample({ ...base, status: "failed", initialSnapshot: null }).category, "fault");
  assert.deepEqual(
    classifySample({ ...base, rows: [{ position: 1, kind: "raw" }, { position: 2, kind: "ir" }] }),
    { category: "slot-used", unusedReason: null },
  );
  assert.deepEqual(
    classifySample({ ...base, resultKind: "raw", irStatus: "empty" }),
    { category: "slot-unused", unusedReason: "ir-empty" },
  );
  assert.deepEqual(classifySample({ ...base, rawCount: 8 }), {
    category: "slot-unused",
    unusedReason: "raw-full",
  });
  assert.deepEqual(classifySample({ ...base, rows: [{ position: 1, kind: "raw-ir" }] }), {
    category: "slot-unused",
    unusedReason: "overlap",
  });
});

test("Raw の外の IR 候補は query より前の位置だけ", () => {
  const probe = { status: "available", admittedPositions: [1, 3, 5, 9] };
  assert.deepEqual(irCandidatesOutsideRaw(probe, [1, 2], 6), [3, 5]);
  assert.equal(irCandidatesOutsideRaw({ status: "unavailable" }, [1], 6), null);
});

test("主指標の分母は IR ready かつ Raw が 8 件未満", () => {
  const full = Array.from({ length: 8 }, (_, i) => i + 1);
  const summary = summarizeQueries([
    {
      position: 10,
      probe: { status: "available", admittedPositions: [9] },
      samples: [
        { ...base, rows: [{ position: 2, kind: "ir" }], rawCount: 1 },
        { ...base, rawCount: 8, rawPositions: full },
        { ...base, completion: { outcome: "timeout" }, resultKind: "raw", rawCount: 3, rawPositions: [1, 2, 3] },
      ],
    },
  ]);
  assert.deepEqual(summary.slotUseRate, { numerator: 1, denominator: 1, value: 1 });
  assert.equal(summary.rawFullWithIrCandidate.numerator, 1);
  assert.equal(summary.timeoutCounterfactual.numerator, 1);
  assert.equal(summary.irUnavailableRate.timeout, 1);
});

test("地点の判定は前の admitted が全て残るかを見る", () => {
  const before = new Map([[5, [1, 2]], [6, [3]]]);
  assert.equal(compareAdmitted(before, new Map([[5, [1, 2, 4]], [6, [3]]])).nonDecreasing, true);
  const lost = compareAdmitted(before, new Map([[5, [1]], [6, [3]]]));
  assert.equal(lost.nonDecreasing, false);
  assert.deepEqual(lost.lost, [{ position: 5, lost: 1, missing: [2] }]);
});
