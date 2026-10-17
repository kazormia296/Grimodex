// Fixture, freeze-record and review-record contract for the final-request
// evaluation (DP-H, K6/2 nir1-final-request-packing-eval).
//
// This module never runs Native, a model or a database. It validates the
// pre-registered files (evals/nir1-packing/final-request.*) and the order in
// which they were frozen:
//   - the fixture's shape (closed fields, isolated cases, expectations derived
//     before any Native observation),
//   - the freeze record that binds the fixture, the scorer modules and the
//     independent expectation review by sha256 (`nativeOutputObservedBeforeFreeze`
//     must be false),
//   - the separation of the fixture author, the expectation reviewer and the
//     implementers of the harness, and
//   - that the freeze commit is an ancestor of the run commit
//     (`git merge-base --is-ancestor`, one synchronous bounded child process
//     per call; no shell, no network, no background work).
//
// Rule sources: docs/plans/nir1-final-request-eval-proposal-2-draft.md
// (confirmed Session B1, 2026-10-17): Mandatory defenses "観測前の固定",
// "作者の分離と freeze の順序", "fixture の版と freeze 記録",
// "variant の区分と負例の表し方", "case ごとの材料と測る時期".
//
// Fixture shape (`nir1-final-request-fixture/1`, evals/nir1-packing/final-request.v1.json):
//   schemaVersion, contractId, draftRef, fixtureVersion (1), phase ("dp-h"),
//   fixtureId, estimatorVersion, fixedTemplate { version, ref },
//   route { model, contextWindowTokens, outputTokens },
//   canaries [{ id, kind: decision-note | internal-metadata, text }],
//   excludedNegatives [{ caseId, negative, reason }]  (negatives that cannot be
//     derived to one unique reason; they move to DD-1's mixed variants),
//   cases (exactly P-01, P-02, P-04, P-05, P-06, P-07, P-08, P-10, P-11, in order):
//     { caseId, task, userMessage, markers [detection strings unique to the case],
//       isolation { workspaceId, conversationId, artifactNamespace },
//       variants [{ variantId, kind: positive | reject, requests [...] }] }
//   A positive request: { stage, revisionIds [logical ids], expected {
//       contextBudgetTokens, rawText (pre-escape),
//       codexEntries [{ logicalId, groupLogicalId, part, text (post-escape, no "\n";
//         a template: runtime values are written as `{{<kind>:<logicalId>}}`) }]
//         in payload order, whole groups of the five parts,
//       selectedGroupLogicalIds, exactQuotes [{ logicalId, quote }],
//       forbidden { logicalIds, texts }, embeddedCanaryIds } }
//   A reject variant also has { baseVariantId, negative, ineligibleLogicalId };
//     its last request lists the positive request's revisionIds plus exactly
//     the ineligible one and expects { code: NIR1_NATIVE_A2_UNAVAILABLE, reason }.
//     An earlier request of a multi-stage variant is a positive request.
//   A P-10 variant has two requests (stage 1 and 2); stage 2 uses the newly
//     prepared Revisions (ids disjoint from stage 1) and forbids the old
//     Revisions' ids, entry ids and entry texts. Every positive P-10 variant
//     has `binding` (scope | source | revision | decision | freshness); a
//     binding with no variant is listed in excludedNegatives (caseId P-10,
//     negative = the binding kind) with a reason.
//   diagnosticCases (optional harness checks, never P evidence): { caseId: DIAG-..,
//     evidenceUse: "none", userMessage, rawText (pre-escape; Raw is required in
//     both P-12 arms), materials [{ logicalId, text }],
//     p12 { variantId, revisionIds, improvementGroups [{ logicalId, kind }],
//     contextBudgetTokens } }.
// Freeze record (`nir1-final-request-freeze/1`): status pending-review | frozen,
//   nativeOutputObservedBeforeFreeze false, frozenAt, reviewVerdict, fixture /
//   reviewRecord / readme / parityVector { path, sha256 }, scorer.files (the four
//   SCORER_FILES), contextBudget { formula, terms, perRequest [{ caseId,
//   variantId, stage (optional, default 1), contextBudgetTokens, selectedTokens,
//   marginTokens }] } (one row per positive request, matching the fixture),
//   authorSeparation { fixtureAuthor, expectationReviewer, harnessImplementers,
//   nativeReceiptProvidedToAuthor false }.
// Review record (`nir1-final-request-expectation-review/1`): verdict, reviewer
//   { agent, model, distinctFromFixtureAuthor, distinctFromImplementers, readOnly,
//   nativeOutputObserved false }, fixtureSha256 (the reviewed bytes), requiredChanges,
//   cases [{ caseId, verdict }].
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  FIXED_TEMPLATE_REF,
  FIXED_TEMPLATE_VERSION,
  ESTIMATOR_VERSION,
  contextBudgetTokens,
  escapeReservedPromptTags,
  estimateTokens,
  loadFixedTemplate,
  sha256Hex,
} from "./payload.mjs";
import {
  ATOMIC_PARTS,
  BINDING_KINDS,
  CONTRACT_ID,
  DRAFT_REF,
  RUNTIME_VALUE_KINDS,
} from "./receipt.mjs";

export const FIXTURE_PATH = "evals/nir1-packing/final-request.v1.json";
export const FREEZE_PATH = "evals/nir1-packing/final-request.freeze.v1.json";
export const REVIEW_PATH =
  "evals/nir1-packing/final-request.expectation-review.v1.json";
export const README_PATH = "evals/nir1-packing/final-request.README.md";
export const PARITY_VECTOR_PATH =
  "evals/nir1-packing/final-request-baseline-parity.v1.json";

export const FIXTURE_SCHEMA_VERSION = "nir1-final-request-fixture/1";
export const FREEZE_SCHEMA_VERSION = "nir1-final-request-freeze/1";
export const REVIEW_SCHEMA_VERSION = "nir1-final-request-expectation-review/1";

/** Cases DP-H runs (P-03, P-09 and P-12 are measured only by DD-1). */
export const DPH_CASE_IDS = Object.freeze([
  "P-01",
  "P-02",
  "P-04",
  "P-05",
  "P-06",
  "P-07",
  "P-08",
  "P-10",
  "P-11",
]);

export const REJECT_CODE = "NIR1_NATIVE_A2_UNAVAILABLE";
export const CANARY_KINDS = Object.freeze([
  "decision-note",
  "internal-metadata",
]);
export const FREEZE_STATUS = Object.freeze({
  pending: "pending-review",
  frozen: "frozen",
});
export const APPROVING_VERDICT = "approve";

