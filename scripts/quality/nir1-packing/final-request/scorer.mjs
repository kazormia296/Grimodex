// Scorer for the final-request evaluation (DP-H, K6/2
// nir1-final-request-packing-eval).
//
// It reads a receipt (and a setup receipt) written by the evaluation-only
// Native module and scores the nine DP-H cases against the pre-registered
// fixture. It never reads a database, an IPC reader or Native output other
// than the receipt, and it derives every figure from the payload bytes:
//   - slots (`qualifiedEvidence`) are counted from the rendered payload, never
//     from an arm's selected-item list, a label or a harness counter;
//   - a request is scored only when D-final returned Ok and the payload digest
//     (recomputed from the payload) equals the captured one;
//   - a reject variant is checked only for its typed refusal and never counts
//     as retention, forbidden-information or DP-1 evidence.
// Verdicts: "passed", "failed" (the product behaved wrongly), "invalid" (the
// run's setup or capture is unusable, so it is not counted as a product
// failure and must be re-measured), "rejected" (the receipt is not for this
// candidate or does not fit the schema).
//
// Rule sources: docs/plans/nir1-final-request-eval-proposal-2-draft.md,
// sections "slot の導出", "variant の区分と負例の表し方", "setup の前提と
// history 枠", "評価専用の呼び出し口", Mandatory defenses "同じ入力の検査",
// "採点する payload の資格".
import { createHash } from "node:crypto";
import {
  DPH_CASE_IDS,
  PLACEHOLDER_KINDS,
  PLACEHOLDER_VALUE_PATTERN,
  REJECT_CODE,
  resolveTemplate,
  scorerDigest,
  templatePlaceholders,
  validateFinalRequestFixture,
  variantRequests,
} from "./contract.mjs";
import {
  ESTIMATOR_VERSION,
  PayloadShapeError,
  contextBudgetTokens,
  cutSystemMessage,
  escapeReservedPromptTags,
  estimateTokens,
  parsePlainChatPayload,
  payloadDigest,
  reservedTotalTokens,
  canonicalJson,
} from "./payload.mjs";
import {
  ATOMIC_PARTS,
  PRODUCT_WRITERS,
  QUALIFICATION_KINDS,
  SAME_INPUT_FIELDS,
  SETUP_BASE_WRITE_KINDS,
  validateReceipt,
  validateSetupReceipt,
} from "./receipt.mjs";

export const SCORER_VERSION = "nir1-final-request-scorer/1";
const MEASURE = "item-estimate-sum";

function userDigest(text) {
  return createHash("sha256").update(text).digest("hex");
}

const fail = (code, message) => ({ code, message });

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function targetOwnerId(target) {
  switch (target?.kind) {
    case "accepted-revision":
      return target.revisionId;
    case "graph-evidence":
      return target.evidenceRef;
    case "raw-source":
      return target.sourceKey;
    case "message":
      return target.versionId;
    case "artifact":
      return target.artifactId;
    default:
      return undefined;
  }
}

// --------------------------------------------------------- qualifying request

/**
 * A request is scored only if D-final returned Ok and its payload digest
 * equals the captured candidate's (and the digest recomputed from the payload
 * bytes). Returns the reasons it is not scorable.
 */
