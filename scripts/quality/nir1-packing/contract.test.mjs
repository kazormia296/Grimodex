import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateNir1PackingFixtures } from "./contract.mjs";

async function loadFixtures() {
  const fixturePath = new URL("../../../evals/nir1-packing/fixtures.json", import.meta.url);
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("D1 has twelve isolated, ordered packing fixtures", async () => {
  const manifest = await loadFixtures();
  assert.deepEqual(validateNir1PackingFixtures(manifest), []);
  assert.equal(new Set(manifest.cases.map((testCase) => testCase.artifactNamespace)).size, 12);
});

test("D1 fixtures reject incomplete atomic groups", async () => {
  const manifest = await loadFixtures();
  const invalid = structuredClone(manifest);
  invalid.cases[0].input = invalid.cases[0].input.filter((item) => item.atomicPart !== "evidence");
  const errors = validateNir1PackingFixtures(invalid);
  assert.ok(errors.some((error) => error.includes("missing evidence")));
});

test("D1 negative groups are complete and qualification outputs are declared", async () => {
  const manifest = await loadFixtures();
  for (const testCase of manifest.cases) {
    for (const groupId of testCase.expected.rejectedGroups ?? []) {
      const parts = testCase.input
        .filter((item) => item.atomicGroup === groupId)
        .map((item) => item.atomicPart);
      assert.deepEqual(
        new Set(parts),
        new Set(["statement", "negation", "attribution", "evidence", "qualification"]),
        `${testCase.caseId} ${groupId} must be complete`,
      );
    }
  }
  const invalid = structuredClone(manifest);
  invalid.cases[1].input[6].qualificationRef = "forged-label";
  assert.ok(validateNir1PackingFixtures(invalid).some((error) => error.includes("not a declared fixture-only output")));
});
