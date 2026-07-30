import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProductJourneys } from "../electron/scripts/product-journeys.mjs";

test("runner preserves the journey failure and writes results when failure cleanup also rejects", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-cleanup-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [
        {
          id: "broken",
          run: async () => {
            throw new TypeError("journey boom");
          },
        },
      ],
      assertArtifacts: () => undefined,
      createHarness: () => ({
        dispose: async () => {
          throw new Error("cleanup boom");
        },
      }),
      clock: (() => {
        const values = [10, 25];
        return () => values.shift();
      })(),
      resultsPath,
    }),
    /broken: TypeError: journey boom/,
  );

  const report = JSON.parse(await readFile(resultsPath, "utf8"));
  assert.equal(report.status, "failed");
  assert.deepEqual(report.journeys, [
    {
      id: "broken",
      status: "failed",
      durationMs: 15,
      error: { name: "TypeError", message: "journey boom" },
      rendererErrorCount: 0,
      pageErrors: [],
      cleanPass: false,
      cleanupError: { name: "Error", message: "cleanup boom" },
    },
  ]);
});
