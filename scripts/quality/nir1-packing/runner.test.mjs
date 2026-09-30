import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runNir1CacheBindingMutations, runNir1PackingCases } from "./runner.mjs";

async function loadFixtures() {
  const fixturePath = new URL("../../../evals/nir1-packing/fixtures.json", import.meta.url);
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("runner supplies frozen-run inputs in fixture order and isolates state", async () => {
  const manifest = await loadFixtures();
  const seen = [];
  const results = runNir1PackingCases(manifest, (testCase, runState, index) => {
    seen.push({ caseId: testCase.caseId, seed: runState.seed, index });
    testCase.input[0].text = "mutated";
    runState.budget.contextWindowTokens = 1;
    return { selectedIds: [testCase.input[0].id] };
  });

  assert.deepEqual(
    seen.map(({ caseId }) => caseId),
    manifest.cases.map(({ caseId }) => caseId),
  );
  assert.equal(new Set(seen.map(({ seed }) => seed)).size, 1);
  assert.equal(results.length, manifest.cases.length);
  assert.equal(manifest.cases[1].input[0].text, "Mira crossed the bridge.");
  assert.equal(manifest.execution.budget.contextWindowTokens, 64);
});

test("runner executes every declared P-10 cache mutation", async () => {
  const manifest = await loadFixtures();
  const checks = runNir1CacheBindingMutations(
    manifest,
    (cached, current) =>
      Object.keys(cached).every((key) => cached[key] === current[key]),
    ({ runState }) => ({
      cachedPlan: {},
      plan: {},
      reused: false,
      staleMaterialPresent: false,
      validMaterialRetained: true,
      usedTokens:
        runState.budget.contextWindowTokens -
        runState.budget.systemTokens -
        runState.budget.historyTokens -
        runState.budget.toolTokens -
        runState.budget.responseReservationTokens,
    }),
  );
  assert.equal(checks.length, 6);
  assert.deepEqual(
    checks.map((check) => check.key),
    ["scopeToken", "sourceToken", "revisionId", "decisionId", "freshnessToken", "indexGeneration"],
  );
});
