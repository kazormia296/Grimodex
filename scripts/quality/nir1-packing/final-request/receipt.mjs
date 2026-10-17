// Receipt and setup receipt schemas for the final-request evaluation
// (DP-H, K6/2 nir1-final-request-packing-eval).
//
// The receipt is written under `.artifacts/` by the evaluation-only Native
// module (cargo test) and read by the scorer; neither is committed. These
// schemas are the contract between the two: a field the scorer needs and the
// receipt lacks is an error, not a default. Required fields are closed;
// fields a later phase (DD-1) adds go in the `extensions` object of the
// receipt, the request or the setup case, so DD-1 can extend the shape
// without DP-H pre-filling DD-1's fields.
//
// Receipt shape (one `requests[]` entry per D-final call):
//   dfinal      D-final's return value for the request (Ok with the payload
//               digest, or Err with code and reason). Written by the harness.
//   capture     (c-1) the candidate set before packing and, per candidate, the
//               input reference and qualification refs derived by the product
//               function; (c-2) the rendered request right after the renderer
//               (turn, user message, route, budget, payload digest, render
//               correspondence, every input reference and qualification ref).
//               Absent for a rejected request.
//   candidate   the payload D-final rendered (canonical JSON string).
//   baseline    P-12 only: the baseline arm built from the same capture, with
//               its own render input (input references, qualification refs).
//   history     the history slot (DP-H: always zero inputs, not applicable).
//   attemptRowsAdded  attempts the request created (a reject variant: 0).
export const RECEIPT_SCHEMA_VERSION = "nir1-final-request-receipt/1";
export const SETUP_RECEIPT_SCHEMA_VERSION =
  "nir1-final-request-setup-receipt/1";
export const CONTRACT_ID = "nir1-final-request-packing-eval";
export const DRAFT_REF = "nir1-final-request-eval-proposal/2";

export const RECEIPT_ENTRIES = Object.freeze(["cargo-test"]);

export const QUALIFICATION_KINDS = Object.freeze([
  "source",
  "revision",
  "decision",
  "freshness",
  "index",
  "scope",
  "d1",
]);
export const QUALIFICATION_STATES = Object.freeze([
  "present",
  "not-applicable",
]);
export const INPUT_ROLES = Object.freeze([
  "system",
  "user",
  "assistant",
  "context",
]);
export const INPUT_TARGET_KINDS = Object.freeze([
  "message",
  "artifact",
  "raw-source",
  "accepted-revision",
  "graph-evidence",
]);
export const POSITION_KINDS = Object.freeze([
  "system-current-scene",
  "system-codex-entry",
]);
export const ITEM_KINDS = Object.freeze([
  "raw",
  "accepted-ir",
  "graph-evidence",
  "author-declared",
  "unreviewed-for-review",
]);
export const ATOMIC_PARTS = Object.freeze([
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
]);
export const ARM_OUTCOMES = Object.freeze([
  "rendered",
  "unrenderable",
  "input-reduction-required",
  "window-exceeded",
]);

/** `canonical_json_digest` spells a digest as `sha256:<lowercase hex>`. */
export const PAYLOAD_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value) {
  return typeof value === "string" && value.length > 0;
}

function nat(value) {
  return Number.isInteger(value) && value >= 0;
}

function closedKeys(value, label, required, optional, errors) {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is required`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not a known field`);
  }
  return true;
}

function checkExtensions(value, label, errors) {
  if (value !== undefined && !isRecord(value)) {
    errors.push(`${label}.extensions must be an object`);
  }
}

function checkStringArray(value, label, errors, { allowEmpty = true } = {}) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !str(entry)) ||
    (!allowEmpty && value.length === 0)
  ) {
    errors.push(`${label} must be an array of non-empty strings`);
    return false;
  }
  return true;
}

export function validateInputReference(reference, label, errors) {
  if (!closedKeys(reference, label, ["role", "target"], [], errors)) return;
  if (!INPUT_ROLES.includes(reference.role)) {
    errors.push(`${label}.role is not a known input role`);
  }
  const target = reference.target;
  if (!isRecord(target) || !INPUT_TARGET_KINDS.includes(target.kind)) {
    errors.push(`${label}.target.kind is not a known input target kind`);
    return;
  }
  const fields = {
    message: ["versionId"],
    artifact: ["artifactId", "payloadDigest"],
    "raw-source": ["sourceKey", "revisionToken"],
    "accepted-revision": ["revisionId", "bundleDigest"],
    "graph-evidence": ["evidenceRef", "sourceKey", "revisionToken"],
  }[target.kind];
  for (const field of fields) {
    if (!str(target[field]))
      errors.push(`${label}.target.${field} is required`);
  }
}

