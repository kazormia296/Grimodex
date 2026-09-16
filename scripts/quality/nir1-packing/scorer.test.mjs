import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { scoreNir1PackingCase } from "./scorer.mjs";

async function loadFixtures() {
  const fixturePath = new URL("../../../evals/nir1-packing/fixtures.json", import.meta.url);
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("deterministic scorer accepts exact order and counters", async () => {
  const manifest = await loadFixtures();
  const testCase = manifest.cases[0];
  const result = {
    selectedIds: testCase.expected.selectedIds,
    proseOrder: testCase.expected.proseOrder,
    selectedText: testCase.expected.selectedIds.map((id) => testCase.input.find((item) => item.id === id).text),
    proseText: testCase.expected.selectedIds.map((id) => testCase.input.find((item) => item.id === id).text),
    usedTokens: 18,
    exactUsedTokens: 18,
    contextBudgetTokens: 40,
    exactContextBudgetTokens: 40,
    liveModelCalls: 0,
  };
  const scored = scoreNir1PackingCase(testCase, result, manifest.execution.budget);
  assert.equal(scored.status, "passed");
});

test("heuristic P-12 evidence cannot pass without exact counters", async () => {
  const manifest = await loadFixtures();
  const testCase = manifest.cases[11];
  const result = {
    selectedIds: testCase.expected.selectedIds,
    proseOrder: testCase.expected.proseOrder,
    selectedText: testCase.expected.selectedIds.map((id) => testCase.input.find((item) => item.id === id).text),
    proseText: testCase.expected.selectedIds.map((id) => testCase.input.find((item) => item.id === id).text),
    usedTokens: 19,
    exactUsedTokens: 19,
    contextBudgetTokens: 40,
    exactContextBudgetTokens: 40,
    liveModelCalls: 0,
    improvementCounters: { heuristic: 1 },
  };
  const scored = scoreNir1PackingCase(testCase, result, manifest.execution.budget);
  assert.equal(scored.status, "failed");
  assert.equal(scored.improvementStatus, "blocked");
  assert.ok(scored.failures.some((failure) => failure.includes("measured baseline")));
});

test("P-12 rejects identical arms and ignores forged counters", async () => {
  const manifest = await loadFixtures();
  const testCase = manifest.cases[11];
  const selectedItems = testCase.input.map((item) =>
    item.atomicGroup === "p12-evidence"
      ? {
          ...item,
          qualificationProof: {
            provenance: "fixture-only",
            reader: manifest.execution.qualificationOutputs.current,
          },
        }
      : item,
  );
  const arm = {
    selectedIds: testCase.expected.selectedIds,
    selectedItems,
    proseOrder: testCase.expected.proseOrder,
    selectedText: selectedItems.map((item) => item.text),
    proseText: selectedItems.map((item) => item.text),
    usedTokens: 19,
    exactUsedTokens: 19,
    contextBudgetTokens: 40,
    exactContextBudgetTokens: 40,
  };
  const scored = scoreNir1PackingCase(
    testCase,
    {
      baseline: arm,
      candidate: arm,
      improvementCounters: { baseline: 0, candidate: 1 },
    },
    manifest.execution.budget,
  );
  assert.equal(scored.status, "failed");
  assert.equal(scored.improvementStatus, "failed");
  assert.ok(scored.failures.some((failure) => failure.includes("identical")));
  assert.ok(scored.failures.some((failure) => failure.includes("forged")));
});
