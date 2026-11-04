import assert from "node:assert/strict";
import test from "node:test";
import { addedQueryPositions, priorScenesBucket } from "./ir-slot.mjs";

test("query は足した Scene 全部で、位置 2 以上、各位置は 1 回だけ", () => {
  assert.deepEqual(addedQueryPositions(0, 5), [2, 3, 4, 5]);
  assert.deepEqual(addedQueryPositions(5, 9), [6, 7, 8, 9]);
  assert.deepEqual(addedQueryPositions(9, 9), []);
  // 4 地点を通すと 2..N をちょうど 1 回ずつ覆う。
  const counts = [28, 55, 83, 110];
  let previous = 0;
  const all = [];
  for (const count of counts) {
    all.push(...addedQueryPositions(previous, count));
    previous = count;
  }
  assert.deepEqual(
    all,
    Array.from({ length: 109 }, (_, i) => i + 2),
  );
});

test("前の Scene の数の層", () => {
  assert.equal(priorScenesBucket(2), "lt8");
  assert.equal(priorScenesBucket(8), "lt8");
  assert.equal(priorScenesBucket(9), "8to30");
  assert.equal(priorScenesBucket(31), "8to30");
  assert.equal(priorScenesBucket(32), "gt30");
});