/** The scorer modules a freeze record must bind (the scorer imports all four). */
export const SCORER_FILES = Object.freeze([
  "scripts/quality/nir1-packing/final-request/scorer.mjs",
  "scripts/quality/nir1-packing/final-request/contract.mjs",
  "scripts/quality/nir1-packing/final-request/receipt.mjs",
  "scripts/quality/nir1-packing/final-request/payload.mjs",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const FROZEN_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const GIT_TIMEOUT_MS = 10_000;

export function sha256(bytes) {
  return sha256Hex(bytes);
}

/**
 * The single digest a receipt records as `inputs.scorerSha256`: sha256 over the
 * lines `<path>\t<sha256>\n` of the freeze record's scorer modules, sorted by
 * path. The harness computes the same value from the freeze record.
 */
export function scorerDigest(files) {
  const lines = [...files]
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    .map((file) => `${file.path}\t${file.sha256}\n`)
    .join("");
  return sha256(lines);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The requests of a variant, in stage order. Every variant lists them. */
export function variantRequests(variant) {
  return Array.isArray(variant?.requests) ? variant.requests : [];
}

// --------------------------------------------------- expected text templates

/**
 * An expected codex entry (and a forbidden text) is a template. The text a
 * product entry holds carries values that cannot be written as literals before
 * Native runs: the Revision, proposal and decision ids (generated when the
 * Revision is prepared and approved), the Source ids and the Source revision
 * tokens (derived from the live Scene state). Such a value is written
 * `{{<kind>:<logicalId>}}`; the closed kinds are below. The scorer resolves a
 * placeholder from the setup receipt only (the id map and `runtimeValues`,
 * fixed by product writers / readers before the request is built), never from
 * the payload, the capture or the D-final result.
 *
 * `maxLength` is the length the estimator counts for the placeholder: a UUID is
 * exactly 36 characters; a token is bounded by `sha256:` plus 64 hex (71) and
 * rounded up to 80. The value is ASCII, so the estimate is an upper bound of
 * the real entry's tokens and the freeze record's `selectedTokens` uses the same
 * formula. The scorer refuses a resolved value longer than `maxLength`.
 */
export const PLACEHOLDER_KINDS = Object.freeze({
  revisionId: Object.freeze({ source: "idMap.runtimeId", maxLength: 36 }),
  proposalId: Object.freeze({ source: "idMap.proposalId", maxLength: 36 }),
  decisionId: Object.freeze({ source: "idMap.decisionId", maxLength: 36 }),
  runtimeId: Object.freeze({ source: "idMap.runtimeId", maxLength: 36 }),
  ...Object.fromEntries(
    RUNTIME_VALUE_KINDS.map((kind) => [
      kind,
      Object.freeze({ source: "runtimeValues", maxLength: 80 }),
    ]),
  ),
});
/** Kinds whose logical id names a Revision of the variant. */
export const REVISION_PLACEHOLDER_KINDS = Object.freeze([
  "revisionId",
  "proposalId",
  "decisionId",
]);
/**
 * A value a placeholder resolves to: ASCII with no JSON escape. A space is
 * allowed because the product still accepts the legacy SQLite `updated_at`
 * (`2026-10-18 07:05:22`) inside a Source token.
 */
export const PLACEHOLDER_VALUE_PATTERN = /^[A-Za-z0-9_.:@+\-\/= ]+$/;

const PLACEHOLDER_SOURCE = "\\{\\{([A-Za-z]+):([A-Za-z0-9._-]+)\\}\\}";
const SKELETON_MARK = "\u0000";

/** Every placeholder of a template, in order: `{ kind, logicalId, token }`. */
export function templatePlaceholders(text) {
  return [...String(text).matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))].map(
    (match) => ({ kind: match[1], logicalId: match[2], token: match[0] }),
  );
}

/** The template with every placeholder replaced by one mark (for substring checks). */
export function templateSkeleton(text) {
  return String(text).replace(
    new RegExp(PLACEHOLDER_SOURCE, "g"),
    SKELETON_MARK,
  );
}

/**
 * Problems of a template: an unknown kind, a stray `{{` (valid JSON never
 * holds one, so a literal `{{` cannot be written), and, when `revisionIds` is
 * given, a Revision-kind placeholder naming a Revision the variant does not
 * use.
 */
export function templateErrors(
  text,
  label,
  { revisionIds = null, scope = "variant" } = {},
) {
  const errors = [];
  if (typeof text !== "string") return errors;
  for (const placeholder of templatePlaceholders(text)) {
    if (!Object.hasOwn(PLACEHOLDER_KINDS, placeholder.kind)) {
      errors.push(
        `${label} has the placeholder ${placeholder.token} of an unknown kind (${Object.keys(PLACEHOLDER_KINDS).join(", ")})`,
      );
    } else if (
      revisionIds &&
      REVISION_PLACEHOLDER_KINDS.includes(placeholder.kind) &&
      !revisionIds.has(placeholder.logicalId)
    ) {
      errors.push(
        `${label} has ${placeholder.token}, which names a Revision the ${scope} does not use`,
      );
    }
  }
  if (templateSkeleton(text).includes("{{")) {
    errors.push(
      `${label} has a "{{" that is not a well-formed placeholder ({{<kind>:<logicalId>}})`,
    );
  }
  return errors;
}

/**
 * Estimator tokens of a template: each placeholder counts as `maxLength` ASCII
 * characters (the product entry holds the real value; see PLACEHOLDER_KINDS).
 * The same formula serves the entry budget check and the freeze record's
 * `perRequest` table.
 */
export function estimateTemplateTokens(text) {
  return estimateTokens(
    String(text).replace(new RegExp(PLACEHOLDER_SOURCE, "g"), (_whole, kind) =>
      "x".repeat(PLACEHOLDER_KINDS[kind]?.maxLength ?? 0),
    ),
  );
}

/**
 * Replaces every placeholder with `lookup(kind, logicalId)`. `unresolved`
 * lists the placeholders with no value (an unknown kind included); the text
 * keeps them as written.
 */
export function resolveTemplate(text, lookup) {
  const unresolved = [];
  const resolved = String(text).replace(
    new RegExp(PLACEHOLDER_SOURCE, "g"),
    (whole, kind, logicalId) => {
      const value = Object.hasOwn(PLACEHOLDER_KINDS, kind)
        ? lookup(kind, logicalId)
        : undefined;
      if (typeof value !== "string" || value.length === 0) {
        unresolved.push(whole);
        return whole;
      }
      return value;
    },
  );
  return { text: resolved, unresolved };
}

// ------------------------------------------------------------------ fixture

function validateRoute(route, errors) {
  if (!isRecord(route)) {
    errors.push("route must be an object");
    return;
  }
  if (!nonEmpty(route.model)) errors.push("route.model is required");
  if (!positiveInt(route.contextWindowTokens)) {
    errors.push("route.contextWindowTokens must be a positive integer");
  }
  if (!positiveInt(route.outputTokens)) {
    errors.push("route.outputTokens must be a positive integer");
  }
}

function validateCanaries(canaries, errors) {
  if (!Array.isArray(canaries) || canaries.length === 0) {
    errors.push("canaries must be a non-empty array");
    return new Set();
  }
  const ids = new Set();
  const kinds = new Set();
  for (const [index, canary] of canaries.entries()) {
    const label = `canaries[${index}]`;
    if (!isRecord(canary)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!nonEmpty(canary.id)) errors.push(`${label}.id is required`);
    if (!CANARY_KINDS.includes(canary.kind)) {
      errors.push(`${label}.kind must be one of ${CANARY_KINDS.join(", ")}`);
    }
    if (!nonEmpty(canary.text) || canary.text.length < 8) {
      errors.push(
        `${label}.text must be a detection string of at least 8 characters`,
      );
    }
    if (ids.has(canary.id)) errors.push(`${label}.id duplicates ${canary.id}`);
    ids.add(canary.id);
    kinds.add(canary.kind);
  }
  for (const kind of CANARY_KINDS) {
    if (!kinds.has(kind)) errors.push(`canaries must include a ${kind} canary`);
  }
  return ids;
}

function validateExpectedPositive(expected, label, errors, ctx) {
  if (!isRecord(expected)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (
    !Number.isInteger(expected.contextBudgetTokens) ||
    expected.contextBudgetTokens <= 0
  ) {
    errors.push(`${label}.contextBudgetTokens must be a positive integer`);
  } else if (ctx.template && nonEmpty(ctx.userMessage)) {
    const derived = contextBudgetTokens({
      template: ctx.template,
      userMessage: ctx.userMessage,
      contextWindowTokens: ctx.route.contextWindowTokens,
      outputTokens: ctx.route.outputTokens,
    });
    if (derived !== expected.contextBudgetTokens) {
      errors.push(
        `${label}.contextBudgetTokens ${expected.contextBudgetTokens} differs from the budget formula (${derived})`,
      );
    }
  }
  if (!nonEmpty(expected.rawText)) errors.push(`${label}.rawText is required`);

  const entries = expected.codexEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(
      `${label}.codexEntries must be a non-empty array of IR entries`,
    );
    return;
  }
  const groupOrder = [];
  const byGroup = new Map();
  let selectedTokens = nonEmpty(expected.rawText)
    ? estimateTokens(expected.rawText)
    : 0;
  for (const [index, entry] of entries.entries()) {
    const entryLabel = `${label}.codexEntries[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryLabel} must be an object`);
      continue;
    }
    if (!nonEmpty(entry.logicalId))
      errors.push(`${entryLabel}.logicalId is required`);
    if (!nonEmpty(entry.groupLogicalId))
      errors.push(`${entryLabel}.groupLogicalId is required`);
    if (!ATOMIC_PARTS.includes(entry.part)) {
      errors.push(
        `${entryLabel}.part must be one of ${ATOMIC_PARTS.join(", ")}`,
      );
    }
    if (typeof entry.text !== "string" || entry.text.length === 0) {
      errors.push(`${entryLabel}.text is required`);
      continue;
    }
    if (entry.text.includes("\n")) {
      errors.push(`${entryLabel}.text must not contain the entry separator`);
    }
    errors.push(
      // An entry holds the values its own request's Revisions fixed: a
      // Revision of another stage is settled after (or before) this request.
      ...templateErrors(entry.text, `${entryLabel}.text`, {
        revisionIds: ctx.requestRevisionIds ?? ctx.revisionIds,
        scope: ctx.requestRevisionIds ? "request" : "variant",
      }),
    );
    selectedTokens += estimateTemplateTokens(entry.text);
    if (!byGroup.has(entry.groupLogicalId)) {
      byGroup.set(entry.groupLogicalId, []);
      groupOrder.push(entry.groupLogicalId);
    }
    byGroup.get(entry.groupLogicalId).push({ index, entry });
  }
  for (const group of groupOrder) {
    const rows = byGroup.get(group);
    const parts = rows.map((row) => row.entry.part);
    if (parts.join(",") !== ATOMIC_PARTS.join(",")) {
      errors.push(
        `${label} atomic group ${group} must list ${ATOMIC_PARTS.join(", ")} in that order`,
      );
    }
    const indexes = rows.map((row) => row.index);
    if (
      indexes.some(
        (value, position) =>
          position > 0 && value !== indexes[position - 1] + 1,
      )
    ) {
      errors.push(`${label} atomic group ${group} must be consecutive entries`);
    }
  }
  if (
    Number.isInteger(expected.contextBudgetTokens) &&
    selectedTokens > expected.contextBudgetTokens
  ) {
    errors.push(
      `${label} selected material (${selectedTokens} tokens) exceeds contextBudgetTokens`,
    );
  }
  if (
    !Array.isArray(expected.selectedGroupLogicalIds) ||
    expected.selectedGroupLogicalIds.join("\u0000") !==
      groupOrder.join("\u0000")
  ) {
    errors.push(
      `${label}.selectedGroupLogicalIds must list the entry groups in payload order`,
    );
  }
  const quotes = expected.exactQuotes;
  if (!Array.isArray(quotes) || quotes.length === 0) {
    errors.push(`${label}.exactQuotes must be a non-empty array`);
  } else {
    for (const [index, quote] of quotes.entries()) {
      const quoteLabel = `${label}.exactQuotes[${index}]`;
      const entry = entries.find((row) => row?.logicalId === quote?.logicalId);
      if (!isRecord(quote) || !entry) {
        errors.push(`${quoteLabel}.logicalId must name a codex entry`);
      } else if (
        !nonEmpty(quote.quote) ||
        quote.quote.includes(SKELETON_MARK) ||
        !templateSkeleton(entry.text).includes(quote.quote)
      ) {
        errors.push(
          `${quoteLabel}.quote must be a literal substring of its entry text (not part of a placeholder)`,
        );
      }
    }
  }
  const forbidden = expected.forbidden;
  if (
    !isRecord(forbidden) ||
    !Array.isArray(forbidden.logicalIds) ||
    !Array.isArray(forbidden.texts)
  ) {
    errors.push(`${label}.forbidden must list logicalIds and texts`);
  } else {
    if (forbidden.logicalIds.some((id) => !nonEmpty(id))) {
      errors.push(`${label}.forbidden.logicalIds must be non-empty strings`);
    }
    if (forbidden.texts.some((text) => !nonEmpty(text))) {
      errors.push(`${label}.forbidden.texts must be non-empty strings`);
    }
    for (const [index, text] of forbidden.texts.entries()) {
      errors.push(
        ...templateErrors(text, `${label}.forbidden.texts[${index}]`, {
          revisionIds: ctx.revisionIds,
        }),
      );
    }
    const selected = new Set(
      entries.flatMap((entry) => [entry?.logicalId, entry?.groupLogicalId]),
    );
    for (const id of forbidden.logicalIds) {
      if (selected.has(id))
        errors.push(`${label}.forbidden.logicalIds names selected ${id}`);
    }
    for (const text of forbidden.texts) {
      if (
        entries.some((entry) => entry?.text?.includes(text)) ||
        expected.rawText?.includes(text)
      ) {
        errors.push(
          `${label}.forbidden.texts has a string that the expected payload contains`,
        );
      }
    }
  }
  if (!Array.isArray(expected.embeddedCanaryIds)) {
    errors.push(`${label}.embeddedCanaryIds must be an array`);
  } else {
    for (const id of expected.embeddedCanaryIds) {
      if (!ctx.canaryIds.has(id))
        errors.push(`${label}.embeddedCanaryIds names unknown canary ${id}`);
    }
    const text = [
      expected.rawText ?? "",
      ...entries.map((entry) => entry?.text ?? ""),
    ].join("\n");
    for (const canary of ctx.canaries) {
      if (text.includes(canary.text)) {
        errors.push(`${label} expected payload contains canary ${canary.id}`);
      }
    }
  }
  if (
    escapeReservedPromptTags(expected.rawText ?? "") !==
    (expected.rawText ?? "")
  ) {
    errors.push(
      `${label}.rawText must not contain a reserved prompt tag (it would be escaped)`,
    );
  }
}