export function validateQualificationRow(row, label, errors, { withOrdinal }) {
  const required = ["state", "kind"];
  if (withOrdinal) required.push("inputOrdinal");
  const optional = ["identity", "version", "scopeRole", "reason"];
  if (!closedKeys(row, label, required, optional, errors)) return;
  if (withOrdinal && !nat(row.inputOrdinal)) {
    errors.push(`${label}.inputOrdinal must be a non-negative integer`);
  }
  if (!QUALIFICATION_KINDS.includes(row.kind)) {
    errors.push(`${label}.kind is not a known qualification kind`);
  }
  if (!QUALIFICATION_STATES.includes(row.state)) {
    errors.push(`${label}.state must be present or not-applicable`);
    return;
  }
  if (row.state === "present") {
    if (!str(row.identity)) errors.push(`${label}.identity is required`);
    if (!str(row.version)) errors.push(`${label}.version is required`);
    if (row.kind === "scope" && !str(row.scopeRole)) {
      errors.push(`${label}.scopeRole is required for a present scope ref`);
    }
    if (row.kind !== "scope" && row.scopeRole !== undefined) {
      errors.push(`${label}.scopeRole is only valid for a scope ref`);
    }
    if (row.reason !== undefined) {
      errors.push(`${label}.reason is only valid for a typed N/A`);
    }
  } else {
    if (!str(row.reason))
      errors.push(`${label}.reason is required for a typed N/A`);
    for (const key of ["identity", "version", "scopeRole"]) {
      if (row[key] !== undefined) {
        errors.push(`${label}.${key} is not valid for a typed N/A`);
      }
    }
  }
}

function validateCorrespondence(rows, label, errors) {
  if (!Array.isArray(rows)) {
    errors.push(`${label} must be an array`);
    return;
  }
  for (const [index, row] of rows.entries()) {
    const rowLabel = `${label}[${index}]`;
    if (!closedKeys(row, rowLabel, ["position", "inputOrdinal"], [], errors)) {
      continue;
    }
    if (!nat(row.inputOrdinal)) {
      errors.push(`${rowLabel}.inputOrdinal must be a non-negative integer`);
    }
    const position = row.position;
    if (!isRecord(position) || !POSITION_KINDS.includes(position.kind)) {
      errors.push(`${rowLabel}.position.kind is not a known position`);
    } else if (position.kind === "system-codex-entry" && !nat(position.index)) {
      errors.push(`${rowLabel}.position.index must be a non-negative integer`);
    }
  }
}

function validateRoute(route, label, errors) {
  if (
    !closedKeys(
      route,
      label,
      ["routeRevision", "model", "contextWindowTokens", "outputTokens"],
      [],
      errors,
    )
  ) {
    return;
  }
  if (!str(route.routeRevision))
    errors.push(`${label}.routeRevision is required`);
  if (!str(route.model)) errors.push(`${label}.model is required`);
  for (const key of ["contextWindowTokens", "outputTokens"]) {
    if (!nat(route[key]) || route[key] === 0) {
      errors.push(`${label}.${key} must be a positive integer`);
    }
  }
}

function validateTemplateRef(template, label, errors) {
  if (!closedKeys(template, label, ["version", "ref"], ["sha256"], errors))
    return;
  if (!str(template.version)) errors.push(`${label}.version is required`);
  if (!str(template.ref)) errors.push(`${label}.ref is required`);
  if (template.sha256 !== undefined && !SHA256_PATTERN.test(template.sha256)) {
    errors.push(`${label}.sha256 must be a lowercase sha256 hex`);
  }
}

const SAME_INPUT_FIELDS = Object.freeze([
  "capturedTurnId",
  "userMessageDigestSha256",
  "snapshotIdentity",
  "candidateSetDigest",
  "estimatorVersion",
  "template",
  "route",
  "contextBudgetTokens",
  "measure",
  "passedRevisionIds",
]);

/** The fields the "same input" check compares (draft: 同じ入力の検査). */
export { SAME_INPUT_FIELDS };

