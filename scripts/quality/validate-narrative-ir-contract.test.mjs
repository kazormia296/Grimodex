import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateNarrativeIrContract,
  validateNarrativeIrContractFromRepo,
} from "./validate-narrative-ir-contract.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function validate(
  contract = readJson("policies/narrative/narrative-ir-contract.json"),
) {
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

function validateSchema(contract) {
  const schema = readJson(
    "policies/narrative/schemas/narrative-ir-contract.schema.json",
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return validate(contract) ? [] : (validate.errors ?? []);
}

function readProposalSchema() {
  return readJson(
    "policies/narrative/schemas/chronicle-event-proposal-v1.schema.json",
  );
}

function findClosedObjectSchemaOmissions(schema, schemaPath = "#") {
  if (schema === null || typeof schema !== "object") {
    return [];
  }

  const omissions = [];
  if (
    schema.type === "object" &&
    schema.additionalProperties === false &&
    Array.isArray(schema.required)
  ) {
    const declared = schema.properties ?? {};
    for (const key of schema.required) {
      if (!Object.hasOwn(declared, key)) {
        omissions.push(`${schemaPath}/${key}`);
      }
    }
  }

  for (const [key, value] of Object.entries(schema)) {
    if (value !== null && typeof value === "object") {
      omissions.push(
        ...findClosedObjectSchemaOmissions(value, `${schemaPath}/${key}`),
      );
    }
  }

  return omissions;
}

describe("NIR-0 Narrative IR contract", () => {
  it("accepts the contract freeze policy and all required fixture families", () => {
    assert.deepEqual(validate(), []);
  });

  it("pins the additive stage provenance sidecar contract and rejects scope drift", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    assert.deepEqual(validateSchema(contract), []);
    assert.equal(contract.stageProvenance.auditVersion, 2);
    assert.equal(
      contract.stageProvenance.envelopeChange,
      "stageProvenanceClosureDigest-forbidden",
    );

    const mutated = structuredClone(contract);
    mutated.stageProvenance.requestDigestExcludesModel = false;
    const errors = validate(mutated);
    assert.ok(
      errors.some((error) =>
        /stage provenance.*request-only digest/i.test(error),
      ),
      `expected request digest scope to fail closed: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects independent stage provenance contract mutations", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    const mutations = [
      [
        "binding status matrix",
        (value) => {
          value.stageProvenance.bindingContract.statusMatrix[
            "requested-only"
          ].forbidden = [];
        },
        /model binding fields.*status matrix/i,
      ],
      [
        "terminal status matrix",
        (value) => {
          value.stageProvenance.terminalReceiptContract.statusMatrix[0].responseDigest =
            "null";
        },
        /terminal receipt status matrix/i,
      ],
      [
        "C1 owner digest",
        (value) => {
          value.stageProvenance.c1Completeness.ownerDigestsMatchExecution = false;
        },
        /C1 completeness.*owner digest/i,
      ],
      [
        "repair lineage",
        (value) => {
          value.stageProvenance.c1Completeness.repairLineage.sameTaskAndAttempt = false;
        },
        /C1 completeness.*repair lineage/i,
      ],
      [
        "closure self digest",
        (value) => {
          value.stageProvenance.closureContract.selfDigest = "caller-supplied";
        },
        /closure.*canonical.*self-digest/i,
      ],
      [
        "closure authority",
        (value) => {
          value.stageProvenance.closureContract.authoritative = true;
        },
        /closure.*non-authoritative/i,
      ],
      [
        "source literal pin",
        (value) => {
          value.stageProvenance.sourceLiteralPins.digestDomains[2].literal =
            "wrong-domain";
        },
        /source literal pins/i,
      ],
      [
        "rust digest-domain pin coverage",
        (value) => {
          // Dropping every Rust-side pin must fail even though all three
          // domains stay pinned on the TS side: both boundaries declare the
          // domains independently.
          value.stageProvenance.sourceLiteralPins.digestDomains =
            value.stageProvenance.sourceLiteralPins.digestDomains.filter(
              (pin) => !pin.path.endsWith(".rs"),
            );
        },
        /source literal pins/i,
      ],
      [
        "implementation pin membership",
        (value) => {
          value.stageProvenance.sourceLiteralPins.implementationPins.pop();
        },
        /implementation pins/i,
      ],
      [
        "implementation pin literal",
        (value) => {
          value.stageProvenance.sourceLiteralPins.implementationPins[0].literals.pop();
        },
        /implementation pins/i,
      ],
      [
        "persistence lifecycle",
        (value) => {
          value.stageProvenance.persistence.lifecycle = "rebuildable";
        },
        /ephemeral.*sidecar/i,
      ],
    ];
    for (const [, mutate, pattern] of mutations) {
      const mutated = structuredClone(contract);
      mutate(mutated);
      const errors = validate(mutated);
      assert.ok(
        errors.some((error) => pattern.test(error)),
        `expected mutation to fail: ${pattern}; got ${JSON.stringify(errors)}`,
      );
    }

    for (const field of [
      "lifecycle",
      "authority",
      "authoritative",
      "storage",
      "retention",
      "scope",
      "membership",
    ]) {
      const mutated = structuredClone(contract);
      delete mutated.stageProvenance.persistence[field];
      const schemaErrors = validateSchema(mutated);
      assert.ok(
        schemaErrors.length > 0,
        `persistence.${field} must remain schema-required`,
      );
    }
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
      errors.some((error) =>
        /human-derived.*must not require live source token/i.test(error),
      ),
      `expected a stale validation split error: ${JSON.stringify(errors)}`,
    );
  });

  it("freezes the Human-derived request, Native ownership, and persisted basis boundaries", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    const expectedRequestFields = [
      "proposalId",
      "expectedCurrentRevisionId",
      "parentRevisionId",
      "expectedParentEnvelopeDigest",
      "proposalPayload",
      "adapter",
      "surfaceId",
    ];
    const expectedNativeOwnedFields = [
      "parentLookupAndCas",
      "proposalPayloadDiff",
      "pathClassification",
      "strongestDerivationClassification",
      "childAssertionAndScope",
      "effectiveMaterialBasis",
      "digestComputation",
      "dependencyDeclaration",
      "currentEpochFreshness",
      "finalPersistence",
    ];
    const expectedPersistedBasis = [
      "parentRevisionId",
      "expectedParentEnvelopeDigest",
      "parentAssertionDigest",
      "rootInterpretationRevisionId",
      "derivation",
      "revisionActor",
      "derivationContextSet",
      "derivationContextSetDigest",
    ];

    assert.deepEqual(
      contract.humanDerived.requestFields,
      expectedRequestFields,
    );
    assert.deepEqual(
      contract.humanDerived.clientSubmittedFields,
      expectedRequestFields,
    );
    assert.deepEqual(
      contract.humanDerived.nativeOwnedFields,
      expectedNativeOwnedFields,
    );
    assert.deepEqual(
      contract.humanDerived.persistedBasis,
      expectedPersistedBasis,
    );
    assert.deepEqual(validateSchema(contract), []);

    const mutations = [
      {
        label: "clientSubmittedFields accepts changeIntent",
        mutate: (candidate) =>
          candidate.humanDerived.clientSubmittedFields.push("changeIntent"),
      },
      {
        label: "requestFields renames proposalId",
        mutate: (candidate) => {
          candidate.humanDerived.requestFields[0] = "clientChosenScope";
        },
      },
      {
        label: "nativeOwnedFields loses parentLookupAndCas",
        mutate: (candidate) => {
          candidate.humanDerived.nativeOwnedFields =
            candidate.humanDerived.nativeOwnedFields.filter(
              (field) => field !== "parentLookupAndCas",
            );
        },
      },
      {
        label: "nativeOwnedFields loses digestComputation",
        mutate: (candidate) => {
          candidate.humanDerived.nativeOwnedFields =
            candidate.humanDerived.nativeOwnedFields.filter(
              (field) => field !== "digestComputation",
            );
        },
      },
      {
        label: "persistedBasis loses rootInterpretationRevisionId",
        mutate: (candidate) => {
          candidate.humanDerived.persistedBasis =
            candidate.humanDerived.persistedBasis.filter(
              (field) => field !== "rootInterpretationRevisionId",
            );
        },
      },
      {
        label: "persistedBasis loses revisionActor",
        mutate: (candidate) => {
          candidate.humanDerived.persistedBasis =
            candidate.humanDerived.persistedBasis.filter(
              (field) => field !== "revisionActor",
            );
        },
      },
    ];

    for (const { label, mutate } of mutations) {
      const mutated = structuredClone(contract);
      mutate(mutated);
      assert.notDeepEqual(
        validate(mutated),
        [],
        `${label} must fail semantic validation`,
      );
      assert.notDeepEqual(
        validateSchema(mutated),
        [],
        `${label} must fail JSON Schema validation`,
      );
    }
  });

  it("freezes the Envelope V2 required field shape", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    const expectedRequiredFields = [
      "assertion",
      "assertionDigests",
      "changeIntent",
      "effectiveMaterialBasis",
      "revisionBasis",
      "projectionBinding",
    ];

    assert.deepEqual(contract.envelope.requiredFields, expectedRequiredFields);
    assert.deepEqual(validate(contract), []);
    assert.deepEqual(validateSchema(contract), []);

    for (const extraField of ["reviewDecision", "freshnessState"]) {
      const mutated = structuredClone(contract);
      mutated.envelope.requiredFields.push(extraField);
      assert.ok(
        validate(mutated).some((error) =>
          /Envelope V2 requiredFields/i.test(error),
        ),
        `${extraField} must fail semantic validation`,
      );
      assert.notDeepEqual(
        validateSchema(mutated),
        [],
        `${extraField} must fail JSON Schema validation`,
      );
    }
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
      errors.some((error) =>
        /proposal-revision.*identity|narrative-ir-revision.*not-yet-modelled/i.test(
          error,
        ),
      ),
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
      errors.some((error) =>
        /Disclosure adoption.*independent|must not own/i.test(error),
      ),
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

    assert.deepEqual(
      contract.vocabularies.assertionModalities,
      expectedModalities,
    );
    assert.deepEqual(
      contract.vocabularies.assertionPolarities,
      expectedPolarities,
    );

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
    missingPolarity.vocabularies.assertionPolarities = [
      "affirmative",
      "negative",
    ];
    assert.ok(
      validate(missingPolarity).some((error) =>
        /AssertionPolarity.*affirmative.*negative.*uncertain/i.test(error),
      ),
      "expected fail-closed AssertionPolarity validation",
    );
  });

  it("requires executable single-authority golden inputs and validates their outputs", async () => {
    const validatorModule =
      await import("./validate-narrative-ir-contract.mjs");
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
    const proposalSchema = readProposalSchema();
    const errors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      fixture,
      scopeContract,
      errors,
      proposalSchema,
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
    badDigest.cases.find(
      (entry) => entry.expected?.scopeDigest,
    ).expected.scopeDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const digestErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      badDigest,
      scopeContract,
      digestErrors,
      proposalSchema,
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
      proposalSchema,
    );
    assert.ok(
      orderErrors.some((error) =>
        /canonical Scope JSON.*key order/i.test(error),
      ),
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
      proposalSchema,
    );
    assert.ok(
      diffErrors.some((error) =>
        /mixed-title-secret.*changedPaths/i.test(error),
      ),
      `expected Human-derived diff error: ${JSON.stringify(diffErrors)}`,
    );

    const missingRequiredField = structuredClone(fixture);
    delete missingRequiredField.cases.find(
      (entry) => entry.id === "non-secret-event",
    ).input.proposalPayload.actuality;
    const missingFieldErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      missingRequiredField,
      scopeContract,
      missingFieldErrors,
      proposalSchema,
    );
    assert.ok(
      missingFieldErrors.some((error) =>
        /non-secret-event.*complete.*Proposal payload/i.test(error),
      ),
      `expected missing Proposal field error: ${JSON.stringify(missingFieldErrors)}`,
    );

    const nullRevealDocumentRef = structuredClone(fixture);
    nullRevealDocumentRef.cases.find(
      (entry) => entry.id === "non-secret-event",
    ).input.proposalPayload.disclosure.revealDocumentRef = null;
    const nullRevealErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      nullRevealDocumentRef,
      scopeContract,
      nullRevealErrors,
      proposalSchema,
    );
    assert.ok(
      nullRevealErrors.some((error) =>
        /non-secret-event.*complete.*Proposal payload/i.test(error),
      ),
      `expected null revealDocumentRef error: ${JSON.stringify(nullRevealErrors)}`,
    );

    const wronglyAcceptedActuality = structuredClone(fixture);
    const unsupportedPathCase = wronglyAcceptedActuality.cases.find(
      (entry) => entry.id === "unsupported-path-refused",
    );
    assert.deepEqual(unsupportedPathCase.expected.changedPaths, ["/actuality"]);
    unsupportedPathCase.expected.disposition = "accept";
    unsupportedPathCase.expected.derivationKind = "projection-only";
    unsupportedPathCase.expected.changedPathClasses = ["projection-only"];
    const actualityErrors = [];
    validatorModule.validateNarrativeIrGoldenFixture(
      wronglyAcceptedActuality,
      scopeContract,
      actualityErrors,
      proposalSchema,
    );
    assert.ok(
      actualityErrors.some((error) =>
        /unsupported-path-refused.*disposition/i.test(error),
      ),
      `expected root /actuality rejection error: ${JSON.stringify(actualityErrors)}`,
    );
  });

  it("resolves the CLI repository root from Windows file URLs", async () => {
    const validatorModule =
      await import("./validate-narrative-ir-contract.mjs");
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

  it("separates observed changed path classes from cumulative allowed sets", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    const classification = contract.humanDerived.classification;

    assert.deepEqual(
      classification.cumulativeAllowedPathClasses,
      {
        projectionOnly: ["projection-only"],
        scopeOverride: ["projection-only", "scope-affecting"],
        assertionOverride: [],
      },
      "derivation-level allowed sets remain cumulative and authoritative",
    );

    for (const fixture of classification.fixtures) {
      assert.equal(
        Object.hasOwn(fixture, "allowedPathClasses"),
        false,
        `${fixture.id} must not overload allowedPathClasses with observed data`,
      );
      if (fixture.expectedDisposition === "accept") {
        assert.ok(
          Array.isArray(fixture.changedPathClasses),
          `${fixture.id} must record its observed changedPathClasses`,
        );
      }
    }

    assert.deepEqual(
      classification.fixtures.find(
        (fixture) => fixture.id === "secret-only-edit",
      ).changedPathClasses,
      ["scope-affecting"],
    );
    assert.deepEqual(
      classification.fixtures.find(
        (fixture) => fixture.id === "mixed-title-secret-uses-scope-override",
      ).changedPathClasses,
      ["projection-only", "scope-affecting"],
    );

    const corpus = readJson(
      "policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json",
    );
    for (const fixture of corpus.cases.filter(
      (entry) =>
        entry.kind === "human-derivation" &&
        entry.expected?.disposition === "accept",
    )) {
      assert.equal(
        Object.hasOwn(fixture.expected, "allowedPathClasses"),
        false,
        `${fixture.id} golden output must not overload allowedPathClasses`,
      );
      assert.ok(
        Array.isArray(fixture.expected.changedPathClasses),
        `${fixture.id} golden output must expose observed changedPathClasses`,
      );
    }

    const ambiguous = structuredClone(contract);
    const ambiguousFixture =
      ambiguous.humanDerived.classification.fixtures.find(
        (fixture) => fixture.id === "secret-only-edit",
      );
    ambiguousFixture.allowedPathClasses = ambiguousFixture.changedPathClasses;
    delete ambiguousFixture.changedPathClasses;
    const errors = validate(ambiguous);
    assert.ok(
      errors.some((error) =>
        /allowedPathClasses.*ambiguous|changedPathClasses.*observed/i.test(
          error,
        ),
      ),
      `expected ambiguous path-class field error: ${JSON.stringify(errors)}`,
    );
  });

  it("declares the implemented V2 monotonicity trigger while keeping the typed writer authoritative", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");

    assert.deepEqual(contract.monotonicity, {
      currentRevisionRule: "once-v2-always-v2",
      forbiddenTransitions: [
        "v2-to-v1",
        "v2-to-no-envelope",
        "v2-to-legacy-unbound",
        "v2-to-legacy-inherit-reconciliation-envelope",
      ],
      semanticAuthority: "typed-writer",
      typedWriterValidation: [
        "parent-current-revision-cas",
        "v2-lineage-monotonicity",
        "adapter-version",
        "digest-recomputation",
        "derivation-invariants",
        "material-basis",
        "change-intent",
        "proposal-binding",
      ],
      structuralDefense: {
        kind: "sqlite-before-insert-trigger",
        role: "structural-defense-only",
        state: "implemented-wired",
        productionEntryPoints: [
          "src-tauri/crates/grimodex-db/src/migrate.rs::repair_narrative_v2_monotonicity_trigger",
        ],
        errorCode: "NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN",
      },
      contractFreezeOnly: false,
    });

    const missingDowngrade = structuredClone(contract);
    missingDowngrade.monotonicity.forbiddenTransitions =
      missingDowngrade.monotonicity.forbiddenTransitions.filter(
        (transition) => transition !== "v2-to-no-envelope",
      );
    const errors = validate(missingDowngrade);
    assert.ok(
      errors.some((error) =>
        /V2 monotonicity.*forbid every downgrade/i.test(error),
      ),
      `expected fail-closed V2 monotonicity error: ${JSON.stringify(errors)}`,
    );

    // Bidirectional status check: the trigger exists in migrate.rs, so a
    // policy that still declares it deferred/contract-only must fail.
    const staleDeferred = structuredClone(contract);
    staleDeferred.monotonicity.structuralDefense.state =
      "deferred-until-after-c2-zb";
    staleDeferred.monotonicity.structuralDefense.productionEntryPoints = [];
    staleDeferred.monotonicity.contractFreezeOnly = true;
    const staleErrors = validate(staleDeferred);
    assert.ok(
      staleErrors.some((error) =>
        /implemented-wired.*migrate\.rs/i.test(error),
      ),
      `expected stale deferred-trigger declaration error: ${JSON.stringify(staleErrors)}`,
    );
  });

  it("declares durable terminal receipt persistence separately from the ephemeral closure sidecar", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");

    assert.equal(
      contract.stageProvenance.persistence.appliesTo,
      "application-closure-sidecar",
    );
    assert.deepEqual(contract.stageProvenance.terminalReceiptPersistence, {
      owner: "native-typed-c2a-finish",
      appliesTo: "stage-terminal-receipts-and-model-bindings",
      status: "implemented-durable",
      lifecycle: "durable",
      authority: "audit-only",
      authoritative: false,
      storage: "sqlite-workspace-db",
      tables: [
        "narrative_extraction_stage_model_bindings",
        "narrative_extraction_stage_receipts",
      ],
      productionEntryPoints: [
        "src-tauri/crates/grimodex-db/src/narrative_extraction/stage_provenance.rs::persist_receipt",
      ],
    });

    // Bidirectional status check: the receipt writer and its schema tables
    // exist in Rust source, so a policy that hides the durable layer (or
    // points at the wrong writer) must fail.
    const hiddenDurable = structuredClone(contract);
    delete hiddenDurable.stageProvenance.terminalReceiptPersistence;
    const hiddenErrors = validate(hiddenDurable);
    assert.ok(
      hiddenErrors.some((error) =>
        /implemented-durable.*persist_receipt/i.test(error),
      ),
      `expected missing durable receipt declaration error: ${JSON.stringify(hiddenErrors)}`,
    );

    const wrongWriter = structuredClone(contract);
    wrongWriter.stageProvenance.terminalReceiptPersistence.productionEntryPoints =
      [
        "src-tauri/crates/grimodex-db/src/narrative_extraction/stage_provenance.rs::persist_stage_bundle_if_present",
      ];
    const wrongWriterErrors = validate(wrongWriter);
    assert.ok(
      wrongWriterErrors.some((error) =>
        /implemented-durable.*persist_receipt/i.test(error),
      ),
      `expected wrong receipt writer error: ${JSON.stringify(wrongWriterErrors)}`,
    );
  });

  it("keeps Chronicle pilot product wiring add-only and states the Project deletion boundary", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");

    assert.deepEqual(contract.chroniclePilot, {
      assertionKind: "scene-event@1",
      productWiredChangeKinds: ["add"],
      declaredOrReservedChangeKinds: ["revise", "retract", "merge", "split"],
      existingProjectionRevisionStatus:
        "requires-separately-ratified-proposal-kind-and-apply-path",
    });

    const overWired = structuredClone(contract);
    overWired.chroniclePilot.productWiredChangeKinds = ["add", "revise"];
    const errors = validate(overWired);
    assert.ok(
      errors.some((error) =>
        /Chronicle pilot.*product-wired.*only add/i.test(error),
      ),
      `expected fail-closed Chronicle pilot wiring error: ${JSON.stringify(errors)}`,
    );

    const adr = readFileSync(
      path.join(
        REPO_ROOT,
        "docs/adr/011-narrative-ir-revision-semantics-contract.md",
      ),
      "utf8",
    );
    assert.match(adr, /not guaranteed after physical Project deletion/i);
    assert.match(adr, /not a globally permanent external identifier/i);
  });

  it("binds the V1 reconciler producer mapping and portable referenced closure", () => {
    const contract = readJson("policies/narrative/narrative-ir-contract.json");

    assert.deepEqual(contract.v1ProducerMapping, {
      producerKind: "reconciler-proposal",
      producerIdSource: "reconcilerId",
      producerVersionSource: "reconcilerVersion",
    });
    assert.deepEqual(contract.identity.portableExport, {
      requiredClosure: "referenced-closure",
      originalProjectAvailability: "must-not-be-assumed",
    });

    const driftedMapping = structuredClone(contract);
    driftedMapping.v1ProducerMapping.producerKind = "ai-inference";
    assert.ok(
      validate(driftedMapping).some((error) =>
        /V1 reconciler.*producer.kind.*reconciler-proposal/i.test(error),
      ),
      "expected fail-closed V1 producer mapping validation",
    );

    const missingClosure = structuredClone(contract);
    missingClosure.identity.portableExport.requiredClosure = "identity-only";
    assert.ok(
      validate(missingClosure).some((error) =>
        /portable Narrative IR export.*referenced closure/i.test(error),
      ),
      "expected fail-closed portable export closure validation",
    );
  });

  it("keeps Scope capability blockers conditional on lifecycle state", () => {
    const schema = readJson(
      "policies/narrative/schemas/narrative-scope-relation-contract.schema.json",
    );
    const capability = schema.$defs.scopeCapabilityStatus;
    const lifecycleRule = capability.allOf.find(
      (rule) => rule.if?.properties?.state?.const === "declared",
    );

    assert.equal(
      Object.hasOwn(capability.properties.blockedOn, "minItems"),
      false,
      "wired capabilities must be able to clear their blockers",
    );
    assert.equal(lifecycleRule.then.properties.blockedOn.minItems, 1);
    assert.equal(
      lifecycleRule.then.properties.productionEntryPoints.maxItems,
      0,
    );
    assert.equal(
      lifecycleRule.else.properties.productionEntryPoints.minItems,
      1,
    );
  });

  it("scans only configured production roots for the exact disabled-activation markers", async () => {
    const validatorModule =
      await import("./validate-narrative-ir-contract.mjs");
    assert.equal(
      typeof validatorModule.scanNarrativeIrProductionMarkers,
      "function",
    );

    const contract = readJson("policies/narrative/narrative-ir-contract.json");
    assert.deepEqual(contract.activation.scanRoots, [
      "src",
      "electron",
      "src-tauri",
    ]);
    assert.deepEqual(contract.activation.productionMarkers, [
      "NARRATIVE_IR_V2_PRODUCTION_ENABLED",
      "createHumanDerivedNarrativeRevisionV2",
      "CHRONICLE_SCENE_EVENT_V2_PRODUCTION",
    ]);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "nir0-activation-"));
    try {
      mkdirSync(path.join(tempRoot, "src"), { recursive: true });
      mkdirSync(path.join(tempRoot, "docs"), { recursive: true });
      writeFileSync(
        path.join(tempRoot, "src", "producer.ts"),
        "export const marker = 'CHRONICLE_SCENE_EVENT_V2_PRODUCTION';\n",
      );
      writeFileSync(
        path.join(tempRoot, "src", "producer.test.ts"),
        "const marker = 'NARRATIVE_IR_V2_PRODUCTION_ENABLED';\n",
      );
      writeFileSync(
        path.join(tempRoot, "docs", "contract.md"),
        "createHumanDerivedNarrativeRevisionV2\n",
      );

      assert.deepEqual(
        validatorModule.scanNarrativeIrProductionMarkers(
          tempRoot,
          contract.activation.scanRoots,
          contract.activation.productionMarkers,
        ),
        [
          {
            marker: "CHRONICLE_SCENE_EVENT_V2_PRODUCTION",
            path: "src/producer.ts",
          },
        ],
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    const missingMarker = structuredClone(contract);
    missingMarker.activation.productionMarkers =
      missingMarker.activation.productionMarkers.slice(1);
    assert.ok(
      validate(missingMarker).some((error) =>
        /activation productionMarkers.*exact reserved vocabulary/i.test(error),
      ),
      "expected fail-closed activation marker vocabulary validation",
    );
  });

  it("runs the activation filesystem scan only in repo-level validation", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "nir0-repo-scan-"));
    try {
      const artifacts = [
        "policies/narrative/narrative-ir-contract.json",
        "policies/narrative/narrative-scope-relation-contract.json",
        "policies/narrative/narrative-consumer-contract.json",
        "policies/narrative/fixtures/narrative-ir/chronicle-scene-event-v2.json",
      ];
      for (const relativePath of artifacts) {
        const target = path.join(tempRoot, relativePath);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(
          target,
          `${JSON.stringify(readJson(relativePath), null, 2)}\n`,
        );
      }
      mkdirSync(path.join(tempRoot, "src"), { recursive: true });
      writeFileSync(
        path.join(tempRoot, "src", "producer.ts"),
        "export const marker = 'CHRONICLE_SCENE_EVENT_V2_PRODUCTION';\n",
      );

      const contract = readJson(
        "policies/narrative/narrative-ir-contract.json",
      );
      const scope = readJson(
        "policies/narrative/narrative-scope-relation-contract.json",
      );
      const consumer = readJson(
        "policies/narrative/narrative-consumer-contract.json",
      );
      const pureErrors = [];
      validateNarrativeIrContract(
        tempRoot,
        contract,
        scope,
        consumer,
        pureErrors,
      );
      assert.equal(
        pureErrors.some((error) =>
          /activation marker.*appears in production/i.test(error),
        ),
        false,
        "pure contract mutation checks must not rescan production",
      );

      const repoResult = validateNarrativeIrContractFromRepo(tempRoot);
      assert.ok(
        repoResult.errors.some((error) =>
          /activation marker.*appears in production/i.test(error),
        ),
        `expected repo-level activation marker error: ${JSON.stringify(repoResult.errors)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("declares every required key in each fail-closed object schema", () => {
    const schema = readJson(
      "policies/narrative/schemas/narrative-ir-contract.schema.json",
    );
    assert.deepEqual(findClosedObjectSchemaOmissions(schema), []);
  });
});
