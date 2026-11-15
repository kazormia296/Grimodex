// CP-4 quality verdict v3: the receipt fields the four evidence items read, how
// node makes them from what the page returned (a hash of the plain text, never
// the text), and the rule that refuses a receipt carrying plain text
// (prereg v3 §4, Q6: ranges, hashes and IDs only).
//
// Pure module: no file or process access. Field names are the S2 addendum's
// choice (prereg v3 §5 left them to it); the definitions are v3's.
//
//   followUp.parent / followUp.child
//     evidence    { graphOnly, pathAttachments }
//                   graphOnly   null | { sceneId, hop, pinEntityId,
//                                 canonicalRange{start,end}, excerptSha256,
//                                 excerptUtf16Length, edges[] }
//                   pathAttachments [{ sceneId, hop, edges[] }]
//                   edges[]     [{ from, to, evidence:[{evidenceId,quoteSha256}] }]
//     rowExcerpts [{ sceneId, kind: raw|ir|graph-only, excerptSha256,
//                    excerptUtf16Length }]
//   receipt.evidenceObservation (Gold; read once after the samples)
//     { readAfterSamples, samplesBeforeRead, typedRevisions: [{
//         logicalRevisionId, runtimeRevisionId,
//         evidence:[{evidenceId,sourceRef,startUtf16,endUtf16,quoteSha256}]
//         | unavailable }] }

import { createHash } from "node:crypto";

/** sha256 of the UTF-8 bytes of a JS string (the verdict's `textSha256`). */
export function sha256Text(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * The hash and the length of a text the page returned. A value that is not a
 * string (a field the page did not return) is `null`, never the hash of an
 * empty text: the verdict holds on a `null`, and a made-up `sha256("")` would
 * read as a measured value (prereg v3 §2.0 hold).
 */
const hashOf = (text) => (typeof text === "string" ? sha256Text(text) : null);
const lengthOf = (text) => (typeof text === "string" ? text.length : null);
/** `undefined` (a field the page did not return) is a `null` in the receipt. */
const orNull = (value) => (value === undefined ? null : value);

// ---------------------------------------------------------------------------
// node side: the page's plain values → hashes (the plain text is dropped here)

function hashEdges(list) {
  return (Array.isArray(list) ? list : []).map((edge) => ({
    from: orNull(edge?.from?.entityId),
    to: orNull(edge?.to?.entityId),
    evidence: (Array.isArray(edge?.evidence) ? edge.evidence : []).map(
      (row) => ({
        evidenceId: orNull(row?.evidenceId),
        quoteSha256: hashOf(row?.quote),
      }),
    ),
  }));
}

/**
 * The page's `evidenceRaw` of one fetch (the Graph payload's rows with the
 * Graph-only excerpt and the edges' quotes in clear) as the receipt's
 * `evidence`. `null` when the fetch had no Graph.
 */
export function hashGraphEvidence(raw) {
  if (!raw) return null;
  const only = raw.graphOnly;
  return {
    graphOnly: only
      ? {
          sceneId: orNull(only.sceneId),
          hop: orNull(only.hop),
          pinEntityId: orNull(only.pinEntityId),
          canonicalRange: {
            start: orNull(only.canonicalRange?.start),
            end: orNull(only.canonicalRange?.end),
          },
          excerptSha256: hashOf(only.excerpt),
          excerptUtf16Length: lengthOf(only.excerpt),
          edges: hashEdges(only.edges),
        }
      : null,
    pathAttachments: (Array.isArray(raw.pathAttachments)
      ? raw.pathAttachments
      : []
    ).map((row) => ({
      sceneId: orNull(row?.sceneId),
      hop: orNull(row?.hop),
      edges: hashEdges(row?.edges),
    })),
  };
}

/** The page's `rowTexts` of one fetch as the receipt's `rowExcerpts`. */
export function hashRowTexts(rows) {
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => ({
    sceneId: orNull(row?.sceneId),
    kind: orNull(row?.kind),
    excerptSha256: hashOf(row?.text),
    excerptUtf16Length: lengthOf(row?.text),
  }));
}

const SOURCE_REF = /^[A-Za-z0-9._:/-]{1,200}$/u;

/**
 * One typed Revision's read (`nir1_entity_relation_revision_read`, the page's
 * `{ ok, value }`) as an `evidenceObservation.typedRevisions` row: every
 * Entity's Evidence rows with the quote replaced by its sha256 and the range
 * kept. A read that did not answer is `unavailable` (a fixed word, never the
 * error text).
 */
