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

  it("binds ADR 005 AssertionModality and AssertionPolarity machine IDs and rejects drift", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    const expectedModalities = [
      "modality-explicit-text",
      "modality-narrator-claim",
      "modality-hearsay",
      "modality-character-belief",
      "modality-inference",
      "modality-hypothesis",
      "modality-author-declaration",
      "modality-imported-assertion",
    ];
    const expectedPolarities = ["affirmative", "negative", "uncertain"];

    assert.deepEqual(contract.vocabularies.assertionModalities, expectedModalities);
    assert.deepEqual(contract.vocabularies.assertionPolarities, expectedPolarities);

    const importedVocabularyIds = new Set([
      ...contract.vocabularies.producerKinds,
      ...contract.vocabularies.supportClasses,
    ]);
    assert.deepEqual(
      expectedModalities.filter((id) => importedVocabularyIds.has(id)),
      [],
      "Modality machine IDs must not collide with imported Producer or Support Class IDs",
    );

    const missingModality = structuredClone(contract);
    missingModality.vocabularies.assertionModalities =
      missingModality.vocabularies.assertionModalities.slice(0, -1);
    assert.ok(
      validate(missingModality).some((error) =>
        /AssertionModality.*exact ADR 005 vocabulary/i.test(error),
      ),
      "expected fail-closed AssertionModality validation",
    );

    const missingPolarity = structuredClone(contract);
    missingPolarity.vocabularies.assertionPolarities = ["affirmative", "negative"];
    assert.ok(
      validate(missingPolarity).some((error) =>
        /AssertionPolarity.*affirmative.*negative.*uncertain/i.test(error),
      ),
      "expected fail-closed AssertionPolarity validation",
    );
  });

  it("requires executable single-authority golden inputs and validates their outputs", async () => {
    const validatorModule = await import("./validate-narrative-ir-contract.mjs");
    assert.equal(
      typeof validatorModule.validateNarrativeIrGoldenFixture,
      "function",
      "golden fixtures need a reusable semantic validator",
    );

    const fixture = readJson(
      "policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json",
    );
    const scopeContract = readJson(
      "policies/narrative/narrative-scope-relation-contract.json",
    );
    const errors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      fixture,
      scopeContract,
      errors,
    );
    assert.deepEqual(errors, []);

    for (const entry of fixture.cases) {
      assert.equal(entry.input.adapter.id, fixture.adapter.id);
      assert.equal(entry.input.adapter.version, fixture.adapter.version);
      assert.equal(
        Object.hasOwn(entry.expected ?? {}, "typescript") ||
          Object.hasOwn(entry.expected ?? {}, "rust"),
        false,
        `${entry.id} must have one authoritative expected result`,
      );
      if (entry.kind !== "human-derivation") {
        assert.equal(
          Object.hasOwn(entry.expected ?? {}, "derivationKind"),
          false,
          `${entry.id} must not claim a Human-derived derivationKind`,
        );
      }
    }

    const badDigest = structuredClone(fixture);
    badDigest.cases.find((entry) => entry.expected?.scopeDigest).expected.scopeDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const digestErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      badDigest,
      scopeContract,
      digestErrors,
    );
    assert.ok(
      digestErrors.some((error) => /scopeDigest.*SHA-256/i.test(error)),
      `expected digest verification error: ${JSON.stringify(digestErrors)}`,
    );

    const badOrder = structuredClone(fixture);
    const orderedCase = badOrder.cases.find(
      (entry) => entry.expected?.canonicalScopeJson,
    );
    const parsedScope = JSON.parse(orderedCase.expected.canonicalScopeJson);
    orderedCase.expected.canonicalScopeJson = JSON.stringify({
      schemaVersion: parsedScope.schemaVersion,
      ...parsedScope,
    });
    const orderErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      badOrder,
      scopeContract,
      orderErrors,
    );
    assert.ok(
      orderErrors.some((error) => /canonical Scope JSON.*key order/i.test(error)),
      `expected canonical key-order error: ${JSON.stringify(orderErrors)}`,
    );

    const badHumanDiff = structuredClone(fixture);
    badHumanDiff.cases.find(
      (entry) => entry.id === "mixed-title-secret-uses-scope-override",
    ).expected.changedPaths = ["/title"];
    const diffErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      badHumanDiff,
      scopeContract,
      diffErrors,
    );
    assert.ok(
      diffErrors.some((error) => /mixed-title-secret.*changedPaths/i.test(error)),
      `expected Human-derived diff error: ${JSON.stringify(diffErrors)}`,
    );
  });

  it("resolves the CLI repository root from Windows file URLs", async () => {
    const validatorModule = await import("./validate-narrative-ir-contract.mjs");
    assert.equal(
      typeof validatorModule.resolveRepoRootFromModuleUrl,
      "function",
    );
    assert.equal(
      validatorModule.resolveRepoRootFromModuleUrl(
        "file:///C:/work/Grimodex/scripts/quality/validate-narrative-ir-contract.mjs",
        "win32",
      ),
      "C:\\work\\Grimodex",
    );
  });

});