function validateCase(testCase, index, ctx, errors) {
  const label = `cases[${index}]`;
  if (!isRecord(testCase)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (testCase.caseId !== DPH_CASE_IDS[index]) {
    errors.push(`${label}.caseId must be ${DPH_CASE_IDS[index]}`);
  }
  if (!nonEmpty(testCase.task)) errors.push(`${label}.task is required`);
  if (!nonEmpty(testCase.userMessage))
    errors.push(`${label}.userMessage is required`);
  const isolation = testCase.isolation;
  if (!isRecord(isolation)) {
    errors.push(`${label}.isolation must be an object`);
  } else {
    for (const key of ["workspaceId", "conversationId", "artifactNamespace"]) {
      if (!nonEmpty(isolation[key])) {
        errors.push(`${label}.isolation.${key} is required`);
      } else if (ctx.isolation[key].has(isolation[key])) {
        errors.push(`${label}.isolation.${key} is shared with another case`);
      } else {
        ctx.isolation[key].add(isolation[key]);
      }
    }
  }
  if (
    !Array.isArray(testCase.markers) ||
    testCase.markers.length === 0 ||
    testCase.markers.some((marker) => !nonEmpty(marker) || marker.length < 6)
  ) {
    errors.push(
      `${label}.markers must list detection strings of at least 6 characters`,
    );
  }
  const variants = testCase.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    errors.push(`${label}.variants must be a non-empty array`);
    return;
  }
  const positives = new Map();
  let positiveCount = 0;
  for (const [variantIndex, variant] of variants.entries()) {
    const variantLabel = `${label}.variants[${variantIndex}]`;
    if (!isRecord(variant)) {
      errors.push(`${variantLabel} must be an object`);
      continue;
    }
    if (!nonEmpty(variant.variantId))
      errors.push(`${variantLabel}.variantId is required`);
    else if (ctx.variantIds.has(variant.variantId)) {
      errors.push(`${variantLabel}.variantId duplicates ${variant.variantId}`);
    } else {
      ctx.variantIds.add(variant.variantId);
    }
    if (!["positive", "reject"].includes(variant.kind)) {
      errors.push(`${variantLabel}.kind must be positive or reject`);
      continue;
    }
    const requests = variantRequests(variant);
    if (requests.length === 0) {
      errors.push(`${variantLabel}.requests must be a non-empty array`);
      continue;
    }
    const variantRevisionIds = new Set(
      requests.flatMap((request) =>
        Array.isArray(request?.revisionIds) ? request.revisionIds : [],
      ),
    );
    if (variant.kind === "reject") {
      if (!nonEmpty(variant.baseVariantId))
        errors.push(`${variantLabel}.baseVariantId is required`);
      if (!nonEmpty(variant.negative))
        errors.push(`${variantLabel}.negative is required`);
      if (!nonEmpty(variant.ineligibleLogicalId)) {
        errors.push(`${variantLabel}.ineligibleLogicalId is required`);
      }
    } else {
      positiveCount += 1;
    }
    for (const [requestIndex, request] of requests.entries()) {
      const requestLabel = `${variantLabel}.requests[${requestIndex}]`;
      if (!isRecord(request)) {
        errors.push(`${requestLabel} must be an object`);
        continue;
      }
      if (request.stage !== requestIndex + 1) {
        errors.push(`${requestLabel}.stage must be ${requestIndex + 1}`);
      }
      if (
        !Array.isArray(request.revisionIds) ||
        request.revisionIds.length === 0 ||
        request.revisionIds.some((id) => !nonEmpty(id)) ||
        new Set(request.revisionIds).size !== request.revisionIds.length
      ) {
        errors.push(
          `${requestLabel}.revisionIds must be unique non-empty logical ids`,
        );
      }
      const isRejectRequest =
        variant.kind === "reject" && requestIndex === requests.length - 1;
      if (!isRejectRequest) {
        validateExpectedPositive(
          request.expected,
          `${requestLabel}.expected`,
          errors,
          {
            ...ctx,
            userMessage: testCase.userMessage,
            revisionIds: variantRevisionIds,
            requestRevisionIds: new Set(
              Array.isArray(request.revisionIds) ? request.revisionIds : [],
            ),
          },
        );
        if (
          Array.isArray(request.revisionIds) &&
          Array.isArray(request.expected?.selectedGroupLogicalIds)
        ) {
          for (const group of request.expected.selectedGroupLogicalIds) {
            if (!request.revisionIds.includes(group)) {
              errors.push(
                `${requestLabel}.expected selects ${group}, which is not a passed revision`,
              );
            }
          }
        }
        positives.set(`${variant.variantId}#${request.stage}`, request);
      } else {
        const expected = request.expected;
        if (
          !isRecord(expected) ||
          expected.code !== REJECT_CODE ||
          !nonEmpty(expected.reason)
        ) {
          errors.push(
            `${requestLabel}.expected must be { code: ${REJECT_CODE}, reason }`,
          );
        }
      }
    }
  }
  if (positiveCount === 0)
    errors.push(`${label} needs at least one positive variant`);
  checkLaterStages(testCase, label, errors);
  // A reject variant is its positive variant plus exactly one ineligible Revision.
  for (const [variantIndex, variant] of variants.entries()) {
    if (!isRecord(variant) || variant.kind !== "reject") continue;
    const variantLabel = `${label}.variants[${variantIndex}]`;
    const base = variants.find(
      (row) => row?.variantId === variant.baseVariantId,
    );
    if (!base || base.kind !== "positive") {
      errors.push(
        `${variantLabel}.baseVariantId must name a positive variant of the case`,
      );
      continue;
    }
    const baseRequests = variantRequests(base);
    const rejectRequests = variantRequests(variant);
    const request = rejectRequests.at(-1);
    const baseRequest =
      baseRequests[rejectRequests.length - 1] ?? baseRequests.at(-1);
    if (!request || !baseRequest) continue;
    const added = (request.revisionIds ?? []).filter(
      (id) => !(baseRequest.revisionIds ?? []).includes(id),
    );
    const removed = (baseRequest.revisionIds ?? []).filter(
      (id) => !(request.revisionIds ?? []).includes(id),
    );
    if (
      added.length !== 1 ||
      added[0] !== variant.ineligibleLogicalId ||
      removed.length !== 0
    ) {
      errors.push(
        `${variantLabel} must add exactly one ineligible Revision (${variant.ineligibleLogicalId}) to the positive variant's revisionIds`,
      );
    }
  }
}

