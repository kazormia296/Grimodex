import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProductJourneys } from "../electron/scripts/product-journeys.mjs";

function deterministicClock(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "clock was read more often than expected");
    return values[index++];
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("product runner records deterministic results while preserving serial fresh harnesses", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  let harnessIndex = 0;
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await runProductJourneys({
    journeys: [
      {
        id: "first",
        run: async (harness) => {
          events.push(`run:first:${harness.index}`);
        },
      },
      {
        id: "second",
        run: async (harness) => {
          events.push(`run:second:${harness.index}`);
        },
      },
    ],
    assertArtifacts: () => events.push("assert-artifacts"),
    createHarness: () => {
      const index = ++harnessIndex;
      events.push(`create:${index}`);
      return {
        index,
        dispose: async ({ success, name }) => {
          events.push(`dispose:${index}:${success}:${name}`);
        },
      };
    },
    clock: deterministicClock([100, 125, 200, 260]),
    resultsPath,
  });

  assert.deepEqual(events, [
    "assert-artifacts",
    "create:1",
    "run:first:1",
    "dispose:1:true:first",
    "create:2",
    "run:second:2",
    "dispose:2:true:second",
  ]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 1);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.journeys, [
    { id: "first", status: "passed", durationMs: 25 },
    { id: "second", status: "passed", durationMs: 60 },
  ]);
});

test("product runner writes the failed and fail-fast results before rethrowing", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [
        {
          id: "broken",
          run: async () => {
            events.push("run:broken");
            throw new TypeError("boom");
          },
        },
        {
          id: "never",
          run: async () => {
            events.push("run:never");
          },
        },
      ],
      assertArtifacts: () => undefined,
      createHarness: () => {
        events.push("create");
        return {
          dispose: async ({ success, name }) => {
            events.push(`dispose:${success}:${name}`);
          },
        };
      },
      clock: deterministicClock([10, 22]),
      resultsPath,
    }),
    /broken: TypeError: boom/,
  );

  assert.deepEqual(events, ["create", "run:broken", "dispose:false:broken"]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 1);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.journeys, [
    {
      id: "broken",
      status: "failed",
      durationMs: 12,
      error: { name: "TypeError", message: "boom" },
    },
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Fail-fast after broken.",
    },
  ]);
});

test("product runner still writes a versioned report when artifact preflight fails", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [{ id: "never", run: async () => undefined }],
      assertArtifacts: () => {
        throw new Error("missing build");
      },
      createHarness: () => {
        throw new Error("harness must not be created");
      },
      clock: deterministicClock([]),
      resultsPath,
    }),
    /missing build/,
  );

  const report = await readJson(resultsPath);
  assert.equal(report.version, 1);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.error, {
    name: "Error",
    message: "missing build",
  });
  assert.deepEqual(report.journeys, [
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Artifact preflight failed.",
    },
  ]);
});
