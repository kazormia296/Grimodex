#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const REQUIRED_CASE_FAMILIES = Object.freeze([
  "scope-derivation",
  "human-derivation",
  "cross-runtime-parity",
]);

const REQUIRED_CASE_KINDS = new Map([
  ["non-secret-event", "scope-derivation"],
  ["secret-event-with-resolved-reveal", "scope-derivation"],
  ["secret-event-with-unresolved-reveal", "scope-derivation"],
  ["title-only-edit", "human-derivation"],
  ["secret-only-edit", "human-derivation"],
  ["reveal-document-only-edit", "human-derivation"],
  ["mixed-title-secret-uses-scope-override", "human-derivation"],
  ["mixed-note-reveal-document-uses-scope-override", "human-derivation"],
  ["unsupported-path-refused", "human-derivation"],
  ["canonical-scope-digest-parity", "cross-runtime-parity"],
]);

const REQUIRED_ASSERTION_MODALITIES = Object.freeze([
  "modality-explicit-text",
  "modality-narrator-claim",
  "modality-hearsay",
  "modality-character-belief",
  "modality-inference",
  "modality-hypothesis",
  "modality-author-declaration",
  "modality-imported-assertion",
]);

const REQUIRED_ASSERTION_POLARITIES = Object.freeze([
  "affirmative",
  "negative",
  "uncertain",
]);

const REQUIRED_V2_DOWNGRADE_TRANSITIONS = Object.freeze([
  "v2-to-v1",
  "v2-to-no-envelope",
  "v2-to-legacy-unbound",
  "v2-to-legacy-inherit-reconciliation-envelope",
]);

const REQUIRED_TYPED_WRITER_VALIDATION = Object.freeze([
  "parent-current-revision-cas",
  "v2-lineage-monotonicity",
  "adapter-version",
  "digest-recomputation",
  "derivation-invariants",
  "material-basis",
  "change-intent",
  "proposal-binding",
]);

const REQUIRED_ACTIVATION_SCAN_ROOTS = Object.freeze([
  "src",
  "electron",
  "src-tauri",
]);

const REQUIRED_ACTIVATION_MARKERS = Object.freeze([
  "NARRATIVE_IR_V2_PRODUCTION_ENABLED",
  "createHumanDerivedNarrativeRevisionV2",
  "CHRONICLE_SCENE_EVENT_V2_PRODUCTION",
]);

const PRODUCTION_SOURCE_FILE_PATTERN = /\.(?:cjs|mjs|js|jsx|ts|tsx|rs)$/u;
const TEST_SOURCE_FILE_PATTERN = /(?:\.(?:test|spec)\.[^.]+|_test\.rs)$/u;
const IGNORED_PRODUCTION_DIRECTORIES = new Set([
  ".git",
  ".next",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "target",
  "test",
  "tests",
]);

const HUMAN_PATH_CLASSES = Object.freeze({
  projectionOnly: ["/title", "/note"],
  scopeAffecting: [
    "/disclosure/secret",
    "/disclosure/revealDocumentRef",
  ],
  assertionAffecting: [],
});

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

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

export function scanNarrativeIrProductionMarkers(
  repoRoot,
  scanRoots,
  markers,
) {
  if (!Array.isArray(scanRoots) || !Array.isArray(markers)) return [];

  const absoluteRepoRoot = path.resolve(repoRoot);
  const findings = [];

  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_PRODUCTION_DIRECTORIES.has(entry.name)) {
          walk(absolutePath);
        }
        continue;
      }
      if (
        !entry.isFile() ||
        !PRODUCTION_SOURCE_FILE_PATTERN.test(entry.name) ||
        TEST_SOURCE_FILE_PATTERN.test(entry.name)
      ) {
        continue;
      }

      const source = readFileSync(absolutePath, "utf8");
      const relativePath = path
        .relative(absoluteRepoRoot, absolutePath)
        .split(path.sep)
        .join("/");
      for (const marker of markers) {
        if (typeof marker === "string" && source.includes(marker)) {
          findings.push({ marker, path: relativePath });
        }
      }
    }
  }

  for (const scanRoot of scanRoots) {
    if (typeof scanRoot !== "string" || scanRoot.length === 0) continue;
    const absoluteScanRoot = path.resolve(absoluteRepoRoot, scanRoot);
    if (
      absoluteScanRoot !== absoluteRepoRoot &&
      !absoluteScanRoot.startsWith(`${absoluteRepoRoot}${path.sep}`)
    ) {
      continue;
    }
    if (existsSync(absoluteScanRoot)) walk(absoluteScanRoot);
  }

  return findings;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonPointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectChangedPaths(before, after, prefix = "") {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) =>
      collectChangedPaths(
        before[key],
        after[key],
        `${prefix}/${jsonPointerSegment(key)}`,
      ),
    );
  }
  return [prefix || "/"];
}