function validateSameInput(inputs, label, errors) {
  if (!closedKeys(inputs, label, SAME_INPUT_FIELDS, [], errors)) return;
  for (const key of [
    "capturedTurnId",
    "snapshotIdentity",
    "candidateSetDigest",
    "estimatorVersion",
    "measure",
  ]) {
    if (!str(inputs[key])) errors.push(`${label}.${key} is required`);
  }
  if (!SHA256_PATTERN.test(inputs.userMessageDigestSha256 ?? "")) {
    errors.push(
      `${label}.userMessageDigestSha256 must be a lowercase sha256 hex`,
    );
  }
  validateTemplateRef(inputs.template, `${label}.template`, errors);
  validateRoute(inputs.route, `${label}.route`, errors);
  if (!nat(inputs.contextBudgetTokens)) {
    errors.push(`${label}.contextBudgetTokens must be a non-negative integer`);
  }
  checkStringArray(
    inputs.passedRevisionIds,
    `${label}.passedRevisionIds`,
    errors,
  );
}

function validateCandidateSet(set, label, errors) {
  if (
    !closedKeys(set, label, ["digest", "items", "candidateRefs"], [], errors)
  ) {
    return;
  }
  if (!str(set.digest)) errors.push(`${label}.digest is required`);
  if (!Array.isArray(set.items) || set.items.length === 0) {
    errors.push(`${label}.items must be a non-empty array`);
  } else {
    for (const [index, item] of set.items.entries()) {
      const itemLabel = `${label}.items[${index}]`;
      if (
        !closedKeys(
          item,
          itemLabel,
          ["itemId", "kind", "text", "tokens", "ownerId", "bindingDigest"],
          ["atomicGroup", "atomicPart"],
          errors,
        )
      ) {
        continue;
      }
      if (!str(item.itemId)) errors.push(`${itemLabel}.itemId is required`);
      if (!ITEM_KINDS.includes(item.kind)) {
        errors.push(`${itemLabel}.kind is not a known item kind`);
      }
      if (typeof item.text !== "string")
        errors.push(`${itemLabel}.text must be a string`);
      if (!nat(item.tokens))
        errors.push(`${itemLabel}.tokens must be a non-negative integer`);
      if (!str(item.ownerId)) errors.push(`${itemLabel}.ownerId is required`);
      if (!str(item.bindingDigest))
        errors.push(`${itemLabel}.bindingDigest is required`);
      if (item.kind === "raw") {
        if (item.atomicGroup !== undefined || item.atomicPart !== undefined) {
          errors.push(`${itemLabel} raw item must not carry an atomic group`);
        }
      } else {
        if (!str(item.atomicGroup))
          errors.push(`${itemLabel}.atomicGroup is required`);
        if (!ATOMIC_PARTS.includes(item.atomicPart)) {
          errors.push(`${itemLabel}.atomicPart is not a known atomic part`);
        }
      }
    }
  }
  if (!Array.isArray(set.candidateRefs)) {
    errors.push(`${label}.candidateRefs must be an array`);
    return;
  }
  for (const [index, entry] of set.candidateRefs.entries()) {
    const entryLabel = `${label}.candidateRefs[${index}]`;
    if (
      !closedKeys(
        entry,
        entryLabel,
        ["ownerId", "input", "qualifications"],
        [],
        errors,
      )
    ) {
      continue;
    }
    if (!str(entry.ownerId)) errors.push(`${entryLabel}.ownerId is required`);
    validateInputReference(entry.input, `${entryLabel}.input`, errors);
    if (!Array.isArray(entry.qualifications)) {
      errors.push(`${entryLabel}.qualifications must be an array`);
    } else {
      for (const [rowIndex, row] of entry.qualifications.entries()) {
        validateQualificationRow(
          row,
          `${entryLabel}.qualifications[${rowIndex}]`,
          errors,
          { withOrdinal: false },
        );
      }
    }
  }
}

function validateRenderedInputs(value, label, errors) {
  if (!Array.isArray(value.inputReferences)) {
    errors.push(`${label}.inputReferences must be an array`);
  } else {
    for (const [index, reference] of value.inputReferences.entries()) {
      validateInputReference(
        reference,
        `${label}.inputReferences[${index}]`,
        errors,
      );
    }
  }
  if (!Array.isArray(value.qualifications)) {
    errors.push(`${label}.qualifications must be an array`);
  } else {
    for (const [index, row] of value.qualifications.entries()) {
      validateQualificationRow(
        row,
        `${label}.qualifications[${index}]`,
        errors,
        {
          withOrdinal: true,
        },
      );
    }
  }
  validateCorrespondence(
    value.renderCorrespondence,
    `${label}.renderCorrespondence`,
    errors,
  );
}