export function hashRevisionRead({
  logicalRevisionId,
  runtimeRevisionId,
  read,
}) {
  const head = { logicalRevisionId, runtimeRevisionId };
  const response = read?.ok === true ? read.value : null;
  if (response?.status !== "available")
    return {
      ...head,
      unavailable: read?.ok === true ? "unavailable" : "read-failed",
    };
  const entities = Array.isArray(response.result?.entities)
    ? response.result.entities
    : [];
  return {
    ...head,
    evidence: entities.flatMap((entity) =>
      (Array.isArray(entity?.evidence) ? entity.evidence : []).map((row) => ({
        evidenceId: orNull(row?.evidenceId),
        sourceRef:
          row?.sourceRef == null
            ? null
            : typeof row.sourceRef === "string" &&
                SOURCE_REF.test(row.sourceRef)
              ? row.sourceRef
              : "unrepresentable",
        startUtf16: orNull(row?.startUtf16),
        endUtf16: orNull(row?.endUtf16),
        quoteSha256: hashOf(row?.quote),
      })),
    ),
  };
}

/**
 * The fetch with the page-only plain fields replaced by their hashes:
 * `evidenceRaw` → `evidence`, `rowTexts` → `rowExcerpts`. A fetch that has
 * neither (a trace probe's, an older one) is returned as it is.
 */
export function hashFetchEvidence(fetch) {
  if (fetch?.evidenceRaw === undefined && fetch?.rowTexts === undefined)
    return fetch;
  const { evidenceRaw, rowTexts, ...rest } = fetch;
  return {
    ...rest,
    ...(evidenceRaw !== undefined
      ? { evidence: hashGraphEvidence(evidenceRaw) }
      : {}),
    ...(rowTexts !== undefined ? { rowExcerpts: hashRowTexts(rowTexts) } : {}),
  };
}

// ---------------------------------------------------------------------------
// receipt side: the shape of the new fields, and plain text

const HEX64 = /^[0-9a-f]{64}$/u;
const ID_SHAPE = /^[A-Za-z0-9._:/-]{1,200}$/u;
const uint = (value) => Number.isSafeInteger(value) && value >= 0;
const hex = (value) => typeof value === "string" && HEX64.test(value);
const id = (value) => typeof value === "string" && ID_SHAPE.test(value);
const rowKinds = ["raw", "ir", "graph-only"];

/**
 * A key as it may appear in an error message: an identifier-like key as it is,
 * any other (a key that is itself a text) as `[key#<position>]`. The messages
 * are written to the run report and the validation file, so they never carry
 * a text the receipt was refused for.
 */
function keyForMessage(key, index) {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(key) ? key : `[key#${index}]`;
}

/**
 * Key → value check of the new fields. A key outside a record's own list, or
 * a value outside its shape (an integer, a 64-hex, an ID, a fixed word, a
 * boolean), is an error: a plain-text value cannot take any of these shapes
 * by accident (a text has spaces; a hash is 64 hex), and a key named `quote`,
 * `excerpt`, `body`, `text` or `summary` is never in a list. The match is on
 * the whole key: `excerptSha256` is a field of these records, not an
 * `excerpt`.
 */
const SHAPES = {
  evidence: {
    graphOnly: (v, at) => (v === null ? [] : check("graphOnly", v, at)),
    pathAttachments: (v, at) => list("pathAttachment", v, at),
  },
  graphOnly: {
    sceneId: id,
    hop: uint,
    pinEntityId: id,
    canonicalRange: (v, at) => check("range", v, at),
    excerptSha256: hex,
    excerptUtf16Length: uint,
    edges: (v, at) => list("edge", v, at),
  },
  range: { start: uint, end: uint },
  pathAttachment: {
    sceneId: id,
    hop: uint,
    edges: (v, at) => list("edge", v, at),
  },
  edge: {
    from: id,
    to: id,
    evidence: (v, at) => list("evidenceRow", v, at),
  },
  evidenceRow: { evidenceId: id, quoteSha256: hex },
  rowExcerpt: {
    sceneId: id,
    kind: (v) => rowKinds.includes(v),
    excerptSha256: hex,
    excerptUtf16Length: uint,
  },
  observation: {
    readAfterSamples: (v) => typeof v === "boolean",
    samplesBeforeRead: uint,
    typedRevisions: (v, at) => list("typedRevision", v, at),
  },
  typedRevision: {
    logicalRevisionId: id,
    runtimeRevisionId: id,
    evidence: (v, at) => list("readEvidence", v, at),
    unavailable: (v) => ["unavailable", "read-failed"].includes(v),
  },
  readEvidence: {
    evidenceId: id,
    sourceRef: id,
    startUtf16: uint,
    endUtf16: uint,
    quoteSha256: hex,
  },
};

function check(shape, value, at) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [`${at} must be an object`];
  const errors = [];
  const rules = SHAPES[shape];
  for (const [index, [key, child]] of Object.entries(value).entries()) {
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    const where = `${at}.${keyForMessage(key, index)}`;
    if (!rule) {
      errors.push(`${where} is not a field of the ${shape} record`);
      continue;
    }
    // A rule is a predicate (a leaf) or a checker that returns the errors.
    const result = rule(child, where);
    if (Array.isArray(result)) errors.push(...result);
    // `null` is a value of every leaf (a missing value the verdict holds on).
    else if (result !== true && child !== null)
      errors.push(`${where} does not have the shape of its value`);
  }
  return errors;
}

