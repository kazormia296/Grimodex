// Derivation rules for the final-request fixture version 2 (DP-H S1, the
// replacement of the superseded version 1; dp-h-decisions.md DR-DPH-90..95).
//
// This module runs no Native code, reads no file and no receipt. It writes
// down, as pure functions, what the fixture author read in the product's
// source AFTER X1-3 (base origin/master 352474d4) to decide the expectations
// of every request BEFORE any Native run. The fixture's own materials (the
// case and variant `setup`) are the only input; `fixture.v2.test.mjs` checks
// that every `expected` of final-request.v2.json is what these functions give.
// They cannot make the rules right: the independent expectation reviewer (S2)
// checks each rule against the cited source.
//
// Rules (paths under src-tauri/crates/ unless noted):
//   Entry parts  grimodex-db/src/narrative_extraction/nir1_packing.rs
//                `group_parts` / `accepted_ir_group` (3369-3419): statement,
//                negation, attribution, evidence, qualification, each the
//                canonical JSON of a value; `adapt_typed_revision_candidates`
//                (3499-3531) gives an Entity's statement
//                `{family, kind:"entity", entity, materialEvidence}` and its
//                evidence `{family, kind:"entity-evidence", entityId, materialEvidence}`;
//                `closed_marker` (3328-3334); `qualification_text` (3336-3354).
//   Entity       grimodex-db/src/narrative_extraction/nir1_entity_relation.rs
//                `build_live_typed_bundle` (4319-4337, 4412-4428): reading
//                `exact scene:<anchor>`, story `any(nir1-entity-relation-review)`,
//                auto `notApplicable(typed-review-input)`, phase `draft`, reveal
//                the first reserved audience (`reader`), pov null, and, after
//                X1-3, `authorityRevision` = the anchor Scene's Scene Scope
//                projection token (`LiveScope::projection_token`; the digest of
//                `SceneScopeProjectionV1`, scene_scope_projection.rs 205-257),
//                not the project Scope authority revision. Evidence is the whole
//                Codex summary (the name when blank), start 0, end = UTF-16 length.
//                Serde shapes: grimodex-core/src/narrative_nir1.rs 89-232.
//   Material     `assemble_typed_material` (687-704): evidenceRef, documentRef
//                `codex:<id>`, quote, quoteDigest `sha256:<hex of UTF-8>`,
//                sourceKey `codex:<id>`, revisionToken = the Entity source token
//                `codex:<id>@<updated_at>`.
//   Decision     `append_human_decision` (narrative_extraction/repository.rs
//                5885-5893) actor `electron:human-review`, kind human;
//                `derive_decision_authority` (field_authority.rs 352-353)
//                `project/<p>/proposal/<q>/revision/<r>`.
//   Order        `pack_candidate_context` (grimodex-core/src/narrative_nir1.rs
//                1118-1135) returns the selected items in the candidates'
//                order: Raw, then the groups of the passed Revisions in order.
//   Rejection    the caller-list D-final rejects the whole request
//                (`RevisionUnavailablePolicy::Reject`, nir1_packing.rs 1759-1760,
//                3752-3755) with `NIR1_NATIVE_A2_UNAVAILABLE:<reason>`; the
//                reason per write is REASON_BY_WRITE below.
// Runtime values (ids, tokens) are `{{<kind>:<logicalId>}}` placeholders
// (contract.mjs); nothing here is derived from a payload.
import { createHash } from "node:crypto";
import { contextBudgetTokens, canonicalJson } from "./payload.mjs";
import { variantRequests } from "./contract.mjs";

export const FAMILY = "nir1.entity-relation@1";
export const SCOPE_PURPOSE = "nir1-entity-relation-review";
export const SCOPE_AUTO_REASON = "typed-review-input";
export const REVEAL_AUDIENCE = "reader";
export const DECISION_ACTOR_ID = "electron:human-review";
export const DECISION_ACTOR_KIND = "human";
export const DECISION_VALUE = "approved";
export const REJECT_CODE = "NIR1_NATIVE_A2_UNAVAILABLE";
export const PART_ORDER = Object.freeze([
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
]);

/**
 * The A2 reason each setup write leaves on a Revision it invalidates
 * (nir1_entity_relation.rs, `read_typed_revision_core_with_scope_authority`):
 *   decision-cancel             a single human `rejected` after the only
 *                               `approved` (repository.rs 5742-5743) sets the
 *                               proposal status `rejected` (5675-5681, 5995),
 *                               and `status != "approved"` is
 *                               `revision-not-human-approved` (2450-2452).
 *   codex-update                the Codex row's `updated_at` moves, the source
 *                               token check in `validate_live_sources`
 *                               (4008-4013) fails, read as
 *                               `source-revision-changed` (2642-2646).
 *   scene-scope-registry-update a registry ref advances every binding's
 *                               version, so every anchor's projection token
 *                               moves (`scopeGeneration`, scene_scope_projection.rs
 *                               90, 230; test x13_registry_ref_addition_invalidates_every_revision),
 *                               `validate_scope_binding` (4102-4113) fails,
 *                               read as `source-revision-changed`.
 */