function validateCapture(capture, label, errors) {
  if (
    !closedKeys(
      capture,
      label,
      [
        "requestToken",
        "capturedTurnId",
        "userMessage",
        "snapshotIdentity",
        "estimatorVersion",
        "template",
        "route",
        "contextBudgetTokens",
        "measure",
        "passedRevisionIds",
        "candidateSet",
        "rendered",
      ],
      ["extensions"],
      errors,
    )
  ) {
    return;
  }
  for (const key of [
    "requestToken",
    "capturedTurnId",
    "snapshotIdentity",
    "estimatorVersion",
    "measure",
  ]) {
    if (!str(capture[key])) errors.push(`${label}.${key} is required`);
  }
  const user = capture.userMessage;
  if (
    closedKeys(
      user,
      `${label}.userMessage`,
      ["text", "digestSha256", "versionId"],
      [],
      errors,
    )
  ) {
    if (typeof user.text !== "string" || user.text.length === 0) {
      errors.push(`${label}.userMessage.text must be a non-empty string`);
    }
    if (!SHA256_PATTERN.test(user.digestSha256 ?? "")) {
      errors.push(
        `${label}.userMessage.digestSha256 must be a lowercase sha256 hex`,
      );
    }
    if (!str(user.versionId))
      errors.push(`${label}.userMessage.versionId is required`);
  }
  validateTemplateRef(capture.template, `${label}.template`, errors);
  validateRoute(capture.route, `${label}.route`, errors);
  if (!nat(capture.contextBudgetTokens)) {
    errors.push(`${label}.contextBudgetTokens must be a non-negative integer`);
  }
  checkStringArray(
    capture.passedRevisionIds,
    `${label}.passedRevisionIds`,
    errors,
  );
  validateCandidateSet(capture.candidateSet, `${label}.candidateSet`, errors);
  const rendered = capture.rendered;
  if (
    closedKeys(
      rendered,
      `${label}.rendered`,
      [
        "payloadDigest",
        "renderCorrespondence",
        "inputReferences",
        "qualifications",
      ],
      [],
      errors,
    )
  ) {
    if (!PAYLOAD_DIGEST_PATTERN.test(rendered.payloadDigest ?? "")) {
      errors.push(
        `${label}.rendered.payloadDigest must be a sha256:<hex> digest`,
      );
    }
    validateRenderedInputs(rendered, `${label}.rendered`, errors);
  }
  checkExtensions(capture.extensions, label, errors);
}

function validateArm(arm, label, errors, armName) {
  if (
    !closedKeys(
      arm,
      label,
      armName === "baseline"
        ? ["arm", "outcome", "persistedRows"]
        : ["arm", "outcome"],
      [
        "payload",
        "payloadDigest",
        "renderCorrespondence",
        "inputReferences",
        "qualifications",
        "inputs",
        "counters",
        "reason",
        "extensions",
      ],
      errors,
    )
  ) {
    return;
  }
  if (arm.arm !== armName) errors.push(`${label}.arm must be ${armName}`);
  if (armName === "baseline" && !nat(arm.persistedRows)) {
    errors.push(
      `${label}.persistedRows must be a non-negative integer (rows the baseline arm added to attempt or receipt tables)`,
    );
  }
  if (!ARM_OUTCOMES.includes(arm.outcome)) {
    errors.push(`${label}.outcome is not a known arm outcome`);
    return;
  }
  if (arm.outcome === "rendered") {
    if (typeof arm.payload !== "string" || arm.payload.length === 0) {
      errors.push(`${label}.payload is required for a rendered arm`);
    }
    if (!PAYLOAD_DIGEST_PATTERN.test(arm.payloadDigest ?? "")) {
      errors.push(`${label}.payloadDigest must be a sha256:<hex> digest`);
    }
    if (armName === "baseline") {
      validateRenderedInputs(arm, label, errors);
      validateSameInput(arm.inputs, `${label}.inputs`, errors);
    } else {
      validateCorrespondence(
        arm.renderCorrespondence,
        `${label}.renderCorrespondence`,
        errors,
      );
    }
  } else if (arm.payload !== undefined || arm.payloadDigest !== undefined) {
    errors.push(
      `${label} must not carry a payload when the outcome is ${arm.outcome}`,
    );
  }
  if (arm.counters !== undefined) {
    if (!isRecord(arm.counters) || !nat(arm.counters.qualifiedEvidence)) {
      errors.push(
        `${label}.counters.qualifiedEvidence must be a non-negative integer`,
      );
    }
  }
  checkExtensions(arm.extensions, label, errors);
}