function list(shape, value, at) {
  if (!Array.isArray(value)) return [`${at} must be a list`];
  return value.flatMap((row, index) => check(shape, row, `${at}[${index}]`));
}

/** The errors of every new field of a receipt (shapes only; no fixture). */
export function evidenceFieldErrors(receipt) {
  const errors = [];
  // `null` is "not observed" (a negative run, a variant that does not read):
  // the verdict holds on it, and the shape check has nothing to look at. Only
  // a value that is there is checked (an `undefined` and a `null` are the
  // same absence).
  if (receipt?.evidenceObservation != null)
    errors.push(
      ...check(
        "observation",
        receipt.evidenceObservation,
        "evidenceObservation",
      ),
    );
  for (const [index, sample] of (receipt?.samples ?? []).entries())
    for (const side of ["parent", "child"]) {
      const record = sample?.followUp?.[side];
      if (!record || typeof record !== "object") continue;
      const at = `samples[${index}].followUp.${side}`;
      if (record.evidence !== undefined && record.evidence !== null)
        errors.push(...check("evidence", record.evidence, `${at}.evidence`));
      if (record.rowExcerpts !== undefined && record.rowExcerpts !== null)
        errors.push(
          ...list("rowExcerpt", record.rowExcerpts, `${at}.rowExcerpts`),
        );
    }
  return errors;
}

/**
 * The plain texts of a frozen fixture a receipt must never carry (prereg v3
 * §4 (ii)): every Scene body, the added Scene's `sceneExcerpt.body`, and every
 * Entity summary (a summary edit's before and after included). Labels are not
 * scanned: they are short and appear in IDs and existing fields. G-01's
 * fixture has no `variants`.
 */
export function plaintextNeedlesOf(fixture) {
  const needles = new Set();
  const add = (text) => {
    if (typeof text === "string" && text.length > 0) needles.add(text);
  };
  for (const row of fixture?.scenes ?? []) add(row?.body);
  for (const row of fixture?.entities ?? []) add(row?.summary);
  for (const row of [fixture?.entitySeed, fixture?.targetEntity])
    add(row?.summary);
  // A summary edit's before and after are Entity summaries; a relation-type
  // edit's are short type words that appear in IDs and existing fields.
  for (const row of fixture?.mutations ?? [])
    if (row?.kind === "codex-entry-summary-edit") {
      add(row.from);
      add(row.to);
    }
  add(fixture?.expectations?.sceneExcerpt?.body);
  for (const variant of fixture?.variants ?? [])
    add(variant?.expectations?.addedScene?.sceneExcerpt?.body);
  return [...needles];
}

/**
 * The page-only fields that carry plain text (`graphEvidenceOf`'s
 * `evidenceRaw`, `rowTextsOf`'s `rowTexts`): Node replaces them with their
 * hashes (`hashFetchEvidence`), so a key of this name anywhere in a receipt
 * means the plain value escaped the hashing.
 */
const PAGE_ONLY_KEYS = Object.freeze(["evidenceRaw", "rowTexts"]);

/**
 * Prereg v3 §4: the errors of a receipt that carries plain text. (ii) any
 * string anywhere in the receipt contains one of `needles` as a substring;
 * (iii) an Evidence JSON (an object with both `evidenceId` and `quote`)
 * appears anywhere; and a page-only plain field (`evidenceRaw`, `rowTexts`)
 * appears anywhere as a key, whatever its value. The shapes of the new fields
 * (i) are `evidenceFieldErrors`. `needles` is required: a caller that has
 * none cannot call the receipt clean (the key and Evidence-JSON checks still
 * run).
 */
export function plaintextErrors(receipt, needles) {
  const errors = [];
  const hasNeedles = Array.isArray(needles) && needles.length > 0;
  if (!hasNeedles)
    errors.push(
      "[precheck] the plain-text scan has no fixture texts to look for (the receipt cannot be called free of plain text)",
    );
  const stack = [{ node: receipt, at: "$" }];
  const seen = new Set();
  while (stack.length > 0) {
    const { node, at } = stack.pop();
    if (typeof node === "string") {
      if (hasNeedles)
        for (const needle of needles)
          if (node.includes(needle)) {
            errors.push(`${at} contains a fixture text in clear`);
            break;
          }
      continue;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (
      !Array.isArray(node) &&
      Object.hasOwn(node, "evidenceId") &&
      Object.hasOwn(node, "quote")
    )
      errors.push(`${at} is an Evidence record with its quote in clear`);
    for (const [index, [key, child]] of Object.entries(node).entries()) {
      const where = `${at}.${keyForMessage(key, index)}`;
      if (PAGE_ONLY_KEYS.includes(key))
        errors.push(`${where} is a page-only plain field (never hashed)`);
      // A key can carry text too (an object keyed by a text).
      if (hasNeedles && needles.some((needle) => key.includes(needle)))
        errors.push(`${where} (a key) contains a fixture text in clear`);
      stack.push({ node: child, at: where });
    }
  }
  return errors;
}
