import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNarrativeIrContract } from "./validate-narrative-ir-contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  );
}

function validate(contract = readJson("policies/narrative/narrative-ir-contract.json")) {
  const errors = [];
  validateNarrativeIrContract(
    REPO_ROOT,
    contract,
    readJson("policies/narrative/narrative-scope-relation-contract.json"),
    readJson("policies/narrative/narrative-consumer-contract.json"),
    errors,
  );
  return errors;
}

describe("NIR-0 Narrative IR contract", () => {
  it("accepts the contract freeze policy and all required fixture families", () => {
    assert.deepEqual(validate(), []);
  });

  it("requires the mixed title plus secret edit to use cumulative scope-override", () => {
    const contract = structuredClone(
      readJson("policies/narrative/narrative-ir-contract.json"),
    );
    contract.humanDerived.classification.fixtures =
      contract.humanDerived.classification.fixtures.filter(
        (fixture) => fixture.id !== "mixed-title-secret-uses-scope-override",
      );

    const errors = validate(contract);

    assert.ok(
      errors.some((error) =>
        /mixed-title-secret-uses-scope-override.*scope-override/i.test(error),
      ),
      `expected a mixed-edit classification error: ${JSON.stringify(errors)}`,
    );
  });

  it("requires Interpretation and Human-derived stale validation to remain split", () => {
    const contract = structuredClone(
      readJson("policies/narrative/narrative-ir-contract.json"),
    );
    contract.staleValidation.humanDerived.requireLiveSourceTokenEquality = true;

    const errors = validate(contract);

    assert.ok(
      errors.some((error) => /human-derived.*must not require live source token/i.test(error)),
      `expected a stale validation split error: ${JSON.stringify(errors)}`,
    );
  });

  it("keeps V2 production activation disabled until C2B child declarations and Freshness", () => {
    const contract = structuredClone(
      readJson("policies/narrative/narrative-ir-contract.json"),
    );
    contract.activation.productionEntryPoints = ["src/features/chronicle"];

    const errors = validate(contract);

    assert.ok(
      errors.some((error) => /activation.*production entry point/i.test(error)),
      `expected an activation gate error: ${JSON.stringify(errors)}`,
    );
  });

  it("binds the Narrative IR revision to proposal-revision without activating a second Consumer", () => {
    const contract = structuredClone(
      readJson("policies/narrative/narrative-ir-contract.json"),
    );
    contract.identity.consumerKind = "narrative-ir-revision";

    const errors = validate(contract);

    assert.ok(
      errors.some((error) => /proposal-revision.*identity|narrative-ir-revision.*not-yet-modelled/i.test(error)),
      `expected a Consumer identity error: ${JSON.stringify(errors)}`,
    );
  });

  it("requires the Scope Disclosure adoption track to remain independent", () => {
    const scope = readJson(
      "policies/narrative/narrative-scope-relation-contract.json",
    );
    scope.adoptionTrack.owner = "narrative-ir-contract";

    const errors = [];
    validateNarrativeIrContract(
      REPO_ROOT,
      readJson("policies/narrative/narrative-ir-contract.json"),
      scope,
      readJson("policies/narrative/narrative-consumer-contract.json"),
      errors,
    );

    assert.ok(
      errors.some((error) => /Disclosure adoption.*independent|must not own/i.test(error)),
      `expected an independent adoption-track error: ${JSON.stringify(errors)}`,
    );
  });
});