function validateDfinal(dfinal, label, errors) {
  if (
    !closedKeys(
      dfinal,
      label,
      ["outcome"],
      ["code", "reason", "payloadDigest"],
      errors,
    )
  ) {
    return;
  }
  if (dfinal.outcome === "ok") {
    if (!PAYLOAD_DIGEST_PATTERN.test(dfinal.payloadDigest ?? "")) {
      errors.push(
        `${label}.payloadDigest must be a sha256:<hex> digest for Ok`,
      );
    }
    if (dfinal.code !== undefined || dfinal.reason !== undefined) {
      errors.push(`${label} Ok must not carry a code or reason`);
    }
  } else if (dfinal.outcome === "err") {
    if (!str(dfinal.code)) errors.push(`${label}.code is required for Err`);
    if (dfinal.reason !== undefined && typeof dfinal.reason !== "string") {
      errors.push(`${label}.reason must be a string`);
    }
    if (dfinal.payloadDigest !== undefined) {
      errors.push(`${label} Err must not carry a payload digest`);
    }
  } else {
    errors.push(`${label}.outcome must be ok or err`);
  }
}

function validateRequest(request, label, errors) {
  if (
    !closedKeys(
      request,
      label,
      [
        "requestId",
        "caseId",
        "variantId",
        "requestKind",
        "stage",
        "passedRevisionIds",
        "dfinal",
        "capture",
        "candidate",
        "baseline",
        "history",
        "attemptRowsAdded",
      ],
      ["extensions"],
      errors,
    )
  ) {
    return;
  }
  for (const key of ["requestId", "caseId", "variantId"]) {
    if (!str(request[key])) errors.push(`${label}.${key} is required`);
  }
  if (!["positive", "reject"].includes(request.requestKind)) {
    errors.push(`${label}.requestKind must be positive or reject`);
  }
  if (!Number.isInteger(request.stage) || request.stage < 1) {
    errors.push(`${label}.stage must be a positive integer`);
  }
  checkStringArray(
    request.passedRevisionIds,
    `${label}.passedRevisionIds`,
    errors,
    {
      allowEmpty: false,
    },
  );
  validateDfinal(request.dfinal, `${label}.dfinal`, errors);
  if (request.capture !== null)
    validateCapture(request.capture, `${label}.capture`, errors);
  if (request.candidate !== null)
    validateArm(request.candidate, `${label}.candidate`, errors, "candidate");
  if (request.baseline !== null)
    validateArm(request.baseline, `${label}.baseline`, errors, "baseline");
  if (
    closedKeys(
      request.history,
      `${label}.history`,
      ["inputCount", "reason"],
      [],
      errors,
    )
  ) {
    if (!nat(request.history.inputCount)) {
      errors.push(`${label}.history.inputCount must be a non-negative integer`);
    }
    if (!str(request.history.reason))
      errors.push(`${label}.history.reason is required`);
  }
  if (!nat(request.attemptRowsAdded)) {
    errors.push(`${label}.attemptRowsAdded must be a non-negative integer`);
  }
  checkExtensions(request.extensions, label, errors);
}