/**
 * A request after the first (P-10's request 2) is measured after a binding
 * change and a newly prepared Revision. The expectation, written before
 * observation, must name only new Revisions and must forbid the old
 * Revisions' ids and their text (draft: P-10 の事前登録).
 */
function checkLaterStages(testCase, label, errors) {
  for (const [variantIndex, variant] of (testCase.variants ?? []).entries()) {
    if (!isRecord(variant)) continue;
    const requests = variantRequests(variant);
    const variantLabel = `${label}.variants[${variantIndex}]`;
    for (const [index, request] of requests.entries()) {
      if (index === 0 || !isRecord(request)) continue;
      const earlier = requests.slice(0, index).filter(isRecord);
      const earlierRevisionIds = new Set(
        earlier.flatMap((row) =>
          Array.isArray(row.revisionIds) ? row.revisionIds : [],
        ),
      );
      const earlierEntries = earlier.flatMap((row) =>
        Array.isArray(row.expected?.codexEntries)
          ? row.expected.codexEntries.filter(isRecord)
          : [],
      );
      const requestLabel = `${variantLabel}.requests[${index}]`;
      const isRejectRequest =
        variant.kind === "reject" && index === requests.length - 1;
      const ids = (
        Array.isArray(request.revisionIds) ? request.revisionIds : []
      ).filter(
        (id) => !(isRejectRequest && id === variant.ineligibleLogicalId),
      );
      for (const id of ids) {
        if (earlierRevisionIds.has(id)) {
          errors.push(
            `${requestLabel}.revisionIds reuses the earlier-stage Revision ${id} (a later stage needs newly prepared Revisions)`,
          );
        }
      }
      if (isRejectRequest) continue;
      const forbidden = request.expected?.forbidden;
      if (!isRecord(forbidden)) continue;
      const forbiddenIds = new Set(
        Array.isArray(forbidden.logicalIds) ? forbidden.logicalIds : [],
      );
      const forbiddenTexts = new Set(
        Array.isArray(forbidden.texts) ? forbidden.texts : [],
      );
      for (const id of [
        ...earlierRevisionIds,
        ...earlierEntries.flatMap((entry) => [entry.logicalId]),
      ]) {
        if (!forbiddenIds.has(id)) {
          errors.push(
            `${requestLabel}.expected.forbidden.logicalIds must include the earlier-stage id ${id}`,
          );
        }
      }
      // Text the new stage's expected material also holds (a shared boilerplate
      // part) cannot be forbidden; every other earlier-stage entry text must be.
      const newMaterial = [
        request.expected?.rawText ?? "",
        ...(Array.isArray(request.expected?.codexEntries)
          ? request.expected.codexEntries.map((entry) => entry?.text ?? "")
          : []),
      ];
      const oldOnly = earlierEntries.filter(
        (entry) =>
          typeof entry.text === "string" &&
          entry.text.length > 0 &&
          !newMaterial.some((text) => text.includes(entry.text)),
      );
      if (earlierEntries.length > 0 && oldOnly.length === 0) {
        errors.push(
          `${requestLabel} has no earlier-stage text that is absent from the new stage's material (the old Revision's text cannot be told apart)`,
        );
      }
      for (const entry of oldOnly) {
        if (!forbiddenTexts.has(entry.text)) {
          errors.push(
            `${requestLabel}.expected.forbidden.texts must include the earlier-stage text of ${entry.logicalId}`,
          );
        }
      }
    }
  }
}

/** The five binding kinds of P-10 are each a positive P-10 variant's `binding` or a stated exclusion. */
function checkBindingCoverage(fixture, errors) {
  const p10 = fixture.cases.find((testCase) => testCase?.caseId === "P-10");
  if (!p10) return;
  const covered = new Set();
  for (const variant of p10.variants ?? []) {
    if (!isRecord(variant) || variant.kind !== "positive") continue;
    if (!BINDING_KINDS.includes(variant.binding)) {
      errors.push(
        `P-10 variant ${variant.variantId}.binding must be one of ${BINDING_KINDS.join(", ")}`,
      );
    } else if (covered.has(variant.binding)) {
      errors.push(
        `P-10 has more than one positive variant for the binding ${variant.binding}`,
      );
    } else {
      covered.add(variant.binding);
    }
  }
  const excluded = new Set(
    (Array.isArray(fixture.excludedNegatives) ? fixture.excludedNegatives : [])
      .filter((row) => isRecord(row) && row.caseId === "P-10")
      .map((row) => row.negative),
  );
  for (const binding of BINDING_KINDS) {
    if (covered.has(binding) && excluded.has(binding)) {
      errors.push(`P-10 binding ${binding} is both covered and excluded`);
    }
    if (!covered.has(binding) && !excluded.has(binding)) {
      errors.push(
        `P-10 binding ${binding} has no positive variant and is not in excludedNegatives`,
      );
    }
  }
}

/** Marker strings of one case must not occur in another case's expected text. */
function checkCaseSeparation(cases, errors) {
  for (const [index, testCase] of cases.entries()) {
    if (!isRecord(testCase) || !Array.isArray(testCase.markers)) continue;
    for (const [otherIndex, other] of cases.entries()) {
      if (otherIndex === index || !isRecord(other)) continue;
      const texts = [];
      for (const variant of other.variants ?? []) {
        for (const request of variantRequests(variant)) {
          if (variant.kind !== "positive") continue;
          texts.push(request.expected?.rawText ?? "");
          for (const entry of request.expected?.codexEntries ?? [])
            texts.push(entry?.text ?? "");
        }
      }
      for (const marker of testCase.markers) {
        if (
          typeof marker === "string" &&
          texts.some((text) => text.includes(marker))
        ) {
          errors.push(
            `case ${testCase.caseId} marker ${JSON.stringify(marker)} occurs in case ${other.caseId}'s expected material`,
          );
        }
      }
    }
  }
}

/** A logical id (Revision or entry) belongs to one case only. */
function checkLogicalIdIsolation(cases, errors) {
  const owner = new Map();
  for (const testCase of cases) {
    if (!isRecord(testCase)) continue;
    for (const variant of testCase.variants ?? []) {
      for (const request of variantRequests(variant)) {
        const ids = [...(request.revisionIds ?? [])];
        for (const entry of request.expected?.codexEntries ?? [])
          ids.push(entry?.logicalId);
        for (const id of ids) {
          if (typeof id !== "string") continue;
          const previous = owner.get(id);
          if (previous !== undefined && previous !== testCase.caseId) {
            errors.push(
              `logical id ${id} is shared by cases ${previous} and ${testCase.caseId}`,
            );
          }
          owner.set(id, testCase.caseId);
        }
      }
    }
  }
}