export const REASON_BY_WRITE = Object.freeze({
  "decision-cancel": "revision-not-human-approved",
  "codex-update": "source-revision-changed",
  "scene-scope-registry-update": "source-revision-changed",
});

/** The write a reject variant's negative (or a P-10 binding) is made with. */
export const WRITE_BY_NEGATIVE = Object.freeze({
  "approval-cancelled": "decision-cancel",
  "source-stale": "codex-update",
  "scope-authority-changed": "scene-scope-registry-update",
});
export const WRITE_BY_BINDING = Object.freeze({
  decision: "decision-cancel",
  source: "codex-update",
  scope: "scene-scope-registry-update",
});

export const placeholder = (kind, logicalId) => `{{${kind}:${logicalId}}}`;

const sha256Hex = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** The case's slug: its project logical id without `-project`. */
export function caseSlug(testCase) {
  return testCase.setup.project.logicalId.replace(/-project$/, "");
}

/** The runtime value that names the anchor Scene's Scene Scope projection token. */
export function anchorProjectionLogicalId(testCase) {
  return `${caseSlug(testCase)}-anchor-projection`;
}

export function anchorScene(testCase) {
  return testCase.setup.scenes.find((scene) => scene.role === "anchor");
}

export function queryScene(testCase) {
  return testCase.setup.scenes.find((scene) => scene.role === "query");
}

/** `closed_marker` for the two parts the family does not represent. */
export function closedMarker(part) {
  return canonicalJson({
    status: "not-represented-by-this-family",
    family: FAMILY,
    atomicPart: part,
  });
}

/**
 * The five entry templates of a Revision whose only record is one Codex Entity
 * (`entity` = { logicalId, type, name, summary } as the workspace holds it when
 * the Revision is prepared).
 */
export function deriveEntryTemplates({
  revisionLogicalId,
  entity,
  anchorSceneLogicalId,
  projectLogicalId,
  anchorProjectionLogicalId: projectionLogicalId,
}) {
  const entityId = placeholder("runtimeId", entity.logicalId);
  const sourceToken = placeholder("sourceToken", entity.logicalId);
  const quote = entity.summary.trim().length > 0 ? entity.summary : entity.name;
  const evidenceId = `nir1:evidence:codex:${entityId}`;
  const sourceRef = `codex:${entityId}`;
  const entityValue = {
    entityId,
    entityType: entity.type,
    label: entity.name,
    sourceToken,
    scope: {
      reading: {
        kind: "exact",
        value: `scene:${placeholder("runtimeId", anchorSceneLogicalId)}`,
      },
      story: { kind: "any", purpose: SCOPE_PURPOSE },
      auto: { kind: "notApplicable", reason: SCOPE_AUTO_REASON },
      phase: "draft",
      reveal: REVEAL_AUDIENCE,
      pov: null,
      // X1-3: the anchor Scene's projection token, not the project token.
      authorityRevision: placeholder("revisionToken", projectionLogicalId),
    },
    evidence: [
      {
        evidenceId,
        sourceRef,
        quote,
        startUtf16: 0,
        // `encode_utf16().count()`; the fixture holds BMP characters only.
        endUtf16: quote.length,
      },
    ],
  };
  const materialEvidence = [
    {
      evidenceRef: evidenceId,
      documentRef: sourceRef,
      quote,
      quoteDigest: `sha256:${sha256Hex(quote)}`,
      sourceKey: sourceRef,
      revisionToken: sourceToken,
    },
  ];
  const proposalId = placeholder("proposalId", revisionLogicalId);
  const revisionId = placeholder("revisionId", revisionLogicalId);
  const text = {
    statement: canonicalJson({
      family: FAMILY,
      kind: "entity",
      entity: entityValue,
      materialEvidence,
    }),
    negation: closedMarker("negation"),
    attribution: closedMarker("attribution"),
    evidence: canonicalJson({
      family: FAMILY,
      kind: "entity-evidence",
      entityId,
      materialEvidence,
    }),
    qualification: canonicalJson({
      approval: "human-approved",
      decision: DECISION_VALUE,
      decisionId: placeholder("decisionId", revisionLogicalId),
      actorKind: DECISION_ACTOR_KIND,
      actorId: DECISION_ACTOR_ID,
      authorityScope: `project/${placeholder("runtimeId", projectLogicalId)}/proposal/${proposalId}/revision/${revisionId}`,
      proposalId,
      revisionId,
      recordId: entityId,
    }),
  };
  return PART_ORDER.map((part) => ({
    logicalId: `${revisionLogicalId}.${part}`,
    groupLogicalId: revisionLogicalId,
    part,
    text: text[part],
  }));
}