/** Schema errors of a receipt (an empty array means the shape is valid). */
export function validateReceipt(receipt) {
  const errors = [];
  if (
    !closedKeys(
      receipt,
      "receipt",
      [
        "schemaVersion",
        "contractId",
        "draftRef",
        "producer",
        "run",
        "freeze",
        "inputs",
        "requests",
      ],
      ["extensions"],
      errors,
    )
  ) {
    return errors;
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    errors.push(`receipt.schemaVersion must be ${RECEIPT_SCHEMA_VERSION}`);
  }
  if (receipt.contractId !== CONTRACT_ID)
    errors.push(`receipt.contractId must be ${CONTRACT_ID}`);
  if (receipt.draftRef !== DRAFT_REF)
    errors.push(`receipt.draftRef must be ${DRAFT_REF}`);

  const producer = receipt.producer;
  if (
    closedKeys(
      producer,
      "receipt.producer",
      ["entry", "evalFeature", "featureSet"],
      ["extensions"],
      errors,
    )
  ) {
    if (!RECEIPT_ENTRIES.includes(producer.entry)) {
      errors.push(
        `receipt.producer.entry must be one of ${RECEIPT_ENTRIES.join(", ")}`,
      );
    }
    if (!str(producer.evalFeature))
      errors.push("receipt.producer.evalFeature is required");
    checkStringArray(
      producer.featureSet,
      "receipt.producer.featureSet",
      errors,
      { allowEmpty: false },
    );
    checkExtensions(producer.extensions, "receipt.producer", errors);
  }
  const run = receipt.run;
  if (
    closedKeys(
      run,
      "receipt.run",
      ["commit", "tree", "workspaceClean"],
      ["extensions"],
      errors,
    )
  ) {
    if (!COMMIT_PATTERN.test(run.commit ?? ""))
      errors.push("receipt.run.commit must be a full commit id");
    if (!COMMIT_PATTERN.test(run.tree ?? ""))
      errors.push("receipt.run.tree must be a full tree id");
    if (run.workspaceClean !== true)
      errors.push("receipt.run.workspaceClean must be true");
    checkExtensions(run.extensions, "receipt.run", errors);
  }
  const freeze = receipt.freeze;
  if (
    closedKeys(
      freeze,
      "receipt.freeze",
      ["path", "recordSha256", "commit"],
      [],
      errors,
    )
  ) {
    if (!str(freeze.path)) errors.push("receipt.freeze.path is required");
    if (!SHA256_PATTERN.test(freeze.recordSha256 ?? "")) {
      errors.push("receipt.freeze.recordSha256 must be a lowercase sha256 hex");
    }
    if (!COMMIT_PATTERN.test(freeze.commit ?? "")) {
      errors.push("receipt.freeze.commit must be a full commit id");
    }
  }
  const inputs = receipt.inputs;
  if (
    closedKeys(
      inputs,
      "receipt.inputs",
      [
        "fixtureSha256",
        "scorerSha256",
        "fixtureVersion",
        "estimatorVersion",
        "fixedTemplate",
      ],
      [],
      errors,
    )
  ) {
    for (const key of ["fixtureSha256", "scorerSha256"]) {
      if (!SHA256_PATTERN.test(inputs[key] ?? "")) {
        errors.push(`receipt.inputs.${key} must be a lowercase sha256 hex`);
      }
    }
    if (!Number.isInteger(inputs.fixtureVersion) || inputs.fixtureVersion < 1) {
      errors.push("receipt.inputs.fixtureVersion must be a positive integer");
    }
    if (!str(inputs.estimatorVersion))
      errors.push("receipt.inputs.estimatorVersion is required");
    validateTemplateRef(
      inputs.fixedTemplate,
      "receipt.inputs.fixedTemplate",
      errors,
    );
    if (
      isRecord(inputs.fixedTemplate) &&
      !SHA256_PATTERN.test(inputs.fixedTemplate.sha256 ?? "")
    ) {
      errors.push("receipt.inputs.fixedTemplate.sha256 is required");
    }
  }
  if (!Array.isArray(receipt.requests) || receipt.requests.length === 0) {
    errors.push("receipt.requests must be a non-empty array");
  } else {
    const ids = new Set();
    for (const [index, request] of receipt.requests.entries()) {
      validateRequest(request, `receipt.requests[${index}]`, errors);
      if (isRecord(request) && str(request.requestId)) {
        if (ids.has(request.requestId)) {
          errors.push(
            `receipt.requests has a duplicate requestId ${request.requestId}`,
          );
        }
        ids.add(request.requestId);
      }
    }
  }
  checkExtensions(receipt.extensions, "receipt", errors);
  return errors;
}

// ---------------------------------------------------------------- setup receipt

/** Product writers the setup may use (draft: 製品の通常の writer). */
export const PRODUCT_WRITERS = Object.freeze([
  "save_scene_body_bundle",
  "narrative_scene_scope_update",
  "temporal_scene_patch",
  "tree_node_patch",
  "codex_create",
  "codex_mutate",
  "nir1_entity_relation_revision_prepare",
  "narrative_extraction_append_human_decision",
  "write_ai_settings",
  "db_execute:createSession",
  "activate_first_restricted_publication",
]);