function validateDiagnosticCases(diagnostics, cases, errors) {
  if (diagnostics === undefined) return;
  if (!Array.isArray(diagnostics)) {
    errors.push("diagnosticCases must be an array when present");
    return;
  }
  const caseTexts = [];
  const caseIds = new Set();
  for (const testCase of cases) {
    if (!isRecord(testCase)) continue;
    for (const variant of testCase.variants ?? []) {
      for (const request of variantRequests(variant)) {
        for (const id of request.revisionIds ?? []) caseIds.add(id);
        if (variant.kind !== "positive") continue;
        caseTexts.push(request.expected?.rawText ?? "");
        for (const entry of request.expected?.codexEntries ?? []) {
          caseTexts.push(entry?.text ?? "");
          caseIds.add(entry?.logicalId);
        }
      }
    }
  }
  for (const [index, diagnostic] of diagnostics.entries()) {
    const label = `diagnosticCases[${index}]`;
    if (!isRecord(diagnostic)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (!/^DIAG-/.test(diagnostic.caseId ?? ""))
      errors.push(`${label}.caseId must start with DIAG-`);
    if (diagnostic.evidenceUse !== "none") {
      errors.push(
        `${label}.evidenceUse must be none (a diagnostic case is never P evidence)`,
      );
    }
    if (diagnostic.p12 !== undefined) {
      const p12 = diagnostic.p12;
      if (
        !isRecord(p12) ||
        !nonEmpty(p12.variantId) ||
        !Array.isArray(p12.revisionIds) ||
        p12.revisionIds.length === 0 ||
        !Array.isArray(p12.improvementGroups) ||
        p12.improvementGroups.length === 0 ||
        p12.improvementGroups.some(
          (group) =>
            !nonEmpty(group?.logicalId) ||
            !["graph-evidence", "accepted-ir"].includes(group?.kind) ||
            !p12.revisionIds.includes(group.logicalId),
        ) ||
        !positiveInt(p12.contextBudgetTokens)
      ) {
        errors.push(
          `${label}.p12 needs variantId, revisionIds, improvementGroups ({ logicalId, kind } within revisionIds) and contextBudgetTokens`,
        );
      }
      if (!nonEmpty(diagnostic.userMessage))
        errors.push(`${label}.userMessage is required`);
      if (!nonEmpty(diagnostic.rawText)) {
        errors.push(`${label}.rawText is required (Raw is held in both arms)`);
      } else {
        if (
          escapeReservedPromptTags(diagnostic.rawText) !== diagnostic.rawText
        ) {
          errors.push(
            `${label}.rawText must not contain a reserved prompt tag (it would be escaped)`,
          );
        }
        if (
          caseTexts.some(
            (text) =>
              text.length > 0 &&
              (text.includes(diagnostic.rawText) ||
                diagnostic.rawText.includes(text)),
          )
        ) {
          errors.push(`${label}.rawText reuses text of a fixture case`);
        }
      }
    }
    for (const material of diagnostic.materials ?? []) {
      if (caseIds.has(material?.logicalId)) {
        errors.push(
          `${label} reuses logical id ${material.logicalId} of a fixture case`,
        );
      }
      if (
        typeof material?.text === "string" &&
        caseTexts.some(
          (text) =>
            text.length > 0 &&
            (text.includes(material.text) || material.text.includes(text)),
        )
      ) {
        errors.push(`${label} reuses text of a fixture case`);
      }
    }
  }
}

/**
 * Validates a final-request fixture. `template` (optional, from
 * `loadFixedTemplate`) enables the context-budget formula check.
 */
export function validateFinalRequestFixture(fixture, { template } = {}) {
  const errors = [];
  if (!isRecord(fixture)) return ["fixture must be an object"];
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    errors.push(`fixture.schemaVersion must be ${FIXTURE_SCHEMA_VERSION}`);
  }
  if (fixture.contractId !== CONTRACT_ID)
    errors.push(`fixture.contractId must be ${CONTRACT_ID}`);
  if (fixture.draftRef !== DRAFT_REF)
    errors.push(`fixture.draftRef must be ${DRAFT_REF}`);
  if (fixture.fixtureVersion !== 1)
    errors.push(
      "fixture.fixtureVersion must be 1 (DD-1 adds a separate version 2 file)",
    );
  if (fixture.phase !== "dp-h") errors.push("fixture.phase must be dp-h");
  if (!nonEmpty(fixture.fixtureId))
    errors.push("fixture.fixtureId is required");
  if (fixture.estimatorVersion !== ESTIMATOR_VERSION) {
    errors.push(`fixture.estimatorVersion must be ${ESTIMATOR_VERSION}`);
  }
  if (
    !isRecord(fixture.fixedTemplate) ||
    fixture.fixedTemplate.version !== FIXED_TEMPLATE_VERSION ||
    fixture.fixedTemplate.ref !== FIXED_TEMPLATE_REF
  ) {
    errors.push(
      `fixture.fixedTemplate must be { version: ${FIXED_TEMPLATE_VERSION}, ref: ${FIXED_TEMPLATE_REF} }`,
    );
  }
  validateRoute(fixture.route, errors);
  const canaryIds = validateCanaries(fixture.canaries, errors);
  if (!Array.isArray(fixture.excludedNegatives)) {
    errors.push(
      "fixture.excludedNegatives must be an array (empty when nothing is excluded)",
    );
  } else {
    for (const [index, row] of fixture.excludedNegatives.entries()) {
      if (
        !isRecord(row) ||
        !nonEmpty(row.caseId) ||
        !nonEmpty(row.negative) ||
        !nonEmpty(row.reason)
      ) {
        errors.push(
          `fixture.excludedNegatives[${index}] needs caseId, negative and reason`,
        );
      }
    }
  }
  if (
    !Array.isArray(fixture.cases) ||
    fixture.cases.length !== DPH_CASE_IDS.length
  ) {
    errors.push(
      `fixture.cases must contain exactly ${DPH_CASE_IDS.join(", ")}`,
    );
    return errors;
  }
  const ctx = {
    template,
    route: isRecord(fixture.route) ? fixture.route : {},
    canaries: Array.isArray(fixture.canaries)
      ? fixture.canaries.filter(isRecord)
      : [],
    canaryIds,
    variantIds: new Set(),
    isolation: {
      workspaceId: new Set(),
      conversationId: new Set(),
      artifactNamespace: new Set(),
    },
  };
  for (const [index, testCase] of fixture.cases.entries()) {
    validateCase(testCase, index, ctx, errors);
  }
  checkCaseSeparation(fixture.cases, errors);
  checkBindingCoverage(fixture, errors);
  checkLogicalIdIsolation(fixture.cases, errors);
  validateDiagnosticCases(fixture.diagnosticCases, fixture.cases, errors);
  return errors;
}

// ------------------------------------------------------------------- review