export function qualifyingFailures(request) {
  const failures = [];
  if (request.dfinal.outcome !== "ok") {
    failures.push(
      fail(
        "dfinal-not-ok",
        `D-final returned ${request.dfinal.code ?? "Err"}${request.dfinal.reason ? `:${request.dfinal.reason}` : ""}; the request is not scored and no baseline is called`,
      ),
    );
    return failures;
  }
  if (request.capture === null || request.candidate === null) {
    failures.push(
      fail(
        "capture-missing",
        "an Ok request must carry a capture and a candidate arm",
      ),
    );
    return failures;
  }
  const digests = new Set([
    request.dfinal.payloadDigest,
    request.candidate.payloadDigest,
    request.capture.rendered.payloadDigest,
  ]);
  if (digests.size !== 1) {
    failures.push(
      fail(
        "payload-digest-mismatch",
        "the D-final payload digest, the candidate arm digest and the captured digest differ",
      ),
    );
    return failures;
  }
  if (
    !sameJson(
      request.candidate.renderCorrespondence,
      request.capture.rendered.renderCorrespondence,
    )
  ) {
    failures.push(
      fail(
        "render-correspondence-mismatch",
        "the candidate arm's render correspondence differs from the captured one",
      ),
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(request.candidate.payload);
  } catch {
    failures.push(
      fail("payload-not-json", "the candidate payload is not JSON"),
    );
    return failures;
  }
  if (canonicalJson(parsed) !== request.candidate.payload) {
    failures.push(
      fail(
        "payload-not-canonical",
        "the candidate payload is not canonical JSON",
      ),
    );
  }
  if (payloadDigest(parsed) !== request.candidate.payloadDigest) {
    failures.push(
      fail(
        "payload-digest-recompute",
        "the payload digest does not match the digest recomputed from the payload bytes",
      ),
    );
  }
  return failures;
}

// ----------------------------------------------------------- capture checks

function qualificationKey(row) {
  return row.state === "present"
    ? `present|${row.kind}|${row.identity}|${row.version}|${row.scopeRole ?? ""}`
    : `na|${row.kind}|${row.reason}`;
}

/**
 * The completeness rule over a rendered request's refs: each input has, for
 * each of the 7 kinds, a present ref or a typed N/A (not both), with no
 * duplicate (kind, target). The scorer needs only the receipt for this.
 * Returns violation strings.
 */
export function completenessViolations(view) {
  const violations = [];
  const inputs = view.inputReferences;
  if (inputs.length === 0) return ["no input references"];
  const rows = new Map(inputs.map((_, ordinal) => [ordinal, []]));
  for (const row of view.qualifications) {
    if (!rows.has(row.inputOrdinal)) {
      violations.push(
        `qualification ref names missing input ordinal ${row.inputOrdinal}`,
      );
      continue;
    }
    rows.get(row.inputOrdinal).push(row);
  }
  for (const [ordinal, ordinalRows] of rows) {
    const seen = new Set();
    for (const row of ordinalRows) {
      const key = qualificationKey(row);
      if (seen.has(key))
        violations.push(`input ${ordinal} has a duplicate ${row.kind} ref`);
      seen.add(key);
    }
    for (const kind of QUALIFICATION_KINDS) {
      const ofKind = ordinalRows.filter((row) => row.kind === kind);
      if (ofKind.length === 0) {
        violations.push(`input ${ordinal} lacks a ${kind} ref or typed N/A`);
        continue;
      }
      const states = new Set(ofKind.map((row) => row.state));
      if (states.size > 1)
        violations.push(
          `input ${ordinal} has both a ${kind} ref and a typed N/A`,
        );
      if (
        ofKind.every((row) => row.state === "not-applicable") &&
        ofKind.length > 1
      ) {
        violations.push(`input ${ordinal} has several ${kind} typed N/A rows`);
      }
    }
  }
  return violations;
}

/**
 * The baseline arm builds its inputs from the capture's refs (draft: baseline
 * の入力は capture の ref から組む). Each baseline input reference and its
 * qualification refs must equal the captured ones: an owner's (c-1) refs for
 * Revision and Graph inputs, the (c-2) refs for the user and Raw inputs.
 * Compared apart from the input ordinal.
 */
export function baselineRefViolations(baselineView, capture) {
  const invalid = [];
  const rendered = capture.rendered;
  const keys = (rows, ordinal) =>
    rows
      .filter((row) => row.inputOrdinal === ordinal)
      .map(({ inputOrdinal: _ordinal, ...row }) => qualificationKey(row))
      .sort();
  const bad = (message) =>
    invalid.push(fail("capture-ref-mismatch", `baseline: ${message}`));
  for (const [ordinal, reference] of baselineView.inputReferences.entries()) {
    const kind = reference.target.kind;
    let expectedInput;
    let expectedKeys;
    if (kind === "accepted-revision" || kind === "graph-evidence") {
      const owner = targetOwnerId(reference.target);
      const candidate = capture.candidateSet.candidateRefs.find(
        (entry) => entry.ownerId === owner,
      );
      expectedInput = candidate?.input;
      expectedKeys = candidate
        ? candidate.qualifications.map(qualificationKey).sort()
        : undefined;
    } else {
      const captured = rendered.inputReferences.findIndex(
        (input) => input.target.kind === kind && input.role === reference.role,
      );
      expectedInput = rendered.inputReferences[captured];
      expectedKeys =
        captured >= 0 ? keys(rendered.qualifications, captured) : undefined;
    }
    if (!expectedInput) {
      bad(`input ${ordinal} (${kind}) has no captured reference`);
      continue;
    }
    if (!sameJson(reference, expectedInput)) {
      bad(`input ${ordinal} (${kind}) differs from the captured reference`);
    }
    if (!sameJson(keys(baselineView.qualifications, ordinal), expectedKeys)) {
      bad(
        `input ${ordinal} (${kind}) qualification refs differ from the captured ones`,
      );
    }
  }
  return invalid;
}

function codexRows(correspondence) {
  const rows = correspondence.filter(
    (row) => row.position.kind === "system-codex-entry",
  );
  return rows.sort((left, right) => left.position.index - right.position.index);
}

/**
 * Checks the capture a request carries. Returns `invalid` reasons (the run is
 * unusable: harness or Native wiring) and `failures` (the product's output is
 * wrong).
 */
export function checkCapture(capture, view) {
  const invalid = [];
  const items = capture.candidateSet.items;
  if (items.filter((item) => item.kind === "raw").length !== 1) {
    invalid.push(
      fail(
        "capture-incomplete:raw-item",
        "the candidate set must hold exactly one Raw item",
      ),
    );
  }
  const inputs = view.inputReferences;
  if (
    inputs.length < 3 ||
    inputs[0].role !== "user" ||
    inputs[0].target.kind !== "message"
  ) {
    invalid.push(
      fail(
        "capture-incomplete:inputs",
        "the rendered inputs must start with the user message and hold Raw and IR inputs",
      ),
    );
  }
  if (
    inputs.filter((input) => input.target.kind === "raw-source").length !== 1
  ) {
    invalid.push(
      fail(
        "capture-incomplete:raw-input",
        "the rendered inputs must hold exactly one Raw source",
      ),
    );
  }
  for (const row of view.renderCorrespondence) {
    if (
      !Number.isInteger(row.inputOrdinal) ||
      row.inputOrdinal >= inputs.length
    ) {
      invalid.push(
        fail(
          "capture-incomplete:ordinal",
          "a render correspondence row names a missing input",
        ),
      );
    }
  }
  for (const violation of completenessViolations(view)) {
    invalid.push(fail("capture-incomplete:completeness", violation));
  }
  // (c-1) refs derived by the product function must equal (c-2) refs apart
  // from the input ordinal, for every owner that was rendered.
  const ownerOrdinal = new Map();
  for (const row of view.renderCorrespondence) {
    const reference = inputs[row.inputOrdinal];
    if (!reference) continue;
    if (
      reference.target.kind === "accepted-revision" ||
      reference.target.kind === "graph-evidence"
    ) {
      ownerOrdinal.set(targetOwnerId(reference.target), row.inputOrdinal);
    }
  }
  for (const [ownerId, ordinal] of ownerOrdinal) {
    const candidate = capture.candidateSet.candidateRefs.find(
      (entry) => entry.ownerId === ownerId,
    );
    if (!candidate) {
      invalid.push(
        fail(
          "capture-ref-mismatch",
          `no candidate ref was captured for rendered owner ${ownerId}`,
        ),
      );
      continue;
    }
    if (!sameJson(candidate.input, inputs[ordinal])) {
      invalid.push(
        fail(
          "capture-ref-mismatch",
          `the captured input reference differs from the rendered one for ${ownerId}`,
        ),
      );
    }
    const rendered = view.qualifications
      .filter((row) => row.inputOrdinal === ordinal)
      .map(({ inputOrdinal: _ordinal, ...row }) => qualificationKey(row))
      .sort();
    const captured = candidate.qualifications.map(qualificationKey).sort();
    if (!sameJson(rendered, captured)) {
      invalid.push(
        fail(
          "capture-ref-mismatch",
          `the (c-1) qualification refs differ from the (c-2) refs for ${ownerId}`,
        ),
      );
    }
  }
  return invalid;
}

// ------------------------------------------------------------ payload views

function armView(request, arm) {
  if (arm === "candidate") {
    return {
      payload: request.candidate.payload,
      renderCorrespondence: request.capture.rendered.renderCorrespondence,
      inputReferences: request.capture.rendered.inputReferences,
      qualifications: request.capture.rendered.qualifications,
    };
  }
  return {
    payload: request.baseline.payload,
    renderCorrespondence: request.baseline.renderCorrespondence,
    inputReferences: request.baseline.inputReferences,
    qualifications: request.baseline.qualifications,
  };
}

/** Parses and cuts a payload; returns `{ failures }` or the parsed pieces. */
export function readPayload(view, capture, template) {
  const failures = [];
  let parsed;
  let cut;
  try {
    parsed = parsePlainChatPayload(view.payload);
    cut = cutSystemMessage(parsed.system, template);
  } catch (error) {
    if (error instanceof PayloadShapeError) {
      failures.push(
        fail(
          `payload-shape:${error.code}`,
          `payload cannot be cut: ${error.message}`,
        ),
      );
      return { failures };
    }
    throw error;
  }
  const codex = codexRows(view.renderCorrespondence);
  const scene = view.renderCorrespondence.filter(
    (row) => row.position.kind === "system-current-scene",
  );
  if (scene.length !== 1) {
    failures.push(
      fail(
        "entry-count-mismatch",
        "exactly one SystemCurrentScene correspondence row is required",
      ),
    );
  }
  if (
    codex.length !== cut.entries.length ||
    codex.some((row, index) => row.position.index !== index)
  ) {
    failures.push(
      fail(
        "entry-count-mismatch",
        `the payload holds ${cut.entries.length} codex entries but the render correspondence names ${codex.length}`,
      ),
    );
  }
  for (const item of capture.candidateSet.items) {
    if (item.kind !== "raw" && item.text.includes("\n")) {
      failures.push(
        fail(
          "separator-in-text",
          `candidate item ${item.itemId} contains the entry separator`,
        ),
      );
    }
  }
  return { failures, parsed, cut, codex, scene };
}

/**
 * Aligns each payload codex entry with a candidate-set item: the item of the
 * entry's owner (input reference of its correspondence row) whose text, after
 * the renderer's escape, equals the entry. Returns the matched item indexes
 * and the failures (entries not in the candidate set, partial atomic groups).
 */
export function alignEntries({ cut, codex, view, capture }) {
  const failures = [];
  const items = capture.candidateSet.items;
  const used = new Set();
  const matched = [];
  for (const [index, entry] of cut.entries.entries()) {
    const row = codex[index];
    const reference = row ? view.inputReferences[row.inputOrdinal] : undefined;
    const owner = reference ? targetOwnerId(reference.target) : undefined;
    const found = items.findIndex(
      (item, itemIndex) =>
        !used.has(itemIndex) &&
        item.kind !== "raw" &&
        item.ownerId === owner &&
        escapeReservedPromptTags(item.text) === entry,
    );
    if (found < 0) {
      failures.push(
        fail(
          "entry-not-in-candidate-set",
          `codex entry ${index} matches no unused candidate item of its owner`,
        ),
      );
      matched.push(-1);
      continue;
    }
    used.add(found);
    matched.push(found);
  }
  const groups = new Map();
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind === "raw") continue;
    const key = `${item.ownerId}\u0000${item.atomicGroup}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(itemIndex);
  }
  for (const [key, indexes] of groups) {
    const taken = indexes.filter((itemIndex) => used.has(itemIndex)).length;
    if (taken > 0 && taken < indexes.length) {
      failures.push(
        fail(
          "atomic-group-partial",
          `atomic group ${key.split("\u0000")[1]} has ${taken} of ${indexes.length} parts in the payload`,
        ),
      );
    }
  }
  return { failures, matched, used, groups };
}

/**
 * Counts the improvement groups that appear in the payload as five
 * consecutive entries (statement, negation, attribution, evidence,
 * qualification) of one owner, each equal to the candidate item's text, with
 * a complete qualification ref set. `improvementGroups` are
 * `{ ownerId, kind }` with runtime owner ids.
 *
 * The product emits one atomic group per entity or relation record, so a
 * Revision (owner) may hold several. Each (ownerId, atomicGroup) is judged on
 * its own, the way `alignEntries` keys its groups; an improvement group counts
 * once when at least one of its owner's atomic groups qualifies. `groups`
 * names every atomic group that was judged.
 */
export function deriveSlots({
  improvementGroups,
  cut,
  codex,
  view,
  capture,
  matched,
}) {
  const items = capture.candidateSet.items;
  const results = [];
  let qualifiedEvidence = 0;
  const judge = (group, atomicGroup, groupItems) => {
    const reasons = [];
    if (groupItems.some(({ item }) => item.kind !== group.kind)) {
      reasons.push(`group is not of kind ${group.kind}`);
    }
    const ordered = ATOMIC_PARTS.map((part) =>
      groupItems.filter(({ item }) => item.atomicPart === part),
    );
    if (ordered.some((rows) => rows.length !== 1)) {
      reasons.push("group does not have exactly one item per part");
    }
    if (reasons.length === 0) {
      const positions = ordered.map(([{ index }]) => matched.indexOf(index));
      if (positions.some((position) => position < 0)) {
        reasons.push("a part is missing from the payload");
      } else if (
        positions.some((position, offset) => position !== positions[0] + offset)
      ) {
        reasons.push(
          "the five parts are not consecutive entries in group order",
        );
      } else {
        const ordinals = new Set(
          positions.map((position) => codex[position].inputOrdinal),
        );
        const ownerOrdinals = [...ordinals].filter(
          (ordinal) =>
            targetOwnerId(view.inputReferences[ordinal]?.target) ===
            group.ownerId,
        );
        if (ordinals.size !== 1 || ownerOrdinals.length !== 1) {
          reasons.push(
            "the five parts do not belong to one input of the group's owner",
          );
        } else {
          const [ordinal] = ownerOrdinals;
          const rows = view.qualifications.filter(
            (row) => row.inputOrdinal === ordinal,
          );
          const violations = completenessViolations({
            inputReferences: [view.inputReferences[ordinal]],
            qualifications: rows.map((row) => ({ ...row, inputOrdinal: 0 })),
          });
          if (violations.length > 0)
            reasons.push(`qualification refs are incomplete: ${violations[0]}`);
        }
      }
    }
    return { atomicGroup, counted: reasons.length === 0, reasons };
  };
  for (const group of improvementGroups) {
    const byAtomicGroup = new Map();
    items.forEach((item, index) => {
      if (item.ownerId !== group.ownerId || item.kind === "raw") return;
      if (!byAtomicGroup.has(item.atomicGroup))
        byAtomicGroup.set(item.atomicGroup, []);
      byAtomicGroup.get(item.atomicGroup).push({ item, index });
    });
    const atomicGroups = [...byAtomicGroup].map(([atomicGroup, groupItems]) =>
      judge(group, atomicGroup, groupItems),
    );
    const counted = atomicGroups.some((entry) => entry.counted);
    if (counted) qualifiedEvidence += 1;
    results.push({
      ownerId: group.ownerId,
      counted,
      reasons: counted
        ? []
        : atomicGroups.length === 0
          ? ["group is not in the candidate set"]
          : atomicGroups.flatMap((entry) => entry.reasons),
      atomicGroups,
    });
  }
  return { qualifiedEvidence, groups: results };
}

// -------------------------------------------------------------- same input

/** The "same input" figures of one capture. */
export function inputsOfCapture(capture) {
  return {
    capturedTurnId: capture.capturedTurnId,
    userMessageDigestSha256: capture.userMessage.digestSha256,
    snapshotIdentity: capture.snapshotIdentity,
    candidateSetDigest: capture.candidateSet.digest,
    estimatorVersion: capture.estimatorVersion,
    template: { version: capture.template.version, ref: capture.template.ref },
    route: capture.route,
    contextBudgetTokens: capture.contextBudgetTokens,
    measure: capture.measure,
    passedRevisionIds: capture.passedRevisionIds,
  };
}

function templateIdentity(template) {
  return { version: template.version, ref: template.ref };
}

/** Compares two input sets field by field; each difference is its own failure. */
export function checkSameInput(actual, expected, { label }) {
  const failures = [];
  for (const field of SAME_INPUT_FIELDS) {
    if (expected[field] === undefined) continue;
    const left =
      field === "template" ? templateIdentity(actual.template) : actual[field];
    const right =
      field === "template"
        ? templateIdentity(expected.template)
        : expected[field];
    if (!sameJson(left, right)) {
      failures.push(
        fail(
          `same-input-check-rejects-${field}`,
          `${label}: ${field} differs (${canonicalJson(left)} vs ${canonicalJson(right)})`,
        ),
      );
    }
  }
  return failures;
}

// -------------------------------------------------------------------- scans

/**
 * Looks for forbidden information in the decoded system and user messages and
 * in the raw payload text: the seeded canaries, a request's forbidden strings
 * and ids, and other cases' marker strings and runtime ids.
 */
export function scanForbidden({
  payload,
  system,
  user,
  canaries,
  forbiddenTexts,
  forbiddenIds,
  otherMarkers,
  otherIds,
}) {
  const failures = [];
  const haystacks = [payload, system, user];
  // The renderer escapes the reserved prompt tags in every text it renders
  // (`<chronicle_snapshot>` becomes a different byte sequence), so a needle
  // that holds such a tag is also looked for in its escaped form.
  const has = (needle) => {
    if (needle.length === 0) return false;
    const forms = [needle, escapeReservedPromptTags(needle)];
    return haystacks.some((text) => forms.some((form) => text.includes(form)));
  };
  for (const canary of canaries) {
    if (has(canary.text))
      failures.push(
        fail(
          "canary-in-payload",
          `canary ${canary.id} (${canary.kind}) appears in the payload`,
        ),
      );
  }
  for (const text of forbiddenTexts) {
    if (has(text))
      failures.push(
        fail(
          "forbidden-text",
          `forbidden text ${JSON.stringify(text)} appears in the payload`,
        ),
      );
  }
  for (const id of forbiddenIds) {
    if (has(id))
      failures.push(
        fail("forbidden-id", `forbidden id ${id} appears in the payload`),
      );
  }
  for (const marker of otherMarkers) {
    if (has(marker))
      failures.push(
        fail(
          "other-case-material",
          `another case's marker ${JSON.stringify(marker)} appears in the payload`,
        ),
      );
  }
  for (const id of otherIds) {
    if (has(id))
      failures.push(
        fail(
          "other-case-material",
          `another case's id ${id} appears in the payload`,
        ),
      );
  }
  return failures;
}

