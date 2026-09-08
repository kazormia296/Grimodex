import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nearestRank,
  scoreQuery,
  summarizeWarm,
  loadContract,
  validateWarmPopulation,
  validateRawIpcTrace,
} from "./contract.mjs";
import path from "node:path";

test("NIR-1 preimplementation corpus is balanced, isolated and grounded", async () => {
  await loadContract(path.resolve(import.meta.dirname, "../../.."));
});

test("same-query repetition and warmup contamination cannot certify pooled B", () => {
  const ids = Array.from({ length: 24 }, (_, index) => `query-${index}`);
  const calls = ids.flatMap((queryId) =>
    Array.from({ length: 30 }, (_, repeat) => ({
      queryId,
      repeat,
      arm: "raw",
      phase: "measured",
    })),
  );
  validateWarmPopulation(calls, ids);
  assert.throws(
    () =>
      validateWarmPopulation(
        calls.map((call) => ({ ...call, queryId: ids[0] })),
        ids,
      ),
    /balanced schedule/,
  );
  assert.throws(
    () =>
      validateWarmPopulation(
        [{ ...calls[0], phase: "warmup" }, ...calls.slice(1)],
        ids,
      ),
    /warmup/,
  );
});

test("a swallowed Native error envelope or absent source read fails the Raw sample", () => {
  const calls = ["db_execute", "semantic_search", "fts_search"].map(
    (command) => ({ command, completed: true, ok: true }),
  );
  validateRawIpcTrace(calls);
  assert.throws(
    () => validateRawIpcTrace([{ ...calls[0], ok: false }, ...calls.slice(1)]),
    /swallowed/,
  );
  assert.throws(() => validateRawIpcTrace(calls.slice(1)), /db_execute/);
});

test("graded nDCG and Recall count scenes once and reject ineligible results", () => {
  const query = {
    eligibleSceneIds: ["a", "b", "c"],
    relevanceGrades: { a: 3, b: 1, c: 0 },
    requiredRawPassages: [{ sceneId: "a", text: "whole quote" }],
  };
  const results = [
    { sceneId: "c", chunkText: "noise" },
    { sceneId: "a", chunkText: "whole quote" },
  ];
  const score = scoreQuery(query, results);
  assert.equal(score.recallAt8, 0.5);
  assert.ok(
    Math.abs(score.ndcgAt8 - 7 / Math.log2(3) / (7 + 1 / Math.log2(3))) < 1e-12,
  );
  assert.equal(score.requiredRawPassagesRetained, true);
  assert.throws(() => scoreQuery(query, [...results, results[1]]), /duplicate/);
  assert.throws(
    () => scoreQuery(query, [{ sceneId: "unread", chunkText: "whole quote" }]),
    /ineligible/,
  );
  assert.equal(
    scoreQuery(query, [{ sceneId: "a", chunkText: "whole" }])
      .requiredRawPassagesRetained,
    false,
  );
  const eight = Array.from({ length: 8 }, (_, i) => ({
    sceneId: `s${i}`,
    chunkText: "text",
  }));
  const capQuery = {
    eligibleSceneIds: eight.map((r) => r.sceneId),
    relevanceGrades: Object.fromEntries(eight.map((r) => [r.sceneId, 1])),
    requiredRawPassages: [],
  };
  assert.throws(
    () =>
      scoreQuery(capQuery, [
        ...eight,
        { sceneId: "forbidden-ninth", chunkText: "forbidden" },
      ]),
    /cap/,
  );
  assert.throws(() => scoreQuery(capQuery, [...eight, eight[0]]), /cap/);
});

test("nearest rank p95 has fixed denominator and failed calls cannot fix B", () => {
  assert.equal(
    nearestRank(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  assert.throws(() => nearestRank([1, Infinity], 0.95));
  const calls = Array.from({ length: 720 }, () => ({
    status: "ok",
    durationMs: 100,
  }));
  assert.deepEqual(
    { B: summarizeWarm(calls).B, D: summarizeWarm(calls).D },
    { B: 100, D: 20 },
  );
  calls[0] = { status: "timeout", durationMs: 10000 };
  assert.equal(summarizeWarm(calls).B, null);
  assert.equal(summarizeWarm(calls).failedCount, 1);
  assert.equal(summarizeWarm(calls.slice(1)).status, "blocked");
  calls[0] = { status: "completed-safe-fallback", durationMs: 110 };
  assert.equal(summarizeWarm(calls).status, "complete");
  assert.equal(summarizeWarm(calls).scheduledCount, 720);
});