export function validateReviewRecord(review, { fixtureSha256, fixture } = {}) {
  const errors = [];
  if (!isRecord(review)) return ["review record must be an object"];
  if (review.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    errors.push(`review.schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!["approve", "changes-required"].includes(review.verdict)) {
    errors.push("review.verdict must be approve or changes-required");
  }
  const reviewer = review.reviewer;
  if (!isRecord(reviewer)) {
    errors.push("review.reviewer must be an object");
  } else {
    if (!nonEmpty(reviewer.agent))
      errors.push("review.reviewer.agent is required");
    if (!nonEmpty(reviewer.model))
      errors.push("review.reviewer.model is required");
    if (reviewer.distinctFromFixtureAuthor !== true) {
      errors.push("review.reviewer must be distinct from the fixture author");
    }
    if (reviewer.distinctFromImplementers !== true) {
      errors.push(
        "review.reviewer must be distinct from the harness implementers",
      );
    }
    if (reviewer.readOnly !== true)
      errors.push("review.reviewer must be read-only");
    if (reviewer.nativeOutputObserved !== false) {
      errors.push("review.reviewer must not have observed Native output");
    }
  }
  if (!SHA256_PATTERN.test(review.fixtureSha256 ?? "")) {
    errors.push(
      "review.fixtureSha256 must be the sha256 of the reviewed fixture",
    );
  } else if (fixtureSha256 && review.fixtureSha256 !== fixtureSha256) {
    errors.push(
      "review.fixtureSha256 differs from the fixture bytes (the fixture changed after the review)",
    );
  }
  if (!Array.isArray(review.requiredChanges)) {
    errors.push("review.requiredChanges must be an array");
  }
  const cases = Array.isArray(review.cases) ? review.cases : [];
  if (review.verdict === APPROVING_VERDICT) {
    if (
      Array.isArray(review.requiredChanges) &&
      review.requiredChanges.length > 0
    ) {
      errors.push("an approving review must leave no required change");
    }
    const expectedIds = fixture
      ? fixture.cases.map((testCase) => testCase.caseId)
      : DPH_CASE_IDS;
    if (cases.map((row) => row?.caseId).join(",") !== expectedIds.join(",")) {
      errors.push("an approving review must cover every fixture case in order");
    }
    for (const row of cases) {
      if (row?.verdict !== APPROVING_VERDICT) {
        errors.push(`an approving review does not approve ${row?.caseId}`);
      }
    }
  }
  return errors;
}

// ------------------------------------------------------------------- freeze

/** Tokens of an expected selection: the Raw text plus every codex entry (estimator applied by hand). */
function expectedSelectedTokens(expected) {
  let total = nonEmpty(expected?.rawText)
    ? estimateTokens(expected.rawText)
    : 0;
  for (const entry of expected?.codexEntries ?? []) {
    if (typeof entry?.text === "string")
      total += estimateTemplateTokens(entry.text);
  }
  return total;
}

/**
 * The freeze record's per-request budget table must be the fixture's, row for
 * row: one row per positive request (`stage` defaults to 1), the fixture's
 * contextBudgetTokens, and selectedTokens recomputed from the expected
 * material, so the reviewer-checked figures cannot drift from the fixture.
 */
function checkPerRequestAgainstFixture(perRequest, fixture, errors) {
  const wanted = new Map();
  for (const testCase of fixture.cases) {
    for (const variant of testCase?.variants ?? []) {
      const requests = variantRequests(variant);
      for (const [index, request] of requests.entries()) {
        if (variant.kind === "reject" && index === requests.length - 1)
          continue;
        wanted.set(`${testCase.caseId}/${variant.variantId}/${request.stage}`, {
          budget: request.expected?.contextBudgetTokens,
          selected: expectedSelectedTokens(request.expected),
        });
      }
    }
  }
  const seen = new Set();
  for (const row of perRequest) {
    if (!isRecord(row)) continue;
    const stage = row.stage === undefined ? 1 : row.stage;
    const key = `${row.caseId}/${row.variantId}/${stage}`;
    if (seen.has(key)) {
      errors.push(
        `freeze.contextBudget.perRequest lists ${key} more than once`,
      );
      continue;
    }
    seen.add(key);
    const expected = wanted.get(key);
    if (!expected) {
      errors.push(
        `freeze.contextBudget.perRequest row ${key} is not a positive request of the fixture`,
      );
      continue;
    }
    if (row.contextBudgetTokens !== expected.budget) {
      errors.push(
        `freeze.contextBudget.perRequest ${key} contextBudgetTokens differs from the fixture (${expected.budget})`,
      );
    }
    if (row.selectedTokens !== expected.selected) {
      errors.push(
        `freeze.contextBudget.perRequest ${key} selectedTokens differs from the expected material (${expected.selected})`,
      );
    }
  }
  for (const key of wanted.keys()) {
    if (!seen.has(key)) {
      errors.push(
        `freeze.contextBudget.perRequest has no row for the fixture request ${key}`,
      );
    }
  }
}

function checkBoundFile(entry, label, errors) {
  if (
    !isRecord(entry) ||
    !nonEmpty(entry.path) ||
    !SHA256_PATTERN.test(entry.sha256 ?? "")
  ) {
    errors.push(`${label} must be { path, sha256 }`);
    return false;
  }
  const normalized = path.posix.normalize(entry.path);
  if (
    path.isAbsolute(entry.path) ||
    normalized !== entry.path ||
    normalized.startsWith("../")
  ) {
    errors.push(`${label}.path must be a repository path`);
    return false;
  }
  return true;
}

/**
 * Schema and consistency errors of a freeze record. `bytes` maps a repository
 * path to the file's current bytes (the caller reads them) so the sha256
 * bindings are checked against what is on disk now.
 */
export function validateFreezeRecord(
  freeze,
  { bytes, review, reviewErrors, fixture } = {},
) {
  const errors = [];
  if (!isRecord(freeze)) return ["freeze record must be an object"];
  if (freeze.schemaVersion !== FREEZE_SCHEMA_VERSION) {
    errors.push(`freeze.schemaVersion must be ${FREEZE_SCHEMA_VERSION}`);
  }
  if (freeze.contractId !== CONTRACT_ID)
    errors.push(`freeze.contractId must be ${CONTRACT_ID}`);
  if (freeze.draftRef !== DRAFT_REF)
    errors.push(`freeze.draftRef must be ${DRAFT_REF}`);
  if (freeze.fixtureVersion !== 1)
    errors.push("freeze.fixtureVersion must be 1");
  if (!Object.values(FREEZE_STATUS).includes(freeze.status)) {
    errors.push(
      `freeze.status must be ${Object.values(FREEZE_STATUS).join(" or ")}`,
    );
  }
  if (freeze.nativeOutputObservedBeforeFreeze !== false) {
    errors.push("freeze.nativeOutputObservedBeforeFreeze must be false");
  }
  if (!FROZEN_AT_PATTERN.test(freeze.frozenAt ?? "")) {
    errors.push("freeze.frozenAt must be a UTC timestamp");
  }

  const bound = new Map();
  const bind = (entry, label, expectedPath) => {
    if (!checkBoundFile(entry, label, errors)) return;
    if (expectedPath && entry.path !== expectedPath) {
      errors.push(`${label}.path must be ${expectedPath}`);
    }
    bound.set(entry.path, entry.sha256);
  };
  bind(freeze.fixture, "freeze.fixture", FIXTURE_PATH);
  bind(freeze.reviewRecord, "freeze.reviewRecord", REVIEW_PATH);
  // A frozen record binds the README and the baseline parity vector as well:
  // a vector rewritten after the observation would otherwise go unnoticed.
  for (const [key, expectedPath] of [
    ["readme", README_PATH],
    ["parityVector", PARITY_VECTOR_PATH],
  ]) {
    if (freeze[key] !== undefined)
      bind(freeze[key], `freeze.${key}`, expectedPath);
    else if (freeze.status === FREEZE_STATUS.frozen)
      errors.push(`a frozen record must bind freeze.${key} (${expectedPath})`);
  }
  const scorerFiles = Array.isArray(freeze.scorer?.files)
    ? freeze.scorer.files
    : [];
  if (!Array.isArray(freeze.scorer?.files))
    errors.push("freeze.scorer.files must be an array");
  for (const [index, entry] of scorerFiles.entries()) {
    bind(entry, `freeze.scorer.files[${index}]`);
  }
  for (const required of SCORER_FILES) {
    if (!scorerFiles.some((entry) => entry?.path === required)) {
      errors.push(`freeze.scorer.files must bind ${required}`);
    }
  }
  // A path listed twice would bind only the later sha256 and leave the other
  // row unchecked.
  const seenScorerPaths = new Set();
  for (const entry of scorerFiles) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    if (seenScorerPaths.has(entry.path)) {
      errors.push(`freeze.scorer.files lists ${entry.path} more than once`);
    }
    seenScorerPaths.add(entry.path);
  }
  if (bytes) {
    for (const [file, digest] of bound) {
      const content = bytes.get(file);
      if (content === undefined)
        errors.push(`freeze binds ${file}, which is missing`);
      else if (sha256(content) !== digest)
        errors.push(`freeze sha256 for ${file} differs from the file`);
    }
  }

  const budget = freeze.contextBudget;
  if (!isRecord(budget)) {
    errors.push("freeze.contextBudget must be an object");
  } else {
    if (!nonEmpty(budget.formula))
      errors.push("freeze.contextBudget.formula is required");
    if (!isRecord(budget.terms))
      errors.push("freeze.contextBudget.terms must be an object");
    if (!Array.isArray(budget.perRequest) || budget.perRequest.length === 0) {
      errors.push("freeze.contextBudget.perRequest must be a non-empty array");
    } else {
      for (const [index, row] of budget.perRequest.entries()) {
        const label = `freeze.contextBudget.perRequest[${index}]`;
        if (
          !isRecord(row) ||
          !nonEmpty(row.caseId) ||
          !nonEmpty(row.variantId)
        ) {
          errors.push(`${label} needs caseId and variantId`);
          continue;
        }
        for (const key of [
          "contextBudgetTokens",
          "selectedTokens",
          "marginTokens",
        ]) {
          if (!Number.isInteger(row[key]) || row[key] < 0) {
            errors.push(`${label}.${key} must be a non-negative integer`);
          }
        }
        if (
          Number.isInteger(row.contextBudgetTokens) &&
          Number.isInteger(row.selectedTokens) &&
          Number.isInteger(row.marginTokens) &&
          row.contextBudgetTokens - row.selectedTokens !== row.marginTokens
        ) {
          errors.push(
            `${label}.marginTokens must be contextBudgetTokens - selectedTokens`,
          );
        }
      }
      if (isRecord(fixture) && Array.isArray(fixture.cases)) {
        checkPerRequestAgainstFixture(budget.perRequest, fixture, errors);
      }
    }
  }

  const separation = freeze.authorSeparation;
  if (!isRecord(separation)) {
    errors.push("freeze.authorSeparation must be an object");
  } else {
    const author = separation.fixtureAuthor?.agent;
    const reviewer = separation.expectationReviewer?.agent;
    const implementers = separation.harnessImplementers;
    if (!nonEmpty(author))
      errors.push("freeze.authorSeparation.fixtureAuthor.agent is required");
    if (!nonEmpty(reviewer))
      errors.push(
        "freeze.authorSeparation.expectationReviewer.agent is required",
      );
    if (
      !Array.isArray(implementers) ||
      implementers.length === 0 ||
      implementers.some((name) => !nonEmpty(name))
    ) {
      errors.push(
        "freeze.authorSeparation.harnessImplementers must list the implementers",
      );
    } else {
      if (implementers.includes(author))
        errors.push("the fixture author must not be a harness implementer");
      if (implementers.includes(reviewer))
        errors.push(
          "the expectation reviewer must not be a harness implementer",
        );
    }
    if (nonEmpty(author) && author === reviewer) {
      errors.push(
        "the fixture author and the expectation reviewer must differ",
      );
    }
    if (
      isRecord(review) &&
      isRecord(review.reviewer) &&
      nonEmpty(reviewer) &&
      review.reviewer.agent !== reviewer
    ) {
      errors.push(
        "freeze.authorSeparation.expectationReviewer.agent differs from the review record's reviewer.agent",
      );
    }
    if (separation.nativeReceiptProvidedToAuthor !== false) {
      errors.push(
        "freeze.authorSeparation.nativeReceiptProvidedToAuthor must be false",
      );
    }
  }

  if (freeze.status === FREEZE_STATUS.frozen) {
    if (freeze.reviewVerdict !== APPROVING_VERDICT) {
      errors.push("a frozen record requires reviewVerdict approve");
    }
    if (review === undefined) {
      errors.push("a frozen record requires its review record");
    } else if (review.verdict !== APPROVING_VERDICT) {
      errors.push("a frozen record requires an approving review record");
    }
    if (reviewErrors && reviewErrors.length > 0) {
      errors.push("a frozen record requires a valid review record");
    }
  }
  return errors;
}

// --------------------------------------------------------------------- git

function runGit(repoRoot, args, execFile = execFileSync) {
  return execFile("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
}

/**
 * True when `ancestor` is an ancestor of (or equal to) `descendant`. Runs one
 * synchronous `git merge-base --is-ancestor` (exit status 0 = yes, 1 = no).
 * Any other failure (unknown commit, git missing, timeout) throws, so an
 * unverifiable order is never read as "yes".
 */
export function isAncestorCommit(
  repoRoot,
  ancestor,
  descendant,
  { execFile } = {},
) {
  for (const [name, value] of [
    ["ancestor", ancestor],
    ["descendant", descendant],
  ]) {
    if (!COMMIT_PATTERN.test(value ?? "")) {
      throw new TypeError(`${name} must be a full commit id`);
    }
  }
  try {
    runGit(
      repoRoot,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      execFile,
    );
    return true;
  } catch (error) {
    if (error?.status === 1 && !error.signal) return false;
    throw error;
  }
}

/**
 * The harness precondition (draft: 作者の分離と freeze の順序): the freeze
 * record's commit must be an ancestor of every commit that ran Native on the
 * fixture's material. Returns errors; an unverifiable order is an error.
 */
export function verifyFreezeOrder({
  repoRoot,
  freezeCommit,
  runCommits,
  execFile,
}) {
  const errors = [];
  if (!COMMIT_PATTERN.test(freezeCommit ?? "")) {
    return ["freeze commit must be a full commit id"];
  }
  const distinct = [...new Set(runCommits ?? [])];
  if (distinct.length === 0) return ["at least one run commit is required"];
  for (const commit of distinct) {
    try {
      if (!isAncestorCommit(repoRoot, freezeCommit, commit, { execFile })) {
        errors.push(
          `freeze commit ${freezeCommit} is not an ancestor of run commit ${commit}`,
        );
      }
    } catch (error) {
      errors.push(
        `freeze order for run commit ${commit} could not be verified: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------- frozen snapshot

/** Most commits that may have touched the freeze record before it is treated as unverifiable. */
const MAX_FREEZE_RECORD_COMMITS = 16;
const GIT_SHOW_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Bytes of `file` at `commit` (`git show <commit>:<file>`, one synchronous
 * bounded child, no shell), or `undefined` when the path does not exist at that
 * commit. Any other failure throws: an unreadable snapshot is never "unchanged".
 */
export function gitFileAtCommit(repoRoot, commit, file, { execFile } = {}) {
  if (!COMMIT_PATTERN.test(commit ?? "")) {
    throw new TypeError("commit must be a full commit id");
  }
  try {
    return (execFile ?? execFileSync)("git", ["show", `${commit}:${file}`], {
      cwd: repoRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_SHOW_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (
      error?.status === 128 &&
      /does not exist in|exists on disk, but not in/.test(stderr)
    ) {
      return undefined;
    }
    throw error;
  }
}

function parseJsonBytes(bytes) {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derives the freeze commit from history instead of trusting a caller: the
 * oldest commit reachable from `runCommit` whose version of the freeze record
 * has `status: "frozen"`. (`git log --reverse` over the record's path, then
 * `git show` of the record at each commit, capped at
 * MAX_FREEZE_RECORD_COMMITS.) Returns `{ commit }` or `{ error }`.
 */
export function deriveFreezeCommit({ repoRoot, runCommit, execFile }) {
  if (!COMMIT_PATTERN.test(runCommit ?? "")) {
    return { error: "run commit must be a full commit id" };
  }
  let listing;
  try {
    listing = runGit(
      repoRoot,
      ["log", "--reverse", "--format=%H", runCommit, "--", FREEZE_PATH],
      execFile,
    );
  } catch (error) {
    return {
      error: `freeze record history could not be read: ${firstLine(error)}`,
    };
  }
  const commits = String(listing)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length === 0) {
    return { error: `no commit before ${runCommit} holds ${FREEZE_PATH}` };
  }
  if (commits.length > MAX_FREEZE_RECORD_COMMITS) {
    return {
      error: `the freeze record was touched by ${commits.length} commits (more than ${MAX_FREEZE_RECORD_COMMITS}); it must be written once, when it is frozen`,
    };
  }
  for (const commit of commits) {
    let bytes;
    try {
      bytes = gitFileAtCommit(repoRoot, commit, FREEZE_PATH, { execFile });
    } catch (error) {
      return {
        error: `freeze record at ${commit} could not be read: ${firstLine(error)}`,
      };
    }
    const record = bytes === undefined ? undefined : parseJsonBytes(bytes);
    if (record?.status === FREEZE_STATUS.frozen) return { commit };
  }
  return { error: "no commit holds a frozen freeze record" };
}

function firstLine(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

/**
 * Verifies that what a run used is what was frozen. The freeze record, the
 * fixture, the expectation review, the README, the parity vector and the four
 * scorer modules at the run commit must be byte-identical to the same files at
 * the freeze commit, and the freeze record at that commit must bind their
 * sha256 and validate as frozen. The freeze commit is derived from history
 * (`deriveFreezeCommit`), not reported by the caller; `expectedFreezeCommit`,
 * when given (a receipt's `freeze.commit`), must equal it.
 *
 * A run commit equal to the freeze commit is accepted: the record is already
 * committed when Native runs on that commit, so nothing was observed before
 * the freeze (`git merge-base --is-ancestor` also treats a commit as its own
 * ancestor).
 *
 * Returns `{ errors, freezeCommit }`; an unverifiable snapshot is an error.
 */
export function verifyFrozenSnapshot({
  repoRoot,
  runCommit,
  expectedFreezeCommit,
  execFile,
}) {
  const derived = deriveFreezeCommit({ repoRoot, runCommit, execFile });
  if (derived.error)
    return { errors: [derived.error], freezeCommit: undefined };
  const freezeCommit = derived.commit;
  const errors = [];
  if (
    expectedFreezeCommit !== undefined &&
    expectedFreezeCommit !== freezeCommit
  ) {
    errors.push(
      `freeze commit ${expectedFreezeCommit} is not the first commit that held the frozen record (${freezeCommit})`,
    );
  }
  errors.push(
    ...verifyFreezeOrder({
      repoRoot,
      freezeCommit,
      runCommits: [runCommit],
      execFile,
    }),
  );
  const read = (commit, file) => {
    try {
      return gitFileAtCommit(repoRoot, commit, file, { execFile });
    } catch (error) {
      errors.push(
        `${file} at ${commit} could not be read: ${firstLine(error)}`,
      );
      return undefined;
    }
  };
  const recordAtFreeze = read(freezeCommit, FREEZE_PATH);
  const recordAtRun = read(runCommit, FREEZE_PATH);
  const freeze =
    recordAtFreeze === undefined ? undefined : parseJsonBytes(recordAtFreeze);
  if (!freeze) {
    errors.push(`the freeze record at ${freezeCommit} is not a JSON object`);
    return { errors, freezeCommit };
  }
  if (
    recordAtRun === undefined ||
    sha256(recordAtRun) !== sha256(recordAtFreeze)
  ) {
    errors.push(
      "the freeze record at the run commit differs from the record at the freeze commit (it was changed after it was frozen)",
    );
  }
  const bound = [
    freeze.fixture,
    freeze.reviewRecord,
    freeze.readme,
    freeze.parityVector,
    ...(Array.isArray(freeze.scorer?.files) ? freeze.scorer.files : []),
  ].filter((entry) => isRecord(entry) && nonEmpty(entry.path));
  const atFreeze = new Map();
  for (const entry of bound) {
    const frozenBytes = read(freezeCommit, entry.path);
    const runBytes = read(runCommit, entry.path);
    if (frozenBytes === undefined) {
      errors.push(`${entry.path} does not exist at the freeze commit`);
      continue;
    }
    atFreeze.set(entry.path, frozenBytes);
    if (runBytes === undefined || sha256(runBytes) !== sha256(frozenBytes)) {
      errors.push(
        `${entry.path} at the run commit differs from the frozen bytes (it was changed after the freeze)`,
      );
    }
  }
  // The record, read as it stood at the freeze commit, must validate as frozen
  // against the bytes it was frozen with.
  const reviewBytes = atFreeze.get(REVIEW_PATH);
  const review =
    reviewBytes === undefined ? undefined : parseJsonBytes(reviewBytes);
  const fixtureBytes = atFreeze.get(FIXTURE_PATH);
  const fixture =
    fixtureBytes === undefined ? undefined : parseJsonBytes(fixtureBytes);
  const reviewErrors = review
    ? validateReviewRecord(review, {
        fixtureSha256: fixtureBytes ? sha256(fixtureBytes) : undefined,
        fixture:
          Array.isArray(fixture?.cases) &&
          fixture.cases.length === DPH_CASE_IDS.length
            ? fixture
            : undefined,
      })
    : ["the review record is missing or not JSON at the freeze commit"];
  errors.push(
    ...validateFreezeRecord(freeze, {
      bytes: atFreeze,
      review,
      reviewErrors,
      fixture: Array.isArray(fixture?.cases) ? fixture : undefined,
    }).map((message) => `freeze record at ${freezeCommit}: ${message}`),
    ...reviewErrors.map(
      (message) => `review record at ${freezeCommit}: ${message}`,
    ),
  );
  return { errors, freezeCommit };
}

// -------------------------------------------------------- repo-level report

/**
 * The state `pnpm eval:fixtures` reports. `not-placed` (no fixture file yet,
 * before DPH-2 merges) is a status, not an error; once a fixture exists it is
 * validated in full. No Native output and no git history are read here.
 */
export async function validateNir1FinalRequestFixtures({ repoRoot }) {
  const errors = [];
  const read = (relative) => readFile(path.join(repoRoot, relative));
  const present = {
    fixture: await exists(path.join(repoRoot, FIXTURE_PATH)),
    freeze: await exists(path.join(repoRoot, FREEZE_PATH)),
    review: await exists(path.join(repoRoot, REVIEW_PATH)),
  };
  if (!present.fixture) {
    for (const key of ["freeze", "review"]) {
      if (present[key]) {
        errors.push(
          `nir1-final-request ${key} record exists without ${FIXTURE_PATH}`,
        );
      }
    }
    return {
      status: "not-placed",
      fixturePath: FIXTURE_PATH,
      errors,
      cases: [],
      freeze: { status: "not-placed" },
    };
  }

  const fixtureBytes = await read(FIXTURE_PATH);
  let fixture;
  try {
    fixture = JSON.parse(fixtureBytes);
  } catch {
    return {
      status: "invalid",
      fixturePath: FIXTURE_PATH,
      errors: ["nir1-final-request fixture is not JSON"],
      cases: [],
      freeze: { status: "invalid" },
    };
  }
  if (!isRecord(fixture)) {
    return {
      status: "invalid",
      fixturePath: FIXTURE_PATH,
      errors: ["nir1-final-request fixture must be a JSON object"],
      cases: [],
      freeze: { status: "invalid" },
    };
  }
  const template = await loadFixedTemplate(repoRoot);
  errors.push(
    ...validateFinalRequestFixture(fixture, { template }).map(
      (e) => `nir1-final-request fixture: ${e}`,
    ),
  );
  const cases = Array.isArray(fixture.cases)
    ? fixture.cases.map((testCase) => ({
        caseId: testCase?.caseId,
        variants: Array.isArray(testCase?.variants)
          ? testCase.variants.length
          : 0,
      }))
    : [];

  let review;
  let reviewErrors = [];
  if (present.review) {
    try {
      review = JSON.parse(await read(REVIEW_PATH));
      reviewErrors = validateReviewRecord(review, {
        fixtureSha256: sha256(fixtureBytes),
        fixture:
          Array.isArray(fixture.cases) &&
          fixture.cases.length === DPH_CASE_IDS.length
            ? fixture
            : undefined,
      });
      errors.push(
        ...reviewErrors.map((e) => `nir1-final-request review: ${e}`),
      );
    } catch {
      errors.push("nir1-final-request review record is not JSON");
    }
  }
  if (!present.freeze) {
    return {
      status: errors.length === 0 ? "pending-review" : "invalid",
      fixturePath: FIXTURE_PATH,
      fixtureSha256: sha256(fixtureBytes),
      errors,
      cases,
      freeze: { status: "pending-review" },
    };
  }

  let freeze;
  try {
    freeze = JSON.parse(await read(FREEZE_PATH));
  } catch {
    errors.push("nir1-final-request freeze record is not JSON");
    return {
      status: "invalid",
      fixturePath: FIXTURE_PATH,
      errors,
      cases,
      freeze: { status: "invalid" },
    };
  }
  if (!isRecord(freeze)) {
    errors.push("nir1-final-request freeze record must be a JSON object");
    return {
      status: "invalid",
      fixturePath: FIXTURE_PATH,
      errors,
      cases,
      freeze: { status: "invalid" },
    };
  }
  const bytes = new Map([[FIXTURE_PATH, fixtureBytes]]);
  const wanted = [
    REVIEW_PATH,
    README_PATH,
    PARITY_VECTOR_PATH,
    ...SCORER_FILES,
    ...(Array.isArray(freeze?.scorer?.files)
      ? freeze.scorer.files.map((entry) => entry?.path)
      : []),
  ];
  for (const file of wanted) {
    if (typeof file !== "string" || bytes.has(file)) continue;
    try {
      bytes.set(file, await read(file));
    } catch {
      // A missing bound file is reported by the freeze validation below.
    }
  }
  errors.push(
    ...validateFreezeRecord(freeze, {
      bytes,
      review,
      reviewErrors,
      fixture: Array.isArray(fixture.cases) ? fixture : undefined,
    }).map((e) => `nir1-final-request freeze: ${e}`),
  );
  return {
    status: errors.length === 0 ? freeze.status : "invalid",
    fixturePath: FIXTURE_PATH,
    fixtureSha256: sha256(fixtureBytes),
    errors,
    cases,
    freeze: {
      status: errors.length === 0 ? freeze.status : "invalid",
      path: FREEZE_PATH,
      frozenAt: freeze?.frozenAt,
      reviewVerdict: freeze?.reviewVerdict,
    },
  };
}