// ------------------------------------------------- expected-text resolution

/**
 * Resolves the placeholders of an expected text (`{{<kind>:<logicalId>}}`, see
 * contract.mjs) from the SETUP RECEIPT only: the id map (Revision, proposal and
 * decision ids) and `runtimeValues` (Source ids and revision tokens read from
 * the database state the setup left behind). The payload, the capture and the
 * D-final result are never an input here: an expectation is fixed before the
 * request exists, and a value that the setup receipt does not carry makes the
 * run invalid instead of being read back from the output.
 *
 * Each of `stages` is tried alone and the text must resolve entirely within
 * that stage (a P-10 request resolves with its own stage; a forbidden text of
 * an earlier stage with that stage). Returns `{ texts, unresolved, malformed }`:
 * `texts` holds one resolved text per stage that resolved (de-duplicated),
 * `unresolved` the placeholders no stage could resolve, `malformed` the
 * resolved values that are not a bounded ASCII string.
 */
export function resolveExpectedTemplate(text, setupCase, stages) {
  if (templatePlaceholders(text).length === 0)
    return { texts: [text], unresolved: [], malformed: [] };
  const texts = [];
  let unresolved = [];
  const malformed = [];
  for (const stage of stages) {
    const rowMalformed = [];
    const lookup = (kind, logicalId) => {
      const meta = PLACEHOLDER_KINDS[kind];
      let value;
      if (meta.source === "runtimeValues") {
        value = (setupCase.runtimeValues ?? []).find(
          (row) =>
            row.kind === kind &&
            row.logicalId === logicalId &&
            row.stage === stage,
        )?.value;
      } else {
        const row = setupCase.idMap.find(
          (entry) => entry.logicalId === logicalId,
        );
        value =
          kind === "proposalId"
            ? row?.proposalId
            : kind === "decisionId"
              ? row?.decisionId
              : row?.runtimeId;
      }
      if (
        typeof value === "string" &&
        (value.length > meta.maxLength ||
          !PLACEHOLDER_VALUE_PATTERN.test(value))
      ) {
        rowMalformed.push(`${kind}:${logicalId}`);
        return undefined;
      }
      return value;
    };
    const result = resolveTemplate(text, lookup);
    if (result.unresolved.length === 0) {
      if (!texts.includes(result.text)) texts.push(result.text);
    } else {
      unresolved = result.unresolved;
      malformed.push(...rowMalformed);
    }
  }
  return {
    texts,
    unresolved: texts.length === 0 ? unresolved : [],
    malformed: texts.length === 0 ? malformed : [],
  };
}

/**
 * Checks that every value the setup receipt offers for a placeholder was fixed
 * by a setup event before the request was built: a proposal id by the
 * Revision's prepare event, a decision id by its approve event, and a
 * `runtimeValues` row by a setup event of its stage that follows the stage's
 * last tree / Scope / Codex write and precedes the stage's capture event.
 * Returns `invalid` reasons.
 */
export function checkPlaceholderSources(setupCase) {
  const invalid = [];
  const bad = (code, message) =>
    invalid.push(fail(`setup-invalid:${code}`, message));
  const events = setupCase.events;
  const captureOf = (stage) =>
    events.find((event) => event.kind === "capture" && event.stage === stage);
  const requireBeforeCapture = (code, what, event) => {
    const capture = captureOf(event.stage);
    if (!capture) {
      bad(
        "placeholder-no-capture",
        `${what}: stage ${event.stage} has no capture event to order it against`,
      );
    } else if (event.seq >= capture.seq) {
      bad(
        code,
        `${what} was fixed at seq ${event.seq}, not before the stage's capture (seq ${capture.seq})`,
      );
    }
  };
  for (const row of setupCase.idMap) {
    for (const [field, kinds] of [
      ["proposalId", ["prepare", "prepare-negative"]],
      ["decisionId", ["approve", "approve-negative"]],
    ]) {
      if (row[field] === undefined) continue;
      const event = events.find(
        (candidate) =>
          kinds.includes(candidate.kind) &&
          candidate.runtimeId === row.runtimeId,
      );
      if (!event) {
        bad(
          "placeholder-source-missing",
          `${row.logicalId}.${field} has no ${kinds[0]} event of ${row.runtimeId} that fixed it`,
        );
        continue;
      }
      requireBeforeCapture(
        "placeholder-after-capture",
        `${row.logicalId}.${field}`,
        event,
      );
    }
  }
  const seen = new Set();
  for (const row of setupCase.runtimeValues ?? []) {
    const what = `${row.kind}:${row.logicalId} (stage ${row.stage})`;
    const key = `${row.kind}/${row.logicalId}/${row.stage}`;
    if (seen.has(key)) {
      bad("placeholder-duplicate", `${what} is given more than once`);
    }
    seen.add(key);
    if (
      row.value.length > PLACEHOLDER_KINDS[row.kind].maxLength ||
      !PLACEHOLDER_VALUE_PATTERN.test(row.value)
    ) {
      bad(
        "placeholder-value-malformed",
        `${what} is not a bounded ASCII value`,
      );
    }
    const event = events.find(
      (candidate) => candidate.seq === row.resolvedAtSeq,
    );
    if (!event || event.stage !== row.stage || event.kind === "capture") {
      bad(
        "placeholder-source-missing",
        `${what} names resolvedAtSeq ${row.resolvedAtSeq}, which is not a setup event of that stage before the capture`,
      );
      continue;
    }
    const lastWrite = Math.max(
      0,
      ...events
        .filter(
          (candidate) =>
            candidate.stage === row.stage &&
            (SETUP_BASE_WRITE_KINDS.includes(candidate.kind) ||
              candidate.kind === "invalidate-negative"),
        )
        .map((candidate) => candidate.seq),
    );
    if (event.seq < lastWrite) {
      bad(
        "placeholder-before-writes",
        `${what} was read at seq ${event.seq}, before the stage's last write (seq ${lastWrite}) changed the state it derives from`,
      );
    }
    requireBeforeCapture("placeholder-after-capture", what, event);
  }
  return invalid;
}

// --------------------------------------------------------------- setup rules

/**
 * Checks one setup receipt case. `required` are the logical ids of the
 * Revisions that must be verified eligible; `stages` the stages that have a
 * request. Returns `invalid` reasons (a request whose setup fails these is not
 * scored).
 */
