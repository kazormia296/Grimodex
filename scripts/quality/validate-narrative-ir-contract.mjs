#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_CASE_IDS = Object.freeze([
  "non-secret-event",
  "secret-event-with-resolved-reveal",
  "secret-event-with-unresolved-reveal",
  "title-only-edit",
  "secret-only-edit",
  "reveal-document-only-edit",
  "mixed-title-secret-uses-scope-override",
  "mixed-note-reveal-document-uses-scope-override",
  "unsupported-path-refused",
  "canonical-scope-digest-parity",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(repoRoot, relativePath, errors, label) {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) {
    errors.push(`${label} is missing: ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function hasPaths(paths, expected) {
  return Array.isArray(paths) && expected.every((value) => paths.includes(value));
}

function pushIf(errors, condition, message) {
  if (!condition) errors.push(message);
}

export function validateNarrativeIrContract(repoRoot, contract, scopeContract, consumerContract, errors = []) {
  if (!isObject(contract)) {
    errors.push("narrative IR contract must be an object");
    return errors;
  }
  pushIf(errors, contract.schemaVersion === 1 && contract.contract === "narrative-ir-contract", "narrative IR contract identity/version is invalid");
  pushIf(errors, contract.adr === "docs/adr/011-narrative-ir-revision-semantics-contract.md", "narrative IR contract must be bound to ADR 011");
  pushIf(errors, contract.contractVersion === "narrative-ir/2", "narrative IR contract version must be narrative-ir/2");

  const identity = contract.identity;
  pushIf(errors, identity?.revisionTable === "narrative_proposal_revisions" && identity?.revisionIdColumn === "id", "Narrative IR revision identity must be narrative_proposal_revisions.id");
  pushIf(errors, identity?.consumerKind === "proposal-revision", "Narrative IR revision identity must use the proposal-revision Consumer");
  pushIf(errors, identity?.projectScoped === true && identity?.durability === "while-project-exists", "Narrative IR revision durability must be project-scoped while the Project exists");
  pushIf(errors, JSON.stringify(identity?.portableReference) === JSON.stringify(["projectId","revisionId","envelopeDigest","contractVersion"]), "portable Narrative IR references must include projectId, revisionId, envelopeDigest, and contractVersion");
  pushIf(errors, identity?.independentRevisionConsumer === "narrative-ir-revision" && identity?.independentRevisionConsumerStatus === "not-yet-modelled" && identity?.heuristicIdentity === "forbid", "narrative-ir-revision must remain not-yet-modelled and heuristic identity must be forbidden");

  const vocab = contract.vocabularies;
  pushIf(errors, JSON.stringify(vocab?.assertionKinds) === JSON.stringify(["scene-event@1"]), "NIR-0 must wire only scene-event@1");
  pushIf(errors, JSON.stringify(vocab?.changeKinds) === JSON.stringify(["add","revise","retract","merge","split"]), "changeKind vocabulary must retain add/revise/retract/merge/split");
  pushIf(errors, JSON.stringify(vocab?.producerKinds) === JSON.stringify(["ai-inference","reconciler-proposal","author-declaration","import-metadata","legacy-migration"]), "Producer Kind vocabulary must reuse the ratified values");
  pushIf(errors, JSON.stringify(vocab?.supportClasses) === JSON.stringify(["author-declared","direct-source","reported-source","single-source-inference","multi-source-inference","imported-assertion","unresolved"]), "Support Class vocabulary must reuse the ratified values");

  pushIf(errors, contract.envelope?.schemaVersion === 2, "Narrative Revision Envelope must be V2");
  pushIf(errors, hasPaths(contract.envelope?.requiredFields, ["assertion","assertionDigests","changeIntent","effectiveMaterialBasis","revisionBasis","projectionBinding"]), "Narrative Revision Envelope V2 required fields are incomplete");
  pushIf(errors, contract.envelope?.assertionDigestDomains?.disclosureFieldsExcludedFromAssertionCore?.includes("secret") && contract.envelope?.assertionDigestDomains?.disclosureFieldsExcludedFromAssertionCore?.includes("revealDocumentRef"), "Disclosure fields must remain outside Assertion Core");
  pushIf(errors, contract.envelope?.changeIntent?.humanDerivedMustPreserve === "exact", "Human-derived Revision must preserve root-level Change Intent exactly");
  pushIf(errors, contract.envelope?.projectionBinding?.recomputePayloadDigestInNative === true && contract.envelope?.projectionBinding?.proposalKindAndSchemaDistinct === true, "Native must own payload digest and Proposal kind/schema binding");

  const human = contract.humanDerived;
  pushIf(errors, hasPaths(human?.contextExposureAllowed, ["deterministic-stage","author-supplied"]) && human?.contextExposureForbidden?.includes("model-visible"), "Human-derived Context Set must exclude model-visible exposure");
  pushIf(errors, hasPaths(human?.nativeOwnedFields, ["proposalPayloadDiff","pathClassification","strongestDerivationClassification","effectiveMaterialBasis","dependencyDeclaration","currentEpochFreshness"]), "Native must own Human-derived diff, classification, basis, Dependencies, and Freshness");
  pushIf(errors, !human?.clientSubmittedFields?.some((field) => ["derivationKind","changedPaths","scope","childAssertion","childDigests"].includes(field)), "Clients must not submit derivation metadata, child Scope, Assertion, or digests");
  const classes = human?.classification;
  pushIf(errors, JSON.stringify(classes?.precedence) === JSON.stringify(["assertion-override","scope-override","projection-only"]), "Human-derived classification precedence must be assertion-override > scope-override > projection-only");
  pushIf(errors, JSON.stringify(classes?.pathClasses?.projectionOnly) === JSON.stringify(["/title","/note"]) && JSON.stringify(classes?.pathClasses?.scopeAffecting) === JSON.stringify(["/disclosure/secret","/disclosure/revealDocumentRef"]) && Array.isArray(classes?.pathClasses?.assertionAffecting) && classes.pathClasses.assertionAffecting.length === 0, "Chronicle Human-derived path classes are invalid");
  pushIf(errors, classes?.cumulativeAllowedPathClasses?.scopeOverride?.includes("projection-only") && classes?.cumulativeAllowedPathClasses?.scopeOverride?.includes("scope-affecting"), "scope-override must allow the cumulative projection-only and scope-affecting path union");
  pushIf(errors, classes?.unknownPathPolicy === "reject" && classes?.clientMetadataAuthority === "forbid" && classes?.assertionOverrideStatus === "reserved-rejected", "unknown paths, client metadata, and assertion override must fail closed");

  const classFixtures = new Map((classes?.fixtures ?? []).map((fixture) => [fixture?.id, fixture]));
  pushIf(errors, classFixtures.get("mixed-title-secret-uses-scope-override")?.expectedDerivationKind === "scope-override" && hasPaths(classFixtures.get("mixed-title-secret-uses-scope-override")?.allowedPathClasses, ["projection-only","scope-affecting"]), "mixed-title-secret-uses-scope-override must be scope-override with the cumulative path union");
  pushIf(errors, classFixtures.get("mixed-note-reveal-document-uses-scope-override")?.expectedDerivationKind === "scope-override", "mixed-note-reveal-document edit must be scope-override");

  pushIf(errors, contract.materialBasis?.humanDerivedOwnsDeclarations === true && contract.materialBasis?.noLineageFreshnessAuthority === true && contract.materialBasis?.zeroEdgeCurrentRevision === "forbidden" && contract.materialBasis?.currentEpochEvaluation === "atomic-before-current-revision-promotion", "Human-derived material basis must own child declarations and atomic current-Epoch Freshness");
  pushIf(errors, contract.consumerBinding?.consumerKind === "proposal-revision" && contract.consumerBinding?.childHumanDerivedRevisionIsFirstClassConsumer === true && contract.consumerBinding?.hiddenRootLineageLookup === "forbid", "Human-derived Revisions must be first-class proposal-revision Consumers without lineage Freshness lookup");

  pushIf(errors, contract.staleValidation?.interpretation?.requireLiveSourceTokenEquality === true && contract.staleValidation?.interpretation?.staleRefusal === "NEX_READ_SET_STALE", "Interpretation saves must retain live Source token validation");
  pushIf(errors, contract.staleValidation?.humanDerived?.requireLiveSourceTokenEquality === false, "Human-derived saves must not require live Source token equality");
  pushIf(errors, contract.staleValidation?.humanDerived?.preserveObservedTokens === true && contract.staleValidation?.humanDerived?.evaluateAgainstCurrentLiveSource === true && contract.staleValidation?.humanDerived?.doesNotBypassApplyOCC === true, "Human-derived stale validation must preserve observed tokens, publish current state, and retain Apply OCC");
  const staleFixtures = new Set((contract.staleValidation?.fixtures ?? []).map((fixture) => fixture?.id));
  pushIf(errors, staleFixtures.has("interpretation-live-token-mismatch-refuses") && staleFixtures.has("human-derived-stale-parent-publishes-state"), "stale validation split fixtures are incomplete");

  const adapter = contract.crossRuntimeAdapter;
  pushIf(errors, adapter?.id === "chronicle.scene-event" && adapter?.version === "1" && adapter?.assertionKind === "scene-event@1" && adapter?.goldenFixtureRequired === true && adapter?.initialScopeDerivationRuntime === "typescript" && adapter?.humanDerivedScopeRuntime === "rust", "Chronicle Adapter must be versioned and cross-runtime golden-bound");
  pushIf(errors, adapter?.canonicalOutput === "byte-identical-canonical-scope-json-and-scope-digest" && adapter?.noIndependentRuntimeInterpretation === true, "TypeScript and Rust Scope derivation must share canonical output and avoid independent interpretation");
  pushIf(errors, JSON.stringify(adapter?.requiredCaseIds) === JSON.stringify(REQUIRED_CASE_IDS), "cross-runtime Adapter golden case list is incomplete");

  const fixturePath = adapter?.fixtureFile;
  const fixture = fixturePath ? readJson(repoRoot, fixturePath, errors, "Narrative IR golden fixture corpus") : null;
  if (fixture) {
    pushIf(errors, fixture.schemaVersion === 1 && fixture.fixtureKind === "narrative-ir-cross-runtime-golden", "Narrative IR golden fixture corpus identity/version is invalid");
    pushIf(errors, fixture.adapter?.id === adapter.id && fixture.adapter?.version === adapter.version, "golden fixture corpus Adapter binding is invalid");
    const cases = new Map((fixture.cases ?? []).map((entry) => [entry?.id, entry]));
    for (const id of REQUIRED_CASE_IDS) {
      const entry = cases.get(id);
      if (!entry) {
        errors.push(`Narrative IR golden fixture is missing case: ${id}`);
        continue;
      }
      if (entry.kind === "human-derivation" && entry.expectedDerivationKind === "scope-override" && !hasPaths(entry.allowedPathClasses, ["projection-only","scope-affecting"]) && id.startsWith("mixed-")) {
        errors.push(`Narrative IR golden fixture ${id} must carry the cumulative allowed path classes`);
      }
      if (entry.expected) {
        const ts=entry.expected.typescript;
        const rust=entry.expected.rust;
        if (!ts || !rust || ts.canonicalScopeJson !== rust.canonicalScopeJson || ts.scopeDigest !== rust.scopeDigest) {
          errors.push(`Narrative IR golden fixture ${id} has TypeScript/Rust Scope parity drift`);
        }
      }
    }
  }

  const activation = contract.activation;
  pushIf(errors, activation?.state === "disabled" && Array.isArray(activation?.productionEntryPoints) && activation.productionEntryPoints.length === 0, "NIR-0 activation must have no production entry point");
  pushIf(errors, activation?.v2Emission === "blocked-until-c2b" && activation?.humanDerivedV2Ui === "blocked-until-c2b" && activation?.currentRevisionPromotion === "blocked-until-c2b", "Chronicle V2 production and Human-derived UI must remain disabled until C2B");
  pushIf(errors, hasPaths(activation?.prerequisites, ["C2A","D1","D2","C2B","focused-persistence-freshness-journeys","implementation-status-atomic"]), "NIR-0 activation prerequisites are incomplete");

  pushIf(errors, scopeContract?.adoptionTrack?.owner === "adr-009-scope-contract" && scopeContract?.adoptionTrack?.independentFrom === "narrative-ir-contract" && scopeContract?.adoptionTrack?.lifecycleAuthority === "adr-009-scope-contract", "Scope Disclosure adoption must remain an independent ADR 009-owned track");
  pushIf(errors, scopeContract?.implementationStatus?.capabilities && ["structuralValidation","relationComparison","disclosureAdmission"].every((key) => scopeContract.implementationStatus.capabilities[key]?.state === "declared"), "ADR 009 capability status must distinguish structural validation, relation comparison, and disclosure admission");
  pushIf(errors, scopeContract?.adoptionTrack?.states?.join(",") === "declared,shadow,wired", "ADR 009 Scope Disclosure adoption states must be declared, shadow, wired");

  const consumer = (consumerContract?.consumerKinds ?? []).find((entry) => entry?.kind === "proposal-revision");
  const irConsumer = (consumerContract?.consumerKinds ?? []).find((entry) => entry?.kind === "narrative-ir-revision");
  pushIf(errors, consumer?.status === "declared" && consumer?.durableIdentitySource === "narrative_proposal_revisions.id", "proposal-revision Consumer must remain the Narrative IR durable identity");
  pushIf(errors, irConsumer?.status === "not-yet-modelled", "narrative-ir-revision Consumer must remain not-yet-modelled");
  const binding = consumerContract?.revisionIdentityBinding;
  pushIf(errors, binding?.consumerKind === "proposal-revision" && binding?.revisionTable === "narrative_proposal_revisions" && binding?.revisionIdColumn === "id" && binding?.projectScoped === true && binding?.independentConsumerStatus === "not-yet-modelled", "Consumer contract revision identity binding is incomplete");

  pushIf(errors, contract.fixtures?.corpusFile === adapter?.fixtureFile && JSON.stringify(contract.fixtures?.requiredCaseIds) === JSON.stringify(REQUIRED_CASE_IDS), "Narrative IR fixture manifest is incomplete");
  const families = new Set(contract.fixtures?.requiredFamilies ?? []);
  for (const family of ["scope-derivation","human-derivation","cross-runtime-parity","stale-validation","activation"]) {
    if (!families.has(family)) errors.push(`Narrative IR fixture manifest is missing family: ${family}`);
  }

  return errors;
}

export function validateNarrativeIrContractFromRepo(repoRoot) {
  const errors = [];
  const contract = readJson(repoRoot, "policies/narrative/narrative-ir-contract.json", errors, "narrative IR contract");
  const scopeContract = readJson(repoRoot, "policies/narrative/narrative-scope-relation-contract.json", errors, "narrative Scope contract");
  const consumerContract = readJson(repoRoot, "policies/narrative/narrative-consumer-contract.json", errors, "narrative Consumer contract");
  if (contract && scopeContract && consumerContract) {
    validateNarrativeIrContract(repoRoot, contract, scopeContract, consumerContract, errors);
  }
  return {errors, requiredCaseCount: REQUIRED_CASE_IDS.length};
}

function main() {
  const result = validateNarrativeIrContractFromRepo(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../.."));
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    process.exitCode=1;
    return;
  }
  console.log(`Narrative IR contract PASS: ${result.requiredCaseCount} golden cases`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