/** Setup event kinds. The first group are the writes that must precede the first prepare. */
/**
 * The five binding kinds of P-10 (Scope, source, Revision, Decision, Freshness).
 * A binding change that is not a tree, Scope or Codex write is recorded as a
 * `binding-change` event whose `binding` field names the kind, written by a
 * product writer (no new vocabulary of writers).
 */
export const BINDING_KINDS = Object.freeze([
  "scope",
  "source",
  "revision",
  "decision",
  "freshness",
]);
export const SETUP_BASE_WRITE_KINDS = Object.freeze([
  "tree",
  "scope",
  "codex",
  "binding-change",
]);
export const SETUP_EVENT_KINDS = Object.freeze([
  ...SETUP_BASE_WRITE_KINDS,
  "route-settings",
  "prepare-negative",
  "approve-negative",
  "invalidate-negative",
  "prepare",
  "approve",
  "chat-session",
  "restricted",
  "capture",
]);

const SETUP_VERIFICATION_POINTS = Object.freeze(["setup-end", "request-pre"]);

function validateSetupEvent(event, label, errors) {
  if (
    !closedKeys(
      event,
      label,
      ["seq", "stage", "kind", "writer"],
      ["logicalId", "runtimeId", "supersedes", "binding"],
      errors,
    )
  ) {
    return;
  }
  if (event.binding !== undefined && !BINDING_KINDS.includes(event.binding)) {
    errors.push(`${label}.binding must be one of ${BINDING_KINDS.join(", ")}`);
  }
  if (event.kind === "binding-change" && event.binding === undefined) {
    errors.push(`${label}.binding is required for a binding-change event`);
  }
  if (!Number.isInteger(event.seq) || event.seq < 1)
    errors.push(`${label}.seq must be a positive integer`);
  if (!Number.isInteger(event.stage) || event.stage < 1)
    errors.push(`${label}.stage must be a positive integer`);
  if (!SETUP_EVENT_KINDS.includes(event.kind))
    errors.push(`${label}.kind is not a known setup event kind`);
  if (!str(event.writer)) errors.push(`${label}.writer is required`);
  for (const key of ["logicalId", "runtimeId", "supersedes"]) {
    if (event[key] !== undefined && !str(event[key]))
      errors.push(`${label}.${key} must be a non-empty string`);
  }
}

function validateVerification(verification, label, errors) {
  if (
    !closedKeys(
      verification,
      label,
      ["point", "stage", "revisions", "scopeAuthorityRevision", "d2a"],
      [],
      errors,
    )
  ) {
    return;
  }
  if (!SETUP_VERIFICATION_POINTS.includes(verification.point)) {
    errors.push(`${label}.point must be setup-end or request-pre`);
  }
  if (!Number.isInteger(verification.stage) || verification.stage < 1) {
    errors.push(`${label}.stage must be a positive integer`);
  }
  if (!str(verification.scopeAuthorityRevision)) {
    errors.push(`${label}.scopeAuthorityRevision is required`);
  }
  if (!Array.isArray(verification.revisions)) {
    errors.push(`${label}.revisions must be an array`);
  } else {
    for (const [index, revision] of verification.revisions.entries()) {
      const revisionLabel = `${label}.revisions[${index}]`;
      if (
        closedKeys(
          revision,
          revisionLabel,
          ["logicalId", "runtimeId", "a2", "a3", "freshness"],
          [],
          errors,
        )
      ) {
        for (const key of ["logicalId", "runtimeId", "a2", "a3", "freshness"]) {
          if (!str(revision[key]))
            errors.push(`${revisionLabel}.${key} is required`);
        }
      }
    }
  }
  if (
    closedKeys(
      verification.d2a,
      `${label}.d2a`,
      ["restricted", "inFlightStopped"],
      [],
      errors,
    )
  ) {
    for (const key of ["restricted", "inFlightStopped"]) {
      if (typeof verification.d2a[key] !== "boolean") {
        errors.push(`${label}.d2a.${key} must be a boolean`);
      }
    }
  }
}