function classifyChangedPaths(changedPaths) {
  const pathClasses = [];
  const addClass = (value) => {
    if (!pathClasses.includes(value)) pathClasses.push(value);
  };
  for (const changedPath of changedPaths) {
    if (HUMAN_PATH_CLASSES.projectionOnly.includes(changedPath)) {
      addClass("projection-only");
    } else if (HUMAN_PATH_CLASSES.scopeAffecting.includes(changedPath)) {
      addClass("scope-affecting");
    } else if (HUMAN_PATH_CLASSES.assertionAffecting.includes(changedPath)) {
      addClass("assertion-affecting");
    } else {
      return {
        disposition: "reject",
        reason: "unsupported-path",
        pathClasses,
      };
    }
  }
  return {
    disposition: "accept",
    derivationKind: pathClasses.includes("assertion-affecting")
      ? "assertion-override"
      : pathClasses.includes("scope-affecting")
        ? "scope-override"
        : "projection-only",
    pathClasses,
  };
}

function validateBoundary(boundary, label, errors) {
  pushIf(
    errors,
    isObject(boundary) &&
      typeof boundary.ref === "string" &&
      boundary.ref.length > 0 &&
      typeof boundary.inclusive === "boolean" &&
      sameStringSet(Object.keys(boundary), ["ref", "inclusive"]),
    `${label} must be a {ref,inclusive} temporal boundary`,
  );
}

function validateScopeConstraint(axis, constraint, scopeContract, label, errors) {
  if (!isObject(constraint)) {
    errors.push(`${label} must be an object`);
    return;
  }
  pushIf(
    errors,
    axis.allowedKinds.includes(constraint.kind),
    `${label} kind is not allowed by ADR 009`,
  );
  if (constraint.kind === "any") {
    pushIf(
      errors,
      sameStringSet(Object.keys(constraint), ["kind"]),
      `${label} any constraint has unknown fields`,
    );
  } else if (constraint.kind === "exact") {
    pushIf(
      errors,
      axis.axisKind === "reference" &&
        typeof constraint.ref === "string" &&
        constraint.ref.length > 0 &&
        sameStringSet(Object.keys(constraint), ["kind", "ref"]),
      `${label} exact constraint is structurally invalid`,
    );
  } else if (constraint.kind === "interval") {
    const keys = Object.keys(constraint);
    pushIf(
      errors,
      axis.axisKind === "temporal" &&
        (constraint.from !== undefined || constraint.until !== undefined) &&
        keys.every((key) => ["kind", "from", "until"].includes(key)),
      `${label} interval constraint is structurally invalid`,
    );
    if (constraint.from !== undefined) {
      validateBoundary(constraint.from, `${label}.from`, errors);
    }
    if (constraint.until !== undefined) {
      validateBoundary(constraint.until, `${label}.until`, errors);
    }
  } else if (constraint.kind === "unresolved") {
    const allowedKeys = ["kind", "reason", "constraintId"];
    pushIf(
      errors,
      scopeContract.unresolvedReasons.includes(constraint.reason) &&
        Object.keys(constraint).every((key) => allowedKeys.includes(key)) &&
        (constraint.constraintId === undefined ||
          (typeof constraint.constraintId === "string" &&
            constraint.constraintId.length > 0)),
      `${label} unresolved constraint is structurally invalid`,
    );
  }
}

function validateCanonicalScope(scope, scopeContract, label, errors) {
  if (!isObject(scope)) {
    errors.push(`${label} must decode to a Scope object`);
    return;
  }
  const axisIds = scopeContract.axes.map((axis) => axis.id);
  pushIf(
    errors,
    sameStringSet(Object.keys(scope), [
      "schemaVersion",
      "registryVersion",
      ...axisIds,
    ]),
    `${label} must contain exactly the ADR 009 Scope axes`,
  );
  pushIf(
    errors,
    scope.schemaVersion === scopeContract.scopeSchemaVersion &&
      scope.registryVersion === scopeContract.registryVersion,
    `${label} Scope schema/registry version differs from ADR 009`,
  );
  for (const axis of scopeContract.axes) {
    validateScopeConstraint(
      axis,
      scope[axis.id],
      scopeContract,
      `${label}.${axis.id}`,
      errors,
    );
  }
}

