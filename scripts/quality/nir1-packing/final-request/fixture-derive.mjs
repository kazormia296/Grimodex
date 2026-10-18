// Hand-derivation rules for the final-request fixture's expected codex entries
// (DP-H / DPH-2, K6/2 nir1-final-request-packing-eval).
//
// This module runs no Native code and reads no receipt. It writes down, as a
// pure function, the rules that were applied by hand to the product's source
// to decide what an accepted-IR entry looks like BEFORE any Native run:
//   - the five parts of one atomic group
//       `accepted_ir_group` (src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_packing.rs):
//       statement, negation, attribution, evidence, qualification, each
//       `canonical_json_string` of a JSON value;
//   - the Entity the typed Revision carries
//       `build_live_typed_bundle` (nir1_entity_relation.rs): Evidence is the
//       whole Codex summary (or the name when the summary is blank), the Scope
//       binding is `reading=exact scene:<anchor>`, `story=any(nir1-entity-relation-review)`,
//       `auto=notApplicable(typed-review-input)`, `phase=draft`,
//       `reveal=reader` (the only reserved audience), `pov=null`,
//       `authorityRevision=<live project Scope authority revision>`;
//   - the material Evidence row
//       `build_typed_material_basis`: `evidenceRef=nir1:evidence:codex:<id>`,
//       `documentRef=sourceKey=codex:<id>`, `quoteDigest=sha256:<hex of the quote bytes>`,
//       `revisionToken=<the Codex source token>`;
//   - the qualification text
//       `qualification_text`: the closed projection of the human Decision
//       (`actorKind=human`, `actorId=electron:human-review`, `decision=approved`,
//       `authorityScope=project/<project>/proposal/<proposal>/revision/<revision>`
//       from `derive_decision_authority`).
// Values that a product writer generates when the setup runs (Codex / Scene /
// project ids, Revision / proposal / Decision ids, the Codex source token and
// the Scope authority revision) are written as `{{<kind>:<logicalId>}}`
// placeholders (contract.mjs). Nothing here may be derived from a payload.
import { createHash } from "node:crypto";
import { canonicalJson } from "./payload.mjs";

export const FAMILY = "nir1.entity-relation@1";
export const SCOPE_PURPOSE = "nir1-entity-relation-review";
export const SCOPE_AUTO_REASON = "typed-review-input";
export const REVEAL_AUDIENCE = "reader";
export const DECISION_ACTOR_ID = "electron:human-review";
export const DECISION_ACTOR_KIND = "human";
export const DECISION_VALUE = "approved";
export const PART_ORDER = Object.freeze([
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
]);

export const placeholder = (kind, logicalId) => `{{${kind}:${logicalId}}}`;

const sha256Hex = (text) =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** `closed_marker` of nir1_packing.rs for the two parts the family does not represent. */
export function closedMarker(part) {
  return canonicalJson({
    status: "not-represented-by-this-family",
    family: FAMILY,
    atomicPart: part,
  });
}

/**
 * The expected five entry templates of one Revision whose only record is one
 * Codex Entity.
 *
 * `revision`  { logicalId }
 * `entity`    { logicalId, type, name, summary }   (summary is the Evidence quote)
 * `anchorSceneLogicalId`, `projectLogicalId`, `scopeAuthorityLogicalId`  logical names
 * whose runtime values the setup receipt fixes.
 */
export function deriveEntryTemplates({
  revision,
  entity,
  anchorSceneLogicalId,
  projectLogicalId,
  scopeAuthorityLogicalId,
}) {
  const entityId = placeholder("runtimeId", entity.logicalId);
  const sourceToken = placeholder("sourceToken", entity.logicalId);
  const quote = entity.summary.trim().length > 0 ? entity.summary : entity.name;
  const evidenceId = `nir1:evidence:codex:${entityId}`;
  const sourceRef = `codex:${entityId}`;
  const scope = {
    reading: {
      kind: "exact",
      value: `scene:${placeholder("runtimeId", anchorSceneLogicalId)}`,
    },
    story: { kind: "any", purpose: SCOPE_PURPOSE },
    auto: { kind: "notApplicable", reason: SCOPE_AUTO_REASON },
    phase: "draft",
    reveal: REVEAL_AUDIENCE,
    pov: null,
    authorityRevision: placeholder("revisionToken", scopeAuthorityLogicalId),
  };
  const entityValue = {
    entityId,
    entityType: entity.type,
    label: entity.name,
    sourceToken,
    scope,
    evidence: [
      {
        evidenceId,
        sourceRef,
        quote,
        startUtf16: 0,
        // UTF-16 code units, as `encode_utf16().count()`.
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
  const proposalId = placeholder("proposalId", revision.logicalId);
  const revisionId = placeholder("revisionId", revision.logicalId);
  const parts = {
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
      decisionId: placeholder("decisionId", revision.logicalId),
      actorKind: DECISION_ACTOR_KIND,
      actorId: DECISION_ACTOR_ID,
      authorityScope: `project/${placeholder("runtimeId", projectLogicalId)}/proposal/${proposalId}/revision/${revisionId}`,
      proposalId,
      revisionId,
      recordId: entityId,
    }),
  };
  return PART_ORDER.map((part) => ({
    logicalId: `${revision.logicalId}.${part}`,
    groupLogicalId: revision.logicalId,
    part,
    text: parts[part],
  }));
}