function validateSetupCase(entry, label, errors) {
  if (
    !closedKeys(
      entry,
      label,
      [
        "caseId",
        "variantId",
        "workspaceNamespace",
        "events",
        "writersUsed",
        "directDmlObserved",
        "verifications",
        "idMap",
        "chatSession",
        "history",
        "valid",
      ],
      ["invalidReason", "extensions"],
      errors,
    )
  ) {
    return;
  }
  for (const key of ["caseId", "variantId", "workspaceNamespace"]) {
    if (!str(entry[key])) errors.push(`${label}.${key} is required`);
  }
  if (!Array.isArray(entry.events) || entry.events.length === 0) {
    errors.push(`${label}.events must be a non-empty array`);
  } else {
    for (const [index, event] of entry.events.entries()) {
      validateSetupEvent(event, `${label}.events[${index}]`, errors);
    }
  }
  checkStringArray(entry.writersUsed, `${label}.writersUsed`, errors, {
    allowEmpty: false,
  });
  if (typeof entry.directDmlObserved !== "boolean") {
    errors.push(`${label}.directDmlObserved must be a boolean`);
  }
  if (!Array.isArray(entry.verifications) || entry.verifications.length === 0) {
    errors.push(`${label}.verifications must be a non-empty array`);
  } else {
    for (const [index, verification] of entry.verifications.entries()) {
      validateVerification(
        verification,
        `${label}.verifications[${index}]`,
        errors,
      );
    }
  }
  if (!Array.isArray(entry.idMap)) {
    errors.push(`${label}.idMap must be an array`);
  } else {
    for (const [index, row] of entry.idMap.entries()) {
      if (
        closedKeys(
          row,
          `${label}.idMap[${index}]`,
          ["logicalId", "runtimeId"],
          [],
          errors,
        )
      ) {
        for (const key of ["logicalId", "runtimeId"]) {
          if (!str(row[key]))
            errors.push(`${label}.idMap[${index}].${key} is required`);
        }
      }
    }
  }
  if (
    closedKeys(
      entry.chatSession,
      `${label}.chatSession`,
      ["writer", "statementMatchesRenderer", "createdBeforeRestricted"],
      [],
      errors,
    )
  ) {
    if (!str(entry.chatSession.writer))
      errors.push(`${label}.chatSession.writer is required`);
    for (const key of ["statementMatchesRenderer", "createdBeforeRestricted"]) {
      if (typeof entry.chatSession[key] !== "boolean") {
        errors.push(`${label}.chatSession.${key} must be a boolean`);
      }
    }
  }
  if (
    closedKeys(
      entry.history,
      `${label}.history`,
      ["inputCount", "reason"],
      [],
      errors,
    )
  ) {
    if (!nat(entry.history.inputCount))
      errors.push(`${label}.history.inputCount must be a non-negative integer`);
    if (!str(entry.history.reason))
      errors.push(`${label}.history.reason is required`);
  }
  if (typeof entry.valid !== "boolean")
    errors.push(`${label}.valid must be a boolean`);
  if (entry.valid === false && !str(entry.invalidReason)) {
    errors.push(`${label}.invalidReason is required when valid is false`);
  }
  checkExtensions(entry.extensions, label, errors);
}

export function validateSetupReceipt(setup) {
  const errors = [];
  if (
    !closedKeys(
      setup,
      "setupReceipt",
      ["schemaVersion", "contractId", "run", "cases"],
      ["extensions"],
      errors,
    )
  ) {
    return errors;
  }
  if (setup.schemaVersion !== SETUP_RECEIPT_SCHEMA_VERSION) {
    errors.push(
      `setupReceipt.schemaVersion must be ${SETUP_RECEIPT_SCHEMA_VERSION}`,
    );
  }
  if (setup.contractId !== CONTRACT_ID)
    errors.push(`setupReceipt.contractId must be ${CONTRACT_ID}`);
  if (
    closedKeys(setup.run, "setupReceipt.run", ["commit", "tree"], [], errors)
  ) {
    if (!COMMIT_PATTERN.test(setup.run.commit ?? ""))
      errors.push("setupReceipt.run.commit must be a full commit id");
    if (!COMMIT_PATTERN.test(setup.run.tree ?? ""))
      errors.push("setupReceipt.run.tree must be a full tree id");
  }
  if (!Array.isArray(setup.cases) || setup.cases.length === 0) {
    errors.push("setupReceipt.cases must be a non-empty array");
  } else {
    const keys = new Set();
    for (const [index, entry] of setup.cases.entries()) {
      validateSetupCase(entry, `setupReceipt.cases[${index}]`, errors);
      if (isRecord(entry)) {
        const key = `${entry.caseId}/${entry.variantId}`;
        if (keys.has(key))
          errors.push(`setupReceipt.cases has a duplicate ${key}`);
        keys.add(key);
      }
    }
  }
  checkExtensions(setup.extensions, "setupReceipt", errors);
  return errors;
}