function deriveScopeFromInput(entry, scopeContract, errors) {
  const input = entry.input;
  if (!isObject(input)) {
    errors.push(`Narrative IR golden fixture ${entry.id} input is required`);
    return null;
  }
  const expectedOperation = entry.kind === "human-derivation"
    ? "human-derived-scope-derivation"
    : entry.kind === "cross-runtime-parity"
      ? "cross-runtime-scope-parity"
      : "initial-scope-derivation";
  pushIf(
    errors,
    input.operation === expectedOperation,
    `Narrative IR golden fixture ${entry.id} input operation is invalid`,
  );
  pushIf(
    errors,
    typeof input.sceneRef === "string" && input.sceneRef.length > 0,
    `Narrative IR golden fixture ${entry.id} input sceneRef is required`,
  );

  const proposalPayload = entry.kind === "human-derivation"
    ? input.editedPayload
    : input.proposalPayload;
  if (!isObject(proposalPayload) || !isObject(proposalPayload.disclosure)) {
    errors.push(
      `Narrative IR golden fixture ${entry.id} input Proposal disclosure is required`,
    );
    return null;
  }
  if (
    entry.kind === "human-derivation" &&
    (!isObject(input.parentPayload) || !isObject(input.editedPayload))
  ) {
    errors.push(
      `Narrative IR golden fixture ${entry.id} parent/edited payloads are required`,
    );
    return null;
  }

  const scope = {
    schemaVersion: scopeContract.scopeSchemaVersion,
    registryVersion: scopeContract.registryVersion,
  };
  for (const axis of scopeContract.axes) scope[axis.id] = {kind: "any"};
  scope.scene = {kind: "exact", ref: input.sceneRef};

  const revealBasis = input.revealBasis;
  if (!isObject(revealBasis)) {
    errors.push(
      `Narrative IR golden fixture ${entry.id} reveal basis is required`,
    );
    return null;
  }
  if (proposalPayload.disclosure.secret !== true) {
    pushIf(
      errors,
      revealBasis.status === "not-secret",
      `Narrative IR golden fixture ${entry.id} non-secret input must use a not-secret reveal basis`,
    );
    return scope;
  }

  pushIf(
    errors,
    proposalPayload.disclosure.revealDocumentRef === revealBasis.documentRef,
    `Narrative IR golden fixture ${entry.id} reveal basis documentRef must match the Proposal`,
  );
  if (revealBasis.status === "resolved") {
    scope.audience = {kind: "exact", ref: revealBasis.audienceRef};
    scope.readingOrder = {kind: "interval", ...revealBasis.readingOrder};
    scope.storyTime = {kind: "interval", ...revealBasis.storyTime};
  } else if (revealBasis.status === "unresolved") {
    scope.audience = {kind: "unresolved", ...revealBasis.audience};
    scope.readingOrder = {
      kind: "unresolved",
      ...revealBasis.readingOrder,
    };
  } else {
    errors.push(
      `Narrative IR golden fixture ${entry.id} secret input needs a resolved or unresolved reveal basis`,
    );
  }
  return scope;
}