/** The Codex records of a variant's workspace at `stage`, after its earlier codex-update writes. */
export function codexRecordsAtStage(testCase, variant, stage) {
  const records = new Map(
    [
      ...testCase.setup.codexEntities,
      ...(variant.setup.codexEntities ?? []),
    ].map((entity) => [entity.logicalId, { ...entity }]),
  );
  for (const step of variant.setup.steps) {
    if (step.stage > stage || step.write !== "codex-update") continue;
    records.get(step.entity).summary = step.summary;
  }
  return records;
}

/** The Revisions the variant prepares as positives in `stage`, in order. */
export function preparedInStage(variant, stage) {
  return variant.setup.steps.filter(
    (step) => step.op === "prepare" && step.stage === stage,
  );
}

/** Negatives of the case's reject variants that are their own Revision (not an earlier stage's). */
export function ownNegatives(testCase) {
  const negatives = [];
  for (const variant of testCase.variants) {
    if (variant.kind !== "reject") continue;
    const prepare = variant.setup.steps.find(
      (step) =>
        step.op === "prepare-negative" &&
        step.revision === variant.ineligibleLogicalId,
    );
    if (!prepare) continue;
    const entity = (variant.setup.codexEntities ?? []).find(
      (row) => row.logicalId === prepare.entity,
    );
    const update = variant.setup.steps.find(
      (step) =>
        step.op === "invalidate-negative" &&
        step.write === "codex-update" &&
        step.entity === prepare.entity,
    );
    negatives.push({
      revision: variant.ineligibleLogicalId,
      texts: [entity?.summary, update?.summary].filter(
        (text) => typeof text === "string" && text.length > 0,
      ),
    });
  }
  return negatives;
}

/**
 * The expectation of one positive request, from the case's materials:
 * `template` is `loadFixedTemplate`'s value, `route` and `canaries` the
 * fixture's.
 */
export function derivePositiveExpectation({
  template,
  route,
  canaries,
  testCase,
  variant,
  request,
}) {
  const records = codexRecordsAtStage(testCase, variant, request.stage);
  const prepared = preparedInStage(variant, request.stage);
  const passed =
    variant.kind === "reject" && request === variantRequests(variant).at(-1)
      ? null
      : request.revisionIds;
  if (passed === null)
    throw new Error("a reject request has no positive expectation");
  const codexEntries = prepared.flatMap((step) =>
    deriveEntryTemplates({
      revisionLogicalId: step.revision,
      entity: records.get(step.entity),
      anchorSceneLogicalId: step.anchorScene,
      projectLogicalId: testCase.setup.project.logicalId,
      anchorProjectionLogicalId: anchorProjectionLogicalId(testCase),
    }),
  );
  const exactQuotes = prepared.flatMap((step) => {
    const entity = records.get(step.entity);
    return [
      { logicalId: `${step.revision}.evidence`, quote: entity.summary },
      { logicalId: `${step.revision}.statement`, quote: entity.name },
    ];
  });
  let forbidden;
  if (request.stage === 1) {
    const negatives = ownNegatives(testCase);
    forbidden = {
      logicalIds: negatives.map((row) => row.revision),
      texts: negatives.flatMap((row) => row.texts),
    };
  } else {
    // A later stage forbids the earlier stages' Revisions, their entry ids and
    // every earlier entry text the new stage's material does not also hold
    // (contract.mjs `checkLaterStages`).
    const earlier = variantRequests(variant).filter(
      (row) => row.stage < request.stage,
    );
    const earlierEntries = earlier.flatMap(
      (row) =>
        derivePositiveExpectation({
          template,
          route,
          canaries,
          testCase,
          variant,
          request: row,
        }).codexEntries,
    );
    const newMaterial = [
      queryScene(testCase).body,
      ...codexEntries.map((entry) => entry.text),
    ];
    forbidden = {
      logicalIds: [
        ...earlier.flatMap((row) => row.revisionIds),
        ...earlierEntries.map((entry) => entry.logicalId),
      ],
      texts: earlierEntries
        .filter(
          (entry) => !newMaterial.some((text) => text.includes(entry.text)),
        )
        .map((entry) => entry.text),
    };
  }
  return {
    contextBudgetTokens: contextBudgetTokens({
      template,
      userMessage: testCase.userMessage,
      contextWindowTokens: route.contextWindowTokens,
      outputTokens: route.outputTokens,
    }),
    rawText: queryScene(testCase).body,
    codexEntries,
    selectedGroupLogicalIds: [...passed],
    exactQuotes,
    forbidden,
    embeddedCanaryIds: canaries.map((canary) => canary.id),
  };
}

/** The `{ code, reason }` of a reject variant's last request. */
export function deriveRejectExpectation(testCase, variant) {
  const write =
    testCase.caseId === "P-10"
      ? variant.setup.steps.find((step) => step.op === "binding-change")?.write
      : variant.setup.steps.find(
          (step) =>
            step.op === "invalidate-negative" &&
            step.revision === variant.ineligibleLogicalId,
        )?.write;
  const reason = REASON_BY_WRITE[write];
  if (reason === undefined) {
    throw new Error(
      `${variant.variantId}: no reason is derived for the write ${write}`,
    );
  }
  return { code: REJECT_CODE, reason };
}