export function checkSetupCase(
  setupCase,
  { stages, requiredByStage, ineligible = null },
) {
  const invalid = [];
  const bad = (code, message) =>
    invalid.push(fail(`setup-invalid:${code}`, message));
  if (setupCase.valid !== true)
    bad(
      "run-marked-invalid",
      `the setup run is marked invalid: ${setupCase.invalidReason}`,
    );
  if (setupCase.directDmlObserved)
    bad("direct-dml", "a direct DML or SQL write was observed during setup");
  for (const writer of [
    ...setupCase.writersUsed,
    ...setupCase.events.map((event) => event.writer),
  ]) {
    if (!PRODUCT_WRITERS.includes(writer))
      bad(
        "non-product-writer",
        `setup used ${writer}, which is not a product writer`,
      );
  }
  const events = setupCase.events;
  if (
    events.some(
      (event, index) => index > 0 && event.seq <= events[index - 1].seq,
    )
  ) {
    bad("event-order", "setup events must have strictly increasing seq");
  }
  const restricted = events.find((event) => event.kind === "restricted");
  const firstCapture = events.find((event) => event.kind === "capture");
  // The stages come from the fixture as well as from the events: a stage the
  // fixture measures but whose events were left out of the receipt is not a
  // stage with nothing to audit.
  const stageNumbers = [
    ...new Set([...events.map((event) => event.stage), ...stages]),
  ].sort((a, b) => a - b);
  const runtimeOf = new Map(
    setupCase.idMap.map((row) => [row.logicalId, row.runtimeId]),
  );
  const preparedBefore = new Set();
  for (const stage of stageNumbers) {
    const inStage = events.filter((event) => event.stage === stage);
    const firstPrepare = inStage.findIndex((event) => event.kind === "prepare");
    if (firstPrepare < 0) {
      bad("no-prepare", `stage ${stage} prepares no Revision`);
      if (stages.includes(stage)) {
        for (const logicalId of requiredByStage.get(stage) ?? []) {
          bad(
            "approve-missing",
            `stage ${stage}: ${logicalId} has no prepare and approve event`,
          );
        }
      }
      continue;
    }
    // Every Revision the stage's request needs was prepared and then approved
    // by a product writer in this stage (a self-reported verification is not
    // an audit).
    for (const logicalId of requiredByStage.get(stage) ?? []) {
      const runtimeId = runtimeOf.get(logicalId);
      if (!runtimeId) {
        bad(
          "idmap-missing",
          `stage ${stage}: ${logicalId} has no runtime id in the setup receipt`,
        );
        continue;
      }
      const prepare = inStage.find(
        (event) => event.kind === "prepare" && event.runtimeId === runtimeId,
      );
      const approve = inStage.find(
        (event) => event.kind === "approve" && event.runtimeId === runtimeId,
      );
      if (!prepare) {
        bad(
          stage > 1 ? "p10-without-new-revision" : "no-prepare",
          `stage ${stage}: ${logicalId} (${runtimeId}) was not prepared in this stage`,
        );
      } else if (!approve) {
        bad(
          stage > 1 ? "p10-new-revision-not-approved" : "approve-missing",
          `stage ${stage}: ${logicalId} (${runtimeId}) was prepared but not approved`,
        );
      } else if (approve.seq < prepare.seq) {
        bad(
          "approve-before-prepare",
          `stage ${stage}: ${logicalId} was approved before it was prepared`,
        );
      }
    }
    if (stage > 1) {
      // P-10: the binding was changed by a product writer before the new
      // Revision was prepared.
      const prepareSeq = inStage[firstPrepare].seq;
      if (
        !inStage.some(
          (event) =>
            SETUP_BASE_WRITE_KINDS.includes(event.kind) &&
            event.seq < prepareSeq,
        )
      ) {
        bad(
          "p10-without-binding-change",
          `stage ${stage}: no binding-changing write came before the new Revision was prepared`,
        );
      }
    }
    for (const event of inStage.slice(firstPrepare)) {
      if (
        SETUP_BASE_WRITE_KINDS.includes(event.kind) ||
        event.kind === "invalidate-negative"
      ) {
        bad(
          "write-after-first-prepare",
          `stage ${stage}: ${event.kind} (seq ${event.seq}) came after the first prepare`,
        );
      }
    }
    for (const event of inStage) {
      if (event.kind === "invalidate-negative") {
        const approvedFirst = inStage.some(
          (other) => other.kind === "approve-negative" && other.seq < event.seq,
        );
        if (!approvedFirst)
          bad(
            "invalidate-before-approve",
            `stage ${stage}: a negative was invalidated before it was prepared and approved`,
          );
      }
    }
    const preparedHere = new Set();
    for (const event of inStage) {
      if (event.kind === "prepare") {
        if (!event.runtimeId)
          bad(
            "prepare-without-id",
            `stage ${stage}: a prepare event has no runtime id`,
          );
        else if (preparedBefore.has(event.runtimeId)) {
          bad(
            "p10-reprepared-old-revision",
            `stage ${stage}: ${event.runtimeId} was already prepared in an earlier stage`,
          );
        } else preparedHere.add(event.runtimeId);
      }
      if (event.kind === "approve") {
        if (!event.runtimeId)
          bad(
            "approve-without-id",
            `stage ${stage}: an approve event has no runtime id`,
          );
        else if (preparedBefore.has(event.runtimeId)) {
          bad(
            "p10-reapproval-of-old-revision",
            `stage ${stage}: an old Revision (${event.runtimeId}) was approved again instead of preparing a new one`,
          );
        } else if (!preparedHere.has(event.runtimeId)) {
          bad(
            "approve-without-prepare",
            `stage ${stage}: ${event.runtimeId} was approved without being prepared in this stage`,
          );
        }
      }
    }
    if (stage > 1 && preparedHere.size === 0) {
      bad(
        "p10-without-new-revision",
        `stage ${stage} did not prepare a new typed Revision`,
      );
    }
    if (stage > 1) {
      const approvedHere = new Set(
        inStage
          .filter((event) => event.kind === "approve")
          .map((event) => event.runtimeId),
      );
      for (const id of preparedHere) {
        if (!approvedHere.has(id))
          bad(
            "p10-new-revision-not-approved",
            `stage ${stage}: new Revision ${id} was not approved`,
          );
      }
    }
    for (const id of preparedHere) preparedBefore.add(id);
  }
  // A reject variant whose negative is its own Revision (not one an earlier
  // stage already used) was created, approved and then invalidated by product
  // writes, in this order, each once. A negative that is an old Revision of
  // an earlier stage (P-10) went stale by the binding change instead.
  if (ineligible) {
    const usedElsewhere = [...requiredByStage.values()].some((ids) =>
      ids.includes(ineligible.logicalId),
    );
    if (!usedElsewhere) {
      const runtimeId = runtimeOf.get(ineligible.logicalId);
      const found = {};
      for (const kind of [
        "prepare-negative",
        "approve-negative",
        "invalidate-negative",
      ]) {
        const rows = events.filter(
          (event) =>
            event.kind === kind && event.logicalId === ineligible.logicalId,
        );
        if (rows.length === 0) {
          bad(
            "negative-event-missing",
            `the negative ${ineligible.logicalId} has no ${kind} event`,
          );
          continue;
        }
        if (rows.length > 1) {
          bad(
            "negative-event-duplicate",
            `the negative ${ineligible.logicalId} has ${rows.length} ${kind} events`,
          );
        }
        for (const row of rows) {
          if (runtimeId === undefined || row.runtimeId !== runtimeId) {
            bad(
              "negative-runtime-id-mismatch",
              `${kind} names runtime id ${row.runtimeId}, the id map has ${runtimeId} for ${ineligible.logicalId}`,
            );
          }
        }
        found[kind] = rows[0];
      }
      if (
        found["prepare-negative"] &&
        found["approve-negative"] &&
        found["invalidate-negative"] &&
        !(
          found["prepare-negative"].seq < found["approve-negative"].seq &&
          found["approve-negative"].seq < found["invalidate-negative"].seq
        )
      ) {
        bad(
          "negative-order",
          `the negative ${ineligible.logicalId} must be prepared, approved, then invalidated`,
        );
      }
    }
  }
  // D2a: restricted after the setup writes and before capture; the chat
  // sessions are created before it.
  if (!restricted) {
    bad("restricted-missing", "no restricted event");
  } else {
    const firstStage = events.filter(
      (event) => event.stage === stageNumbers[0],
    );
    const lastWrite = Math.max(
      ...firstStage
        .filter((event) => !["restricted", "capture"].includes(event.kind))
        .map((event) => event.seq),
    );
    if (restricted.seq < lastWrite)
      bad(
        "restricted-before-writes",
        "restricted was established before the setup writes ended",
      );
    if (firstCapture && restricted.seq > firstCapture.seq)
      bad(
        "restricted-after-capture",
        "restricted was established after the first capture",
      );
    if (!firstCapture) bad("capture-missing", "no capture event");
    for (const stage of stages) {
      if (
        !events.some(
          (event) => event.kind === "chat-session" && event.stage === stage,
        )
      ) {
        bad(
          "chat-session-missing",
          `stage ${stage}: no chat-session event (created before restricted)`,
        );
      }
    }
    for (const event of events.filter((e) => e.kind === "chat-session")) {
      if (event.seq > restricted.seq)
        bad(
          "chat-session-after-restricted",
          `chat session (seq ${event.seq}) was created after restricted`,
        );
    }
  }
  if (
    setupCase.chatSession.writer !== "db_execute:createSession" ||
    setupCase.chatSession.statementMatchesRenderer !== true ||
    setupCase.chatSession.createdBeforeRestricted !== true
  ) {
    bad(
      "chat-session",
      "the chat session was not created by the renderer's createSession statement before restricted",
    );
  }
  if (
    setupCase.history.inputCount !== 0 ||
    setupCase.history.reason !== "not-applicable"
  ) {
    bad("history-slot", "the history slot must be zero inputs, not applicable");
  }
  // A (stage, point) is verified by exactly one row: a second row could carry
  // a different, eligible-looking set while the real one is hidden.
  const rowCounts = new Map();
  for (const row of setupCase.verifications) {
    const key = `${row.stage}/${row.point}`;
    rowCounts.set(key, (rowCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of rowCounts) {
    if (count > 1)
      bad(
        "verification-duplicate",
        `stage/point ${key} has ${count} verification rows (exactly one is allowed)`,
      );
  }
  const logicalCounts = new Map();
  for (const row of setupCase.idMap)
    logicalCounts.set(
      row.logicalId,
      (logicalCounts.get(row.logicalId) ?? 0) + 1,
    );
  for (const [logicalId, count] of logicalCounts) {
    if (count > 1)
      bad("idmap-duplicate", `the id map names ${logicalId} ${count} times`);
  }
  const eligibleFresh = (revision) =>
    revision.a2 === "eligible" &&
    revision.a3 === "eligible" &&
    revision.freshness === "fresh";
  for (const stage of stages) {
    const forStage = setupCase.verifications.filter(
      (row) => row.stage === stage,
    );
    const end = forStage.find((row) => row.point === "setup-end");
    const pre = forStage.find((row) => row.point === "request-pre");
    if (!end || !pre) {
      bad(
        "verification-missing",
        `stage ${stage} lacks the setup-end or request-pre verification`,
      );
      continue;
    }
    if (end.scopeAuthorityRevision !== pre.scopeAuthorityRevision) {
      bad(
        "scope-authority-changed",
        `stage ${stage}: the Scope authority revision changed between setup end and the request`,
      );
    }
    if (!pre.d2a.restricted || !pre.d2a.inFlightStopped) {
      bad(
        "d2a-not-restricted",
        `stage ${stage}: the profile was not restricted with in-flight stopped at the request`,
      );
    }
    // Both points verify every Revision the request is expected to use, by
    // the runtime id the setup actually prepared (the id map), once each.
    for (const row of [end, pre]) {
      const seenRuntime = new Set();
      for (const revision of row.revisions) {
        if (seenRuntime.has(revision.runtimeId))
          bad(
            "verification-duplicate-revision",
            `stage ${stage} ${row.point}: runtime id ${revision.runtimeId} is verified more than once`,
          );
        seenRuntime.add(revision.runtimeId);
      }
      for (const logicalId of requiredByStage.get(stage) ?? []) {
        const entries = row.revisions.filter(
          (revision) => revision.logicalId === logicalId,
        );
        if (entries.length === 0) {
          bad(
            "revision-unverified",
            `stage ${stage}: ${logicalId} was not verified eligible at ${row.point}`,
          );
          continue;
        }
        if (entries.length > 1) {
          bad(
            "verification-duplicate-revision",
            `stage ${stage} ${row.point}: ${logicalId} is verified ${entries.length} times`,
          );
        }
        const runtimeId = runtimeOf.get(logicalId);
        for (const revision of entries) {
          if (runtimeId !== undefined && revision.runtimeId !== runtimeId) {
            bad(
              "verification-runtime-id-mismatch",
              `stage ${stage} ${row.point}: ${logicalId} was verified as ${revision.runtimeId}, the setup prepared ${runtimeId}`,
            );
          }
          if (!eligibleFresh(revision)) {
            bad(
              "revision-not-eligible",
              `stage ${stage}: ${logicalId} is not A2/A3 eligible and fresh at ${row.point}`,
            );
          }
        }
      }
    }
    // A reject variant's negative is recorded as not eligible just before the
    // request that carries it.
    if (ineligible && stage === ineligible.stage) {
      const entries = pre.revisions.filter(
        (revision) => revision.logicalId === ineligible.logicalId,
      );
      const runtimeId = runtimeOf.get(ineligible.logicalId);
      if (entries.length === 0) {
        bad(
          "negative-unverified",
          `stage ${stage}: the negative ${ineligible.logicalId} was not verified as ineligible at request-pre`,
        );
      }
      for (const revision of entries) {
        if (runtimeId !== undefined && revision.runtimeId !== runtimeId) {
          bad(
            "verification-runtime-id-mismatch",
            `stage ${stage} request-pre: the negative ${ineligible.logicalId} was verified as ${revision.runtimeId}, the setup prepared ${runtimeId}`,
          );
        }
        if (eligibleFresh(revision)) {
          bad(
            "negative-eligible",
            `stage ${stage}: the negative ${ineligible.logicalId} is still A2/A3 eligible and fresh at request-pre`,
          );
        }
      }
    }
  }
  invalid.push(...checkPlaceholderSources(setupCase));
  return invalid;
}

// -------------------------------------------------------- positive requests

/**
 * A run gets its own workspace (GDX-ISOLATION-001): the setup receipt's
 * namespace is the fixture case's `isolation.workspaceId`, optionally with a
 * `/<suffix>`, and no two setup cases share one.
 */
export function workspaceNamespaceInvalid(setupCase, isolation, counts) {
  const invalid = [];
  const namespace = setupCase.workspaceNamespace;
  if ((counts.get(namespace) ?? 0) > 1) {
    invalid.push(
      fail(
        "setup-invalid:workspace-namespace-shared",
        `workspace namespace ${namespace} is used by more than one setup case`,
      ),
    );
  }
  const workspaceId = isolation?.workspaceId;
  if (
    typeof workspaceId === "string" &&
    namespace !== workspaceId &&
    !namespace.startsWith(`${workspaceId}/`)
  ) {
    invalid.push(
      fail(
        "setup-invalid:workspace-namespace-mismatch",
        `workspace namespace ${namespace} is not the fixture's isolation workspace ${workspaceId}`,
      ),
    );
  }
  return invalid;
}

function idMapOf(setupCase) {
  return new Map(setupCase.idMap.map((row) => [row.logicalId, row.runtimeId]));
}

function multisetDifference(left, right) {
  const counts = new Map();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);
  const rest = [];
  for (const value of left) {
    const count = counts.get(value) ?? 0;
    if (count > 0) counts.set(value, count - 1);
    else rest.push(value);
  }
  return rest;
}

function windowFailure(parsed, route, label) {
  const failures = [];
  if (parsed.model !== route.model) {
    failures.push(
      fail(
        "route-mismatch",
        `${label}: the payload model differs from the route`,
      ),
    );
  }
  if (parsed.maxTokens !== route.outputTokens) {
    failures.push(
      fail(
        "route-mismatch",
        `${label}: the payload max_tokens differs from the route output limit`,
      ),
    );
  }
  const total = reservedTotalTokens({
    system: parsed.system,
    user: parsed.user,
    outputTokens: parsed.maxTokens,
  });
  if (total > route.contextWindowTokens) {
    failures.push(
      fail(
        "window-exceeded",
        `${label}: the rendered request reserves ${total} tokens, over the ${route.contextWindowTokens} window`,
      ),
    );
  }
  return failures;
}

/** Budget terms every arm shares: the formula and the per-item estimates. */
function budgetFormulaFailures({
  capture,
  template,
  fixtureRoute,
  expectedBudget,
}) {
  const failures = [];
  const derived = contextBudgetTokens({
    template,
    userMessage: capture.userMessage.text,
    contextWindowTokens: fixtureRoute.contextWindowTokens,
    outputTokens: fixtureRoute.outputTokens,
  });
  if (capture.contextBudgetTokens !== derived) {
    failures.push(
      fail(
        "context-budget-mismatch",
        `the captured context budget ${capture.contextBudgetTokens} differs from the formula (${derived})`,
      ),
    );
  }
  if (
    expectedBudget !== undefined &&
    capture.contextBudgetTokens !== expectedBudget
  ) {
    failures.push(
      fail(
        "context-budget-mismatch",
        `the captured context budget differs from the frozen one (${expectedBudget})`,
      ),
    );
  }
  for (const item of capture.candidateSet.items) {
    if (item.tokens !== estimateTokens(item.text)) {
      failures.push(
        fail(
          "item-token-estimate-mismatch",
          `item ${item.itemId} has ${item.tokens} tokens, the estimator gives ${estimateTokens(item.text)}`,
        ),
      );
    }
  }
  return failures;
}

/** The selected items (Raw plus the matched entries) must fit the context budget. */
function selectionFailures({ capture, matched, label }) {
  const total = capture.candidateSet.items
    .filter((item, index) => item.kind === "raw" || matched.includes(index))
    .reduce((sum, item) => sum + item.tokens, 0);
  return total > capture.contextBudgetTokens
    ? [
        fail(
          "selection-exceeds-budget",
          `${label}: the selected items measure ${total} tokens, over the ${capture.contextBudgetTokens} context budget`,
        ),
      ]
    : [];
}

/** Scores one positive request. Returns `{ failures, invalid }`. */
export function scorePositiveRequest({
  request,
  expected,
  testCase,
  fixture,
  setupCase,
  template,
  otherMarkers,
  otherIds,
}) {
  const failures = [];
  const invalid = [];
  const qualifying = qualifyingFailures(request);
  if (qualifying.length > 0)
    return { failures: qualifying, invalid, scored: false };

  // The expected texts are templates: resolve them from the setup receipt
  // before anything is compared (never from the payload or the capture).
  const stage = request.stage;
  const entryTexts = expected.codexEntries.map((entry) =>
    resolveExpectedTemplate(entry.text, setupCase, [stage]),
  );
  const earlierStages =
    stage > 1
      ? Array.from({ length: stage - 1 }, (_, index) => index + 1)
      : [1];
  const forbiddenTexts = expected.forbidden.texts.map((text) =>
    resolveExpectedTemplate(text, setupCase, earlierStages),
  );
  const unresolvedPlaceholders = [...entryTexts, ...forbiddenTexts].flatMap(
    (row) => row.unresolved,
  );
  const malformedPlaceholders = [...entryTexts, ...forbiddenTexts].flatMap(
    (row) => row.malformed,
  );
  if (unresolvedPlaceholders.length > 0 || malformedPlaceholders.length > 0) {
    return {
      failures,
      invalid: [
        fail(
          "setup-invalid:placeholder-unresolved",
          `the setup receipt does not fix ${[
            ...new Set([...unresolvedPlaceholders, ...malformedPlaceholders]),
          ].join(", ")}; an expectation is never resolved from the payload`,
        ),
      ],
      scored: false,
    };
  }
  const capture = request.capture;
  const view = armView(request, "candidate");
  if (
    request.history.inputCount !== 0 ||
    request.history.reason !== "not-applicable"
  ) {
    failures.push(
      fail(
        "history-input-present",
        "the history slot must be zero inputs, not applicable, in a DP-H request",
      ),
    );
  }
  if (request.baseline !== null) {
    failures.push(
      fail(
        "baseline-not-allowed",
        "P-01 to P-11 are scored on the candidate arm only",
      ),
    );
  }
  if (request.attemptRowsAdded !== 0) {
    failures.push(
      fail(
        "positive-attempt-present",
        `a no-send evaluation request created ${request.attemptRowsAdded} attempt row(s); D-final must not enter the attempt path`,
      ),
    );
  }
  invalid.push(...checkCapture(capture, view));
  for (const item of capture.candidateSet.items) {
    if (
      item.kind === "accepted-ir" &&
      !capture.passedRevisionIds.includes(item.ownerId)
    ) {
      failures.push(
        fail(
          "candidate-owner-not-passed",
          `candidate item ${item.itemId} belongs to ${item.ownerId}, which was not among the passed Revisions`,
        ),
      );
    }
    if (item.kind !== "raw" && item.kind !== "accepted-ir") {
      failures.push(
        fail(
          "candidate-kind-not-allowed",
          `candidate item ${item.itemId} is ${item.kind}; DP-H material is Raw and accepted IR only`,
        ),
      );
    }
  }

  const read = readPayload(view, capture, template);
  failures.push(...read.failures);
  if (!read.parsed || !read.cut) return { failures, invalid, scored: true };
  const { parsed, cut, codex } = read;

  const idMap = idMapOf(setupCase);
  // Same input: the captured figures against the frozen fixture and the receipt.
  const frozenInputs = {
    estimatorVersion: fixture.estimatorVersion,
    template: {
      version: fixture.fixedTemplate.version,
      ref: fixture.fixedTemplate.ref,
    },
    userMessageDigestSha256: userDigest(testCase.userMessage),
    contextBudgetTokens: expected.contextBudgetTokens,
    measure: MEASURE,
    passedRevisionIds: expected.passedRuntimeIds,
  };
  const captured = inputsOfCapture(capture);
  failures.push(
    ...checkSameInput(captured, frozenInputs, { label: "capture vs fixture" }),
  );
  for (const key of ["model", "contextWindowTokens", "outputTokens"]) {
    if (capture.route[key] !== fixture.route[key]) {
      failures.push(
        fail(
          "same-input-check-rejects-route",
          `capture route ${key} differs from the fixture route`,
        ),
      );
    }
  }
  if (!sameJson(request.passedRevisionIds, capture.passedRevisionIds)) {
    failures.push(
      fail(
        "same-input-check-rejects-passedRevisionIds",
        "the receipt's passed Revision ids differ from the captured ones",
      ),
    );
  }
  if (capture.userMessage.text !== testCase.userMessage) {
    failures.push(
      fail(
        "same-input-check-rejects-userMessage",
        "the captured user message differs from the fixture's",
      ),
    );
  }
  if (
    userDigest(capture.userMessage.text) !== capture.userMessage.digestSha256
  ) {
    failures.push(
      fail(
        "same-input-check-rejects-userMessageDigestSha256",
        "the captured user message digest does not match its text",
      ),
    );
  }
  if (parsed.user !== capture.userMessage.text) {
    failures.push(
      fail(
        "same-input-check-rejects-userMessage",
        "the payload user message differs from the captured user message",
      ),
    );
  }
  if (capture.estimatorVersion !== ESTIMATOR_VERSION) {
    failures.push(
      fail(
        "same-input-check-rejects-estimatorVersion",
        "the capture's estimator version is not nir1-context-estimator-v1",
      ),
    );
  }

  // Raw retention.
  const rawItem = capture.candidateSet.items.find(
    (item) => item.kind === "raw",
  );
  const expectedRaw = escapeReservedPromptTags(expected.rawText);
  if (cut.raw !== expectedRaw) {
    failures.push(
      fail(
        "raw-mismatch",
        "the current-scene block is not the frozen Raw text",
      ),
    );
  }
  if (rawItem && escapeReservedPromptTags(rawItem.text) !== cut.raw) {
    failures.push(
      fail(
        "raw-mismatch",
        "the current-scene block differs from the captured Raw item",
      ),
    );
  }
  const rawRows = read.scene;
  const rawReference = rawRows[0]
    ? view.inputReferences[rawRows[0].inputOrdinal]
    : undefined;
  if (rawRows.length === 1 && rawReference?.target.kind !== "raw-source") {
    failures.push(
      fail(
        "raw-mismatch",
        "the current-scene block does not correspond to the Raw source input",
      ),
    );
  }

  // Retention, prose order and exact quotes of the IR entries.
  const expectedEntries = entryTexts.map((row) => row.texts[0]);
  if (!sameJson(cut.entries, expectedEntries)) {
    const missing = multisetDifference(expectedEntries, cut.entries);
    const extra = multisetDifference(cut.entries, expectedEntries);
    for (const text of missing) {
      const entry = expected.codexEntries[expectedEntries.indexOf(text)];
      failures.push(
        fail(
          "required-entry-missing",
          `required entry ${entry.logicalId} (${entry.part}) is missing from the payload`,
        ),
      );
    }
    for (const _text of extra) {
      failures.push(
        fail(
          "unexpected-entry",
          "the payload holds a codex entry that the frozen expectation does not list",
        ),
      );
    }
    if (missing.length === 0 && extra.length === 0) {
      failures.push(
        fail(
          "prose-order-changed",
          "the codex entries are present but not in the frozen order",
        ),
      );
    }
  }
  for (const quote of expected.exactQuotes) {
    const position = expected.codexEntries.findIndex(
      (entry) => entry.logicalId === quote.logicalId,
    );
    if (!(cut.entries[position] ?? "").includes(quote.quote)) {
      failures.push(
        fail(
          "exact-quote-missing",
          `the exact quote for ${quote.logicalId} is not in its payload entry`,
        ),
      );
    }
  }

  const alignment = alignEntries({ cut, codex, view, capture });
  failures.push(...alignment.failures);
  failures.push(
    ...budgetFormulaFailures({
      capture,
      template,
      fixtureRoute: fixture.route,
      expectedBudget: expected.contextBudgetTokens,
    }),
    ...selectionFailures({
      capture,
      matched: alignment.matched,
      label: "candidate",
    }),
  );
  failures.push(...windowFailure(parsed, fixture.route, "candidate"));

  const forbiddenIds = expected.forbidden.logicalIds
    .flatMap((logicalId) => {
      const row = setupCase.idMap.find(
        (entry) => entry.logicalId === logicalId,
      );
      return [
        logicalId,
        idMap.get(logicalId),
        row?.proposalId,
        row?.decisionId,
      ];
    })
    .filter((id) => typeof id === "string" && id.length > 0);
  failures.push(
    ...scanForbidden({
      payload: request.candidate.payload,
      system: parsed.system,
      user: parsed.user,
      canaries: fixture.canaries,
      forbiddenTexts: forbiddenTexts.flatMap((row) => row.texts),
      forbiddenIds,
      otherMarkers,
      otherIds,
    }),
  );
  return { failures, invalid, scored: true };
}

/** Scores one reject request: only the typed refusal and the absence of output. */
export function scoreRejectRequest({ request, expected }) {
  const failures = [];
  if (request.dfinal.outcome !== "err") {
    failures.push(
      fail("reject-unexpected-ok", "a reject variant returned Ok from D-final"),
    );
  } else {
    if (request.dfinal.code !== expected.code) {
      failures.push(
        fail(
          "reject-code-mismatch",
          `expected ${expected.code}, D-final returned ${request.dfinal.code}`,
        ),
      );
    }
    if (request.dfinal.reason !== expected.reason) {
      failures.push(
        fail(
          "reject-reason-mismatch",
          `expected reason ${JSON.stringify(expected.reason)}, D-final returned ${JSON.stringify(request.dfinal.reason ?? null)}`,
        ),
      );
    }
  }
  if (request.candidate !== null)
    failures.push(
      fail("reject-payload-present", "a reject variant produced a payload"),
    );
  if (request.capture !== null)
    failures.push(
      fail(
        "reject-capture-present",
        "a reject variant produced a capture or render correspondence",
      ),
    );
  if (request.baseline !== null)
    failures.push(
      fail(
        "reject-baseline-present",
        "a reject variant called the baseline arm",
      ),
    );
  if (request.attemptRowsAdded !== 0)
    failures.push(
      fail("reject-attempt-present", "a reject variant created an attempt"),
    );
  return { failures, invalid: [], scored: true };
}

// --------------------------------------------------------------------- P-12

/**
 * Scores a candidate/baseline pair for P-12 (also used for the harness
 * diagnostic case, which is never P evidence). `expectation` is
 * `{ slot, baselineTarget, candidateTarget, improvementGroups: [{ ownerId,
 * kind }], contextBudgetTokens? }`.
 */
export function scoreP12Pair({ request, expectation, template, fixtureRoute }) {
  const failures = [];
  const invalid = [];
  if (
    expectation.slot !== "qualifiedEvidence" ||
    expectation.baselineTarget !== 0 ||
    expectation.candidateTarget !== 1
  ) {
    failures.push(
      fail(
        "p12-expectation-changed",
        "P-12's slot and 0-to-1 target are fixed",
      ),
    );
  }
  const qualifying = qualifyingFailures(request);
  if (qualifying.length > 0) {
    if (request.baseline !== null) {
      qualifying.push(
        fail(
          "baseline-called-for-unqualified-request",
          "the baseline arm was called for a request that does not qualify",
        ),
      );
    }
    return {
      status: "failed",
      failures: [...failures, ...qualifying],
      invalid,
      candidateSlot: null,
      baselineSlot: null,
    };
  }
  if (request.baseline === null) {
    return {
      status: "failed",
      failures: [
        ...failures,
        fail("p12-baseline-missing", "P-12 needs the baseline arm"),
      ],
      invalid,
      candidateSlot: null,
      baselineSlot: null,
    };
  }
  const capture = request.capture;
  if (request.baseline.persistedRows !== 0) {
    failures.push(
      fail(
        "baseline-persisted",
        "the baseline arm must not add any persisted row",
      ),
    );
  }
  if (request.attemptRowsAdded !== 0) {
    failures.push(
      fail(
        "positive-attempt-present",
        `a no-send evaluation request created ${request.attemptRowsAdded} attempt row(s); D-final must not enter the attempt path`,
      ),
    );
  }
  if (
    request.history.inputCount !== 0 ||
    request.history.reason !== "not-applicable"
  ) {
    failures.push(
      fail(
        "history-input-present",
        "a P-12 request has no history input (history slot not applicable)",
      ),
    );
  }
  if (request.baseline.outcome !== "rendered") {
    return {
      status: "failed",
      failures: [
        ...failures,
        fail(
          "p12-baseline-unrenderable",
          `the baseline arm did not render (${request.baseline.outcome}); P-12 cannot pass`,
        ),
      ],
      invalid,
      candidateSlot: null,
      baselineSlot: null,
    };
  }
  const baselineDigestRecomputed = (() => {
    try {
      const parsed = JSON.parse(request.baseline.payload);
      return (
        canonicalJson(parsed) === request.baseline.payload &&
        payloadDigest(parsed) === request.baseline.payloadDigest
      );
    } catch {
      return false;
    }
  })();
  if (!baselineDigestRecomputed) {
    failures.push(
      fail(
        "payload-digest-recompute",
        "the baseline payload digest does not match its payload bytes",
      ),
    );
  }
  failures.push(
    ...checkSameInput(request.baseline.inputs, inputsOfCapture(capture), {
      label: "baseline vs candidate",
    }),
  );
  const candidateView = armView(request, "candidate");
  const baselineView = armView(request, "baseline");
  invalid.push(...checkCapture(capture, candidateView));
  for (const violation of completenessViolations(baselineView)) {
    invalid.push(
      fail("capture-incomplete:completeness", `baseline: ${violation}`),
    );
  }
  invalid.push(...baselineRefViolations(baselineView, capture));
  const candidateRead = readPayload(candidateView, capture, template);
  const baselineRead = readPayload(baselineView, capture, template);
  failures.push(
    ...candidateRead.failures,
    ...baselineRead.failures.map((f) => ({
      ...f,
      message: `baseline: ${f.message}`,
    })),
  );
  if (!candidateRead.parsed || !baselineRead.parsed) {
    return {
      status: "failed",
      failures,
      invalid,
      candidateSlot: null,
      baselineSlot: null,
    };
  }
  if (
    candidateRead.parsed.user !== capture.userMessage.text ||
    baselineRead.parsed.user !== capture.userMessage.text
  ) {
    failures.push(
      fail(
        "same-input-check-rejects-userMessage",
        "an arm's payload user message differs from the captured user message",
      ),
    );
  }
  if (
    request.candidate.payload === request.baseline.payload ||
    request.candidate.payloadDigest === request.baseline.payloadDigest
  ) {
    failures.push(
      fail(
        "p12-identical-payload",
        "the two arms rendered the same payload; P-12 cannot pass",
      ),
    );
  }
  const candidateAlign = alignEntries({
    ...candidateRead,
    view: candidateView,
    capture,
  });
  const baselineAlign = alignEntries({
    ...baselineRead,
    view: baselineView,
    capture,
  });
  failures.push(...candidateAlign.failures);
  // The baseline removes item by item, so a partial group is allowed there;
  // an entry that is in no candidate item is not.
  failures.push(
    ...baselineAlign.failures
      .filter((f) => f.code !== "atomic-group-partial")
      .map((f) => ({ ...f, message: `baseline: ${f.message}` })),
  );
  failures.push(
    ...windowFailure(candidateRead.parsed, fixtureRoute, "candidate"),
  );
  failures.push(
    ...windowFailure(baselineRead.parsed, fixtureRoute, "baseline"),
  );
  failures.push(
    ...budgetFormulaFailures({
      capture,
      template,
      fixtureRoute,
      expectedBudget: expectation.contextBudgetTokens,
    }),
    ...selectionFailures({
      capture,
      matched: candidateAlign.matched,
      label: "candidate",
    }),
    ...selectionFailures({
      capture,
      matched: baselineAlign.matched,
      label: "baseline",
    }),
  );
  const candidateSlots = deriveSlots({
    improvementGroups: expectation.improvementGroups,
    ...candidateRead,
    view: candidateView,
    capture,
    matched: candidateAlign.matched,
  });
  const baselineSlots = deriveSlots({
    improvementGroups: expectation.improvementGroups,
    ...baselineRead,
    view: baselineView,
    capture,
    matched: baselineAlign.matched,
  });
  for (const [name, arm, derived] of [
    ["candidate", request.candidate, candidateSlots],
    ["baseline", request.baseline, baselineSlots],
  ]) {
    if (
      arm.counters &&
      arm.counters.qualifiedEvidence !== derived.qualifiedEvidence
    ) {
      failures.push(
        fail(
          "slot-counter-mismatch",
          `${name}: the harness counter ${arm.counters.qualifiedEvidence} differs from the payload-derived slot ${derived.qualifiedEvidence}`,
        ),
      );
    }
  }
  if (baselineSlots.qualifiedEvidence !== expectation.baselineTarget) {
    failures.push(
      fail(
        "p12-slot-mismatch",
        `the baseline slot is ${baselineSlots.qualifiedEvidence}, expected ${expectation.baselineTarget}`,
      ),
    );
  }
  if (candidateSlots.qualifiedEvidence !== expectation.candidateTarget) {
    failures.push(
      fail(
        "p12-slot-mismatch",
        `the candidate slot is ${candidateSlots.qualifiedEvidence}, expected ${expectation.candidateTarget}`,
      ),
    );
  }
  if (candidateSlots.qualifiedEvidence <= baselineSlots.qualifiedEvidence) {
    failures.push(
      fail(
        "p12-not-improved",
        "the candidate slot does not exceed the baseline slot",
      ),
    );
  }
  return {
    status:
      invalid.length > 0 && failures.length === 0
        ? "invalid"
        : failures.length === 0
          ? "passed"
          : "failed",
    failures,
    invalid,
    candidateSlot: candidateSlots.qualifiedEvidence,
    baselineSlot: baselineSlots.qualifiedEvidence,
    candidateGroups: candidateSlots.groups,
    baselineGroups: baselineSlots.groups,
  };
}

// ------------------------------------------------------------------- suite

function sorted(values) {
  return [...values].sort();
}

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The caller must say which candidate is under test. Every field is required:
 * an omitted field is a failure, never a signal to skip the comparison
 * (a stale-receipt defence that a missing argument can turn off is no defence).
 */
export function expectedInputsErrors(expectedInputs) {
  if (!isRecord(expectedInputs)) return ["expectedInputs must be an object"];
  const errors = [];
  for (const name of ["head", "tree", "freezeCommit"]) {
    if (
      typeof expectedInputs[name] !== "string" ||
      !SHA1_HEX.test(expectedInputs[name])
    ) {
      errors.push(`expectedInputs.${name} must be a 40-hex git object id`);
    }
  }
  for (const name of ["fixtureSha256", "freezeSha256", "scorerSha256"]) {
    if (
      typeof expectedInputs[name] !== "string" ||
      !SHA256_HEX.test(expectedInputs[name])
    ) {
      errors.push(`expectedInputs.${name} must be a 64-hex sha256`);
    }
  }
  if (
    !Array.isArray(expectedInputs.featureSet) ||
    !expectedInputs.featureSet.every((entry) => typeof entry === "string")
  ) {
    errors.push("expectedInputs.featureSet must be an array of strings");
  }
  return errors;
}

/** Receipt inputs against what the caller expects for the candidate under test. */
export function staleReceiptFailures(
  receipt,
  expectedInputs,
  { fixture, template },
) {
  const incomplete = expectedInputsErrors(expectedInputs);
  if (incomplete.length > 0) {
    return incomplete.map((message) =>
      fail("stale-receipt-rejected", `expected-inputs-incomplete: ${message}`),
    );
  }
  const failures = [];
  const check = (name, actual, expected) => {
    if (!sameJson(actual, expected)) {
      failures.push(
        fail(
          "stale-receipt-rejected",
          `receipt ${name} differs from the candidate under test`,
        ),
      );
    }
  };
  check("run.commit", receipt.run.commit, expectedInputs.head);
  check("run.tree", receipt.run.tree, expectedInputs.tree);
  check(
    "inputs.fixtureSha256",
    receipt.inputs.fixtureSha256,
    expectedInputs.fixtureSha256,
  );
  check(
    "freeze.recordSha256",
    receipt.freeze.recordSha256,
    expectedInputs.freezeSha256,
  );
  check(
    "inputs.scorerSha256",
    receipt.inputs.scorerSha256,
    expectedInputs.scorerSha256,
  );
  check(
    "producer.featureSet",
    sorted(receipt.producer.featureSet),
    sorted(expectedInputs.featureSet),
  );
  check("freeze.commit", receipt.freeze.commit, expectedInputs.freezeCommit);
  if (
    receipt.inputs.estimatorVersion !== fixture.estimatorVersion ||
    fixture.estimatorVersion !== ESTIMATOR_VERSION
  ) {
    failures.push(
      fail(
        "stale-receipt-rejected",
        "receipt estimator version differs from the frozen estimator",
      ),
    );
  }
  const fixed = receipt.inputs.fixedTemplate;
  if (
    fixed.version !== fixture.fixedTemplate.version ||
    fixed.ref !== fixture.fixedTemplate.ref ||
    fixed.sha256 !== template.sha256 ||
    fixed.version !== template.version ||
    fixed.ref !== template.ref
  ) {
    failures.push(
      fail(
        "stale-receipt-rejected",
        "receipt fixed template differs from the template files under test",
      ),
    );
  }
  if (receipt.inputs.fixtureVersion !== fixture.fixtureVersion) {
    failures.push(
      fail(
        "stale-receipt-rejected",
        "receipt fixture version differs from the fixture",
      ),
    );
  }
  return failures;
}

function summarize(results) {
  const count = (predicate) => results.filter(predicate).length;
  return {
    requests: results.length,
    positive: {
      total: count((r) => r.requestKind === "positive"),
      passed: count(
        (r) => r.requestKind === "positive" && r.status === "passed",
      ),
    },
    reject: {
      total: count((r) => r.requestKind === "reject"),
      passed: count((r) => r.requestKind === "reject" && r.status === "passed"),
    },
    failed: count((r) => r.status === "failed"),
    invalid: count((r) => r.status === "invalid"),
  };
}

/**
 * Scores a receipt against the fixture. `expectedInputs` identifies the
 * candidate under test (`head`, `tree`, `fixtureSha256`, `freezeSha256`,
 * `scorerSha256`, `featureSet`, `freezeCommit`; all required, a missing or
 * malformed field rejects the run); a receipt for anything else is rejected. `template` is `loadFixedTemplate`'s result.
 */
export function scoreFinalRequestReceipt({
  fixture,
  receipt,
  setupReceipt,
  template,
  expectedInputs,
}) {
  const base = {
    scorerVersion: SCORER_VERSION,
    evidence: {
      scope: "dp-h",
      dp1Evidence: false,
      p12: "not-measured",
      rejectVariantsCountTowardDp1: false,
    },
  };
  const schemaErrors = [
    ...validateReceipt(receipt).map((message) =>
      fail("receipt-schema", message),
    ),
    ...validateSetupReceipt(setupReceipt).map((message) =>
      fail("setup-receipt-schema", message),
    ),
  ];
  if (schemaErrors.length > 0) {
    return {
      ...base,
      status: "rejected",
      failures: schemaErrors,
      requests: [],
      summary: summarize([]),
    };
  }
  // The fixture is scored only if it is itself well-formed: a case without a
  // reject variant, an unbound expectation or a P-10 that skips a binding
  // cannot be made good by a matching receipt.
  const fixtureErrors = validateFinalRequestFixture(fixture, { template });
  if (fixtureErrors.length > 0) {
    return {
      ...base,
      status: "rejected",
      failures: fixtureErrors.map((message) =>
        fail("fixture-invalid", message),
      ),
      requests: [],
      summary: summarize([]),
    };
  }
  const stale = staleReceiptFailures(receipt, expectedInputs, {
    fixture,
    template,
  });
  if (
    setupReceipt.run.commit !== receipt.run.commit ||
    setupReceipt.run.tree !== receipt.run.tree
  ) {
    stale.push(
      fail(
        "stale-receipt-rejected",
        "the setup receipt is for a different run than the receipt",
      ),
    );
  }
  if (stale.length > 0) {
    return {
      ...base,
      status: "rejected",
      failures: stale,
      requests: [],
      summary: summarize([]),
    };
  }

  const results = [];
  const suiteFailures = [];
  const setupByKey = new Map(
    setupReceipt.cases.map((entry) => [
      `${entry.caseId}/${entry.variantId}`,
      entry,
    ]),
  );
  const used = new Set();
  const namespaceCounts = new Map();
  for (const entry of setupReceipt.cases) {
    namespaceCounts.set(
      entry.workspaceNamespace,
      (namespaceCounts.get(entry.workspaceNamespace) ?? 0) + 1,
    );
  }
  const markersByCase = new Map(
    fixture.cases.map((testCase) => [testCase.caseId, testCase.markers]),
  );
  const allIds = (caseId) => {
    const ids = [];
    for (const [key, entry] of setupByKey) {
      if (key.startsWith(`${caseId}/`))
        ids.push(
          ...entry.idMap.map((row) => row.runtimeId),
          ...entry.idMap.map((row) => row.logicalId),
        );
    }
    return ids;
  };

  for (const testCase of fixture.cases) {
    const otherMarkers = fixture.cases
      .filter((other) => other.caseId !== testCase.caseId)
      .flatMap((other) => markersByCase.get(other.caseId) ?? []);
    const otherIds = fixture.cases
      .filter((other) => other.caseId !== testCase.caseId)
      .flatMap((other) => allIds(other.caseId));
    for (const variant of testCase.variants) {
      const requests = variantRequests(variant);
      const setupCase = setupByKey.get(
        `${testCase.caseId}/${variant.variantId}`,
      );
      const stages = requests.map((request) => request.stage);
      // The negative is only excluded from the reject request itself: an old
      // Revision that an earlier stage used is still verified eligible there.
      const requiredByStage = new Map(
        requests.map((request, index) => [
          request.stage,
          variant.kind === "reject" && index === requests.length - 1
            ? request.revisionIds.filter(
                (id) => id !== variant.ineligibleLogicalId,
              )
            : request.revisionIds,
        ]),
      );
      const setupInvalid = setupCase
        ? [
            ...checkSetupCase(setupCase, {
              stages,
              requiredByStage,
              ineligible:
                variant.kind === "reject"
                  ? {
                      logicalId: variant.ineligibleLogicalId,
                      stage: stages.at(-1),
                    }
                  : null,
            }),
            ...workspaceNamespaceInvalid(
              setupCase,
              testCase.isolation,
              namespaceCounts,
            ),
          ]
        : [
            fail(
              "setup-invalid:setup-receipt-missing",
              `no setup receipt case for ${testCase.caseId}/${variant.variantId}`,
            ),
          ];
      const idMap = setupCase ? idMapOf(setupCase) : new Map();
      for (const [requestIndex, requestSpec] of requests.entries()) {
        const requestKind =
          variant.kind === "reject" && requestIndex === requests.length - 1
            ? "reject"
            : "positive";
        const request = receipt.requests.filter(
          (row) =>
            row.caseId === testCase.caseId &&
            row.variantId === variant.variantId &&
            row.stage === requestSpec.stage,
        );
        const result = {
          requestId: request[0]?.requestId ?? null,
          caseId: testCase.caseId,
          variantId: variant.variantId,
          stage: requestSpec.stage,
          requestKind,
          status: "passed",
          failures: [],
          invalid: [],
          countsAsPositiveEvidence: requestKind === "positive",
          countsAsDp1Evidence: false,
        };
        results.push(result);
        if (request.length !== 1) {
          result.status = "failed";
          result.failures.push(
            fail(
              request.length === 0 ? "request-missing" : "request-duplicate",
              `${testCase.caseId}/${variant.variantId} stage ${requestSpec.stage}: ${request.length} receipt requests`,
            ),
          );
          continue;
        }
        const entry = request[0];
        used.add(entry.requestId);
        if (entry.requestKind !== requestKind) {
          result.status = "failed";
          result.failures.push(
            fail(
              "request-kind-mismatch",
              `the receipt request is ${entry.requestKind}, the fixture expects ${requestKind}`,
            ),
          );
          continue;
        }
        const passedRuntime = requestSpec.revisionIds.map((logicalId) =>
          idMap.get(logicalId),
        );
        if (setupInvalid.length > 0) {
          result.status = "invalid";
          result.invalid.push(...setupInvalid);
          continue;
        }
        if (passedRuntime.some((id) => id === undefined)) {
          result.status = "invalid";
          result.invalid.push(
            fail(
              "setup-invalid:id-map",
              "the setup receipt does not map every passed Revision to a runtime id",
            ),
          );
          continue;
        }
        if (!sameJson(entry.passedRevisionIds, passedRuntime)) {
          result.status = "failed";
          result.failures.push(
            fail(
              "same-input-check-rejects-passedRevisionIds",
              "the Revision ids passed to D-final differ from the fixture's list mapped through the setup receipt",
            ),
          );
          continue;
        }
        const scored =
          requestKind === "reject"
            ? scoreRejectRequest({
                request: entry,
                expected: requestSpec.expected,
              })
            : scorePositiveRequest({
                request: entry,
                expected: {
                  ...requestSpec.expected,
                  passedRuntimeIds: passedRuntime,
                },
                testCase,
                fixture,
                setupCase,
                template,
                otherMarkers,
                otherIds,
              });
        result.failures.push(...scored.failures);
        result.invalid.push(...scored.invalid);
        result.status =
          scored.failures.length > 0
            ? "failed"
            : scored.invalid.length > 0
              ? "invalid"
              : "passed";
      }
    }
  }
  const diagnostics = [];
  for (const diagnostic of fixture.diagnosticCases ?? []) {
    if (!diagnostic.p12) continue;
    const matches = receipt.requests.filter(
      (row) =>
        row.caseId === diagnostic.caseId &&
        row.variantId === diagnostic.p12.variantId,
    );
    if (matches.length === 0) continue; // the harness-check case is optional
    const entry = matches[0];
    for (const row of matches) used.add(row.requestId);
    const outcome = {
      caseId: diagnostic.caseId,
      variantId: diagnostic.p12.variantId,
      evidenceUse: "none",
      status: "passed",
      failures: [],
      invalid: [],
      candidateSlot: null,
      baselineSlot: null,
    };
    diagnostics.push(outcome);
    const setupCase = setupByKey.get(
      `${diagnostic.caseId}/${diagnostic.p12.variantId}`,
    );
    if (matches.length !== 1) {
      outcome.status = "failed";
      outcome.failures.push(
        fail(
          "request-duplicate",
          `${diagnostic.caseId} has ${matches.length} receipt requests`,
        ),
      );
      continue;
    }
    const setupInvalid = setupCase
      ? [
          ...checkSetupCase(setupCase, {
            stages: [1],
            requiredByStage: new Map([[1, diagnostic.p12.revisionIds]]),
          }),
          ...workspaceNamespaceInvalid(setupCase, undefined, namespaceCounts),
        ]
      : [
          fail(
            "setup-invalid:setup-receipt-missing",
            `no setup receipt case for ${diagnostic.caseId}`,
          ),
        ];
    if (setupInvalid.length > 0) {
      outcome.status = "invalid";
      outcome.invalid.push(...setupInvalid);
      continue;
    }
    const idMap = idMapOf(setupCase);
    const passed = diagnostic.p12.revisionIds.map((logicalId) =>
      idMap.get(logicalId),
    );
    const groups = diagnostic.p12.improvementGroups.map((group) => ({
      ownerId: idMap.get(group.logicalId),
      kind: group.kind,
    }));
    if (
      passed.some((id) => id === undefined) ||
      groups.some((group) => group.ownerId === undefined)
    ) {
      outcome.status = "invalid";
      outcome.invalid.push(
        fail(
          "setup-invalid:id-map",
          "the setup receipt does not map the diagnostic case's Revisions",
        ),
      );
      continue;
    }
    if (!sameJson(entry.passedRevisionIds, passed)) {
      outcome.status = "failed";
      outcome.failures.push(
        fail(
          "same-input-check-rejects-passedRevisionIds",
          "the diagnostic request's Revision ids differ from the fixture's list",
        ),
      );
      continue;
    }
    const scored = scoreP12Pair({
      request: entry,
      expectation: {
        slot: "qualifiedEvidence",
        baselineTarget: 0,
        candidateTarget: 1,
        improvementGroups: groups,
        contextBudgetTokens: diagnostic.p12.contextBudgetTokens,
      },
      template,
      fixtureRoute: fixture.route,
    });
    outcome.status = scored.status;
    outcome.failures.push(...scored.failures);
    outcome.invalid.push(...scored.invalid);
    outcome.candidateSlot = scored.candidateSlot;
    outcome.baselineSlot = scored.baselineSlot;
  }
  for (const entry of receipt.requests) {
    if (!used.has(entry.requestId)) {
      suiteFailures.push(
        fail(
          "request-unexpected",
          `receipt request ${entry.requestId} (${entry.caseId}/${entry.variantId}) is not in the fixture`,
        ),
      );
    }
  }
  const covered = new Set(fixture.cases.map((testCase) => testCase.caseId));
  for (const caseId of DPH_CASE_IDS) {
    if (!covered.has(caseId))
      suiteFailures.push(fail("case-missing", `fixture lacks ${caseId}`));
  }
  // A failing harness-check case does not make P evidence, but it makes the run untrustworthy.
  const anyFailed =
    results.some((result) => result.status === "failed") ||
    diagnostics.some((result) => result.status === "failed") ||
    suiteFailures.length > 0;
  const anyInvalid =
    results.some((result) => result.status === "invalid") ||
    diagnostics.some((result) => result.status === "invalid");
  return {
    ...base,
    status: anyFailed ? "failed" : anyInvalid ? "invalid" : "passed",
    failures: suiteFailures,
    requests: results,
    diagnostics,
    summary: summarize(results),
  };
}

export { REJECT_CODE, scorerDigest };