export function validateNarrativeIrGoldenFixture(
  fixture,
  scopeContract,
  errors = [],
) {
  if (!isObject(fixture) || !isObject(scopeContract)) {
    errors.push("Narrative IR golden fixture and ADR 009 Scope contract are required");
    return errors;
  }
  pushIf(
    errors,
    fixture.schemaVersion === 1 &&
      fixture.fixtureKind === "narrative-ir-cross-runtime-golden",
    "Narrative IR golden fixture corpus identity/version is invalid",
  );
  pushIf(
    errors,
    fixture.canonicalization === "sorted-object-keys-json",
    "Narrative IR golden fixture canonicalization must sort object keys",
  );

  const entries = Array.isArray(fixture.cases) ? fixture.cases : [];
  const ids = entries.map((entry) => entry?.id);
  pushIf(
    errors,
    new Set(ids).size === ids.length,
    "Narrative IR golden fixture case IDs must be unique",
  );
  const families = new Set(entries.map((entry) => entry?.kind));
  for (const family of REQUIRED_CASE_FAMILIES) {
    if (!families.has(family)) {
      errors.push(`Narrative IR golden fixture is missing case family: ${family}`);
    }
  }

  const cases = new Map(entries.map((entry) => [entry?.id, entry]));
  for (const id of REQUIRED_CASE_IDS) {
    const entry = cases.get(id);
    if (!entry) {
      errors.push(`Narrative IR golden fixture is missing case: ${id}`);
      continue;
    }
    pushIf(
      errors,
      entry.kind === REQUIRED_CASE_KINDS.get(id),
      `Narrative IR golden fixture ${id} has the wrong case family`,
    );
    pushIf(
      errors,
      entry.input?.adapter?.id === fixture.adapter?.id &&
        entry.input?.adapter?.version === fixture.adapter?.version,
      `Narrative IR golden fixture ${id} needs the versioned Adapter input`,
    );
    pushIf(
      errors,
      isObject(entry.expected) &&
        !Object.hasOwn(entry.expected, "typescript") &&
        !Object.hasOwn(entry.expected, "rust"),
      `Narrative IR golden fixture ${id} must have one authoritative expected result`,
    );

    const derivedScope = deriveScopeFromInput(entry, scopeContract, errors);
    if (entry.kind === "human-derivation") {
      const changedPaths =
        isObject(entry.input?.parentPayload) && isObject(entry.input?.editedPayload)
          ? collectChangedPaths(
              entry.input.parentPayload,
              entry.input.editedPayload,
            )
          : [];
      const classification = classifyChangedPaths(changedPaths);
      pushIf(
        errors,
        sameStringSet(entry.expected?.changedPaths, changedPaths),
        `Narrative IR golden fixture ${id} changedPaths differ from the parent/edited payload diff`,
      );
      pushIf(
        errors,
        entry.expected?.disposition === classification.disposition,
        `Narrative IR golden fixture ${id} disposition differs from path classification`,
      );
      if (classification.disposition === "reject") {
        pushIf(
          errors,
          entry.expected?.reason === classification.reason,
          `Narrative IR golden fixture ${id} rejection reason is invalid`,
        );
        continue;
      }
      pushIf(
        errors,
        !Object.hasOwn(entry.expected ?? {}, "allowedPathClasses"),
        `Narrative IR golden fixture ${id} allowedPathClasses is ambiguous; use changedPathClasses for observed classes`,
      );
      pushIf(
        errors,
        entry.expected?.derivationKind === classification.derivationKind &&
          sameStringSet(
            entry.expected?.changedPathClasses,
            classification.pathClasses,
          ),
        `Narrative IR golden fixture ${id} strongest derivation classification or changedPathClasses is invalid`,
      );
    } else {
      pushIf(
        errors,
        !Object.hasOwn(entry.expected ?? {}, "derivationKind"),
        `Narrative IR golden fixture ${id} derivationKind is Human-derived only`,
      );
    }

    if (
      typeof entry.expected?.canonicalScopeJson !== "string" ||
      typeof entry.expected?.scopeDigest !== "string"
    ) {
      errors.push(
        `Narrative IR golden fixture ${id} canonical Scope JSON and scopeDigest are required`,
      );
      continue;
    }
    let parsedScope;
    try {
      parsedScope = JSON.parse(entry.expected.canonicalScopeJson);
    } catch (error) {
      errors.push(
        `Narrative IR golden fixture ${id} canonical Scope JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const canonicalScopeJson = canonicalJson(parsedScope);
    pushIf(
      errors,
      entry.expected.canonicalScopeJson === canonicalScopeJson,
      `Narrative IR golden fixture ${id} canonical Scope JSON key order is invalid`,
    );
    const computedDigest = `sha256:${createHash("sha256")
      .update(entry.expected.canonicalScopeJson, "utf8")
      .digest("hex")}`;
    pushIf(
      errors,
      entry.expected.scopeDigest === computedDigest,
      `Narrative IR golden fixture ${id} scopeDigest does not match the canonical JSON SHA-256`,
    );
    validateCanonicalScope(
      parsedScope,
      scopeContract,
      `Narrative IR golden fixture ${id}`,
      errors,
    );
    if (derivedScope) {
      pushIf(
        errors,
        canonicalJson(derivedScope) === entry.expected.canonicalScopeJson,
        `Narrative IR golden fixture ${id} expected Scope does not match its Adapter input`,
      );
    }
  }

  return errors;
}

export function resolveRepoRootFromModuleUrl(
  moduleUrl = import.meta.url,
  platform = process.platform,
) {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path;
  return pathApi.resolve(
    pathApi.dirname(fileURLToPath(moduleUrl, {windows})),
    "../..",
  );
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
  pushIf(errors, identity?.consumerKind === "proposal-revision", "proposal-revision Consumer must remain the Narrative IR revision identity");
  pushIf(errors, identity?.projectScoped === true && identity?.durability === "while-project-exists", "Narrative IR revision durability must be project-scoped while the Project exists");
  pushIf(errors, JSON.stringify(identity?.portableReference) === JSON.stringify(["projectId","revisionId","envelopeDigest","contractVersion"]), "portable Narrative IR references must include projectId, revisionId, envelopeDigest, and contractVersion");
  pushIf(errors, identity?.portableExport?.requiredClosure === "referenced-closure" && identity?.portableExport?.originalProjectAvailability === "must-not-be-assumed", "portable Narrative IR export must include the referenced closure and must not assume the original Project remains available");
  pushIf(errors, identity?.independentRevisionConsumer === "narrative-ir-revision" && identity?.independentRevisionConsumerStatus === "not-yet-modelled" && identity?.heuristicIdentity === "forbid", "narrative-ir-revision must remain not-yet-modelled and heuristic identity must be forbidden");

  const vocab = contract.vocabularies;
  pushIf(errors, JSON.stringify(vocab?.assertionKinds) === JSON.stringify(["scene-event@1"]), "NIR-0 must wire only scene-event@1");
  pushIf(errors, JSON.stringify(vocab?.assertionModalities) === JSON.stringify(REQUIRED_ASSERTION_MODALITIES), "AssertionModality must match the exact ADR 005 vocabulary");
  pushIf(errors, JSON.stringify(vocab?.assertionPolarities) === JSON.stringify(REQUIRED_ASSERTION_POLARITIES), "AssertionPolarity must contain exactly affirmative, negative, and uncertain");
  pushIf(errors, JSON.stringify(vocab?.changeKinds) === JSON.stringify(["add","revise","retract","merge","split"]), "changeKind vocabulary must retain add/revise/retract/merge/split");
  pushIf(errors, JSON.stringify(vocab?.producerKinds) === JSON.stringify(["ai-inference","reconciler-proposal","author-declaration","import-metadata","legacy-migration"]), "Producer Kind vocabulary must reuse the ratified values");
  pushIf(errors, JSON.stringify(vocab?.supportClasses) === JSON.stringify(["author-declared","direct-source","reported-source","single-source-inference","multi-source-inference","imported-assertion","unresolved"]), "Support Class vocabulary must reuse the ratified values");
  const importedVocabularyIds = new Set([
    ...(vocab?.producerKinds ?? []),
    ...(vocab?.supportClasses ?? []),
  ]);
  pushIf(errors, REQUIRED_ASSERTION_MODALITIES.every((id) => !importedVocabularyIds.has(id)), "AssertionModality machine IDs must not collide with imported Producer Kind or Support Class IDs");
  pushIf(errors, contract.v1ProducerMapping?.producerKind === "reconciler-proposal" && contract.v1ProducerMapping?.producerIdSource === "reconcilerId" && contract.v1ProducerMapping?.producerVersionSource === "reconcilerVersion", "V1 reconciler mapping must bind producer.kind to reconciler-proposal, producer.id to reconcilerId, and producer.version to reconcilerVersion");

  pushIf(errors, contract.envelope?.schemaVersion === 2, "Narrative Revision Envelope must be V2");
  pushIf(errors, hasPaths(contract.envelope?.requiredFields, ["assertion","assertionDigests","changeIntent","effectiveMaterialBasis","revisionBasis","projectionBinding"]), "Narrative Revision Envelope V2 required fields are incomplete");
  pushIf(errors, contract.envelope?.assertionDigestDomains?.disclosureFieldsExcludedFromAssertionCore?.includes("secret") && contract.envelope?.assertionDigestDomains?.disclosureFieldsExcludedFromAssertionCore?.includes("revealDocumentRef"), "Disclosure fields must remain outside Assertion Core");
  pushIf(errors, contract.envelope?.changeIntent?.humanDerivedMustPreserve === "exact", "Human-derived Revision must preserve root-level Change Intent exactly");
  pushIf(errors, contract.envelope?.projectionBinding?.recomputePayloadDigestInNative === true && contract.envelope?.projectionBinding?.proposalKindAndSchemaDistinct === true, "Native must own payload digest and Proposal kind/schema binding");

  const monotonicity = contract.monotonicity;
  pushIf(errors, monotonicity?.currentRevisionRule === "once-v2-always-v2" && JSON.stringify(monotonicity?.forbiddenTransitions) === JSON.stringify(REQUIRED_V2_DOWNGRADE_TRANSITIONS), "Narrative IR V2 monotonicity must forbid every downgrade from V2 to V1, no envelope, legacy-unbound, or legacy inheritReconciliationEnvelope");
  pushIf(errors, monotonicity?.semanticAuthority === "typed-writer" && JSON.stringify(monotonicity?.typedWriterValidation) === JSON.stringify(REQUIRED_TYPED_WRITER_VALIDATION), "Narrative IR V2 monotonicity semantic authority must remain the complete typed writer");
  pushIf(errors, monotonicity?.structuralDefense?.kind === "sqlite-before-insert-trigger" && monotonicity?.structuralDefense?.role === "structural-defense-only" && monotonicity?.structuralDefense?.state === "deferred-until-after-c2-zb" && Array.isArray(monotonicity?.structuralDefense?.productionEntryPoints) && monotonicity.structuralDefense.productionEntryPoints.length === 0 && monotonicity?.structuralDefense?.errorCode === "NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN" && monotonicity?.contractFreezeOnly === true, "V2 downgrade trigger must remain contract-only structural defense deferred until after C2-ZB with NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN");

  const chroniclePilot = contract.chroniclePilot;
  pushIf(errors, chroniclePilot?.assertionKind === "scene-event@1" && JSON.stringify(chroniclePilot?.productWiredChangeKinds) === JSON.stringify(["add"]) && JSON.stringify(chroniclePilot?.declaredOrReservedChangeKinds) === JSON.stringify(["revise","retract","merge","split"]), "Chronicle pilot product-wired changeKinds must contain only add; revise, retract, merge, and split remain declared or reserved");
  pushIf(errors, chroniclePilot?.existingProjectionRevisionStatus === "requires-separately-ratified-proposal-kind-and-apply-path", "Chronicle existing-Projection revision requires a separately ratified Proposal kind and Apply path");

  const human = contract.humanDerived;
  pushIf(errors, hasPaths(human?.contextExposureAllowed, ["deterministic-stage","author-supplied"]) && human?.contextExposureForbidden?.includes("model-visible"), "Human-derived Context Set must exclude model-visible exposure");
  pushIf(errors, hasPaths(human?.nativeOwnedFields, ["proposalPayloadDiff","pathClassification","strongestDerivationClassification","effectiveMaterialBasis","dependencyDeclaration","currentEpochFreshness"]), "Native must own Human-derived diff, classification, basis, Dependencies, and Freshness");
  pushIf(errors, !human?.clientSubmittedFields?.some((field) => ["derivationKind","changedPaths","scope","childAssertion","childDigests"].includes(field)), "Clients must not submit derivation metadata, child Scope, Assertion, or digests");
  const classes = human?.classification;
  pushIf(errors, JSON.stringify(classes?.precedence) === JSON.stringify(["assertion-override","scope-override","projection-only"]), "Human-derived classification precedence must be assertion-override > scope-override > projection-only");
  pushIf(errors, JSON.stringify(classes?.pathClasses?.projectionOnly) === JSON.stringify(["/title","/note"]) && JSON.stringify(classes?.pathClasses?.scopeAffecting) === JSON.stringify(["/disclosure/secret","/disclosure/revealDocumentRef"]) && Array.isArray(classes?.pathClasses?.assertionAffecting) && classes.pathClasses.assertionAffecting.length === 0, "Chronicle Human-derived path classes are invalid");
  pushIf(errors, classes?.cumulativeAllowedPathClasses?.scopeOverride?.includes("projection-only") && classes?.cumulativeAllowedPathClasses?.scopeOverride?.includes("scope-affecting"), "scope-override must allow the cumulative projection-only and scope-affecting path union");
  pushIf(errors, classes?.unknownPathPolicy === "reject" && classes?.clientMetadataAuthority === "forbid" && classes?.assertionOverrideStatus === "reserved-rejected", "unknown paths, client metadata, and assertion override must fail closed");

  const classificationFixtures = classes?.fixtures ?? [];
  const classFixtures = new Map(classificationFixtures.map((fixture) => [fixture?.id, fixture]));
  for (const fixture of classificationFixtures) {
    if (Object.hasOwn(fixture, "allowedPathClasses")) {
      errors.push(`${String(fixture.id)} allowedPathClasses is ambiguous; changedPathClasses must record observed classes`);
    }
    const observed = classifyChangedPaths(fixture?.changedPaths ?? []);
    pushIf(errors, fixture?.expectedDisposition === observed.disposition, `${String(fixture?.id)} disposition differs from its changed paths`);
    if (observed.disposition === "accept") {
      pushIf(
        errors,
        fixture?.expectedDerivationKind === observed.derivationKind &&
          sameStringSet(fixture?.changedPathClasses, observed.pathClasses),
        `${String(fixture?.id)} changedPathClasses must match the observed changed paths`,
      );
    }
  }
  pushIf(errors, classFixtures.get("mixed-title-secret-uses-scope-override")?.expectedDerivationKind === "scope-override" && hasPaths(classFixtures.get("mixed-title-secret-uses-scope-override")?.changedPathClasses, ["projection-only","scope-affecting"]), "mixed-title-secret-uses-scope-override must be scope-override with both observed path classes");
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
    pushIf(errors, fixture.adapter?.id === adapter.id && fixture.adapter?.version === adapter.version, "golden fixture corpus Adapter binding is invalid");
    validateNarrativeIrGoldenFixture(fixture, scopeContract, errors);
  }

  const activation = contract.activation;
  pushIf(errors, activation?.state === "disabled" && Array.isArray(activation?.productionEntryPoints) && activation.productionEntryPoints.length === 0, "NIR-0 activation must have no production entry point");
  pushIf(errors, JSON.stringify(activation?.scanRoots) === JSON.stringify(REQUIRED_ACTIVATION_SCAN_ROOTS), "NIR-0 activation scanRoots must match the exact production-root vocabulary");
  pushIf(errors, JSON.stringify(activation?.productionMarkers) === JSON.stringify(REQUIRED_ACTIVATION_MARKERS), "NIR-0 activation productionMarkers must match the exact reserved vocabulary");
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
  pushIf(errors, JSON.stringify(contract.fixtures?.requiredFamilies) === JSON.stringify(REQUIRED_CASE_FAMILIES), "Narrative IR fixture manifest families must match the executable golden corpus");

  return errors;
}

export function validateNarrativeIrContractFromRepo(repoRoot) {
  const errors = [];
  const contract = readJson(repoRoot, "policies/narrative/narrative-ir-contract.json", errors, "narrative IR contract");
  const scopeContract = readJson(repoRoot, "policies/narrative/narrative-scope-relation-contract.json", errors, "narrative Scope contract");
  const consumerContract = readJson(repoRoot, "policies/narrative/narrative-consumer-contract.json", errors, "narrative Consumer contract");
  if (contract && scopeContract && consumerContract) {
    validateNarrativeIrContract(repoRoot, contract, scopeContract, consumerContract, errors);
    const activation = contract.activation;
    if (
      activation?.state === "disabled" &&
      Array.isArray(activation?.productionEntryPoints) &&
      activation.productionEntryPoints.length === 0
    ) {
      try {
        for (const finding of scanNarrativeIrProductionMarkers(
          repoRoot,
          activation?.scanRoots,
          activation?.productionMarkers,
        )) {
          errors.push(
            `NIR-0 activation marker ${finding.marker} appears in production at ${finding.path} while activation is disabled`,
          );
        }
      } catch (error) {
        errors.push(
          `NIR-0 activation production scan failed closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return {errors, requiredCaseCount: REQUIRED_CASE_IDS.length};
}

function main() {
  const result = validateNarrativeIrContractFromRepo(resolveRepoRootFromModuleUrl());
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`FAIL: ${error}`);
    process.exitCode=1;
    return;
  }
  console.log(`Narrative IR contract PASS: ${result.requiredCaseCount} golden cases`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
