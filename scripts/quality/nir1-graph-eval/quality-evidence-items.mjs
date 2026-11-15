// CP-4 quality verdict v3: the four evidence-validity items that v1 and v2 left
// `not-evaluable` (`utf16-range`, `explicit-pin-association`,
// `raw-excerpt-unchanged`, `added-scene-body-anchor`), judged on the hashes,
// ranges, lengths and IDs a v3 receipt carries.
//
// Pure module: no file or process access, no threshold. The definitions are
// fixed in docs/plans/nir1-cp4-records/quality-verdict-prereg-v3.md
// (contracts) before any value was observed; the section numbers below are
// that file's. The expectations come from the frozen fixtures only
// (`expectation.evidence`, built by quality-verdict-cli.mjs `loadExpectations`):
// never from a receipt's own values (the one exception is §2.3, a relative
// invariant read within one sample). No plain text, no excerpt and no Evidence
// JSON is ever an input: only sha256, UTF-16 ranges and lengths, and IDs (§4).

import { createHash } from "node:crypto";

export const EVIDENCE_ITEM_IDS = Object.freeze([
  "utf16-range",
  "explicit-pin-association",
  "raw-excerpt-unchanged",
  "added-scene-body-anchor",
]);

// fail > hold > pass (`n/a` and skipped samples never count).
const ORDER = ["fail", "hold", "pass"];
const HEX64 = /^[0-9a-f]{64}$/u;

function precheck(message) {
  return new Error(`[precheck] ${message}`);
}

/** The hash both sides use: sha256 of the UTF-8 bytes of a JS string. */
export function textSha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

const utf16Length = (text) => String(text).length;

function worst(statuses) {
  for (const status of ORDER) if (statuses.includes(status)) return status;
  return "n/a";
}

const isHex = (value) => typeof value === "string" && HEX64.test(value);
const isUint = (value) => Number.isSafeInteger(value) && value >= 0;
const isId = (value) => typeof value === "string" && value.length > 0;
const hold = (code, extra = {}) => ({ kind: "hold", code, ...extra });
const fail = (code, extra = {}) => ({ kind: "fail", code, ...extra });

function statusOfProblems(problems) {
  if (problems.some((entry) => entry.kind === "fail")) return "fail";
  if (problems.some((entry) => entry.kind === "hold")) return "hold";
  return "pass";
}

function oneToOne(map, label, runId) {
  if (!map || typeof map !== "object")
    throw precheck(`${runId}: logicalToRuntime.${label} is missing`);
  const forward = new Map(Object.entries(map));
  const reverse = new Map();
  for (const [logical, runtime] of forward) {
    if (reverse.has(runtime))
      throw precheck(`${runId}: logicalToRuntime.${label} is not one to one`);
    reverse.set(runtime, logical);
  }
  return { forward, reverse };
}

/** Lazily built maps of the receipt's logical → runtime IDs (v3 §2.0). */
function idMapsOf(receipt) {
  const ids = receipt?.settings?.setupReceipt?.logicalToRuntime;
  const runId = receipt?.runId;
  const cache = {};
  const get = (label) => {
    cache[label] ??= oneToOne(ids?.[label], label, runId);
    return cache[label];
  };
  return {
    entities: () => get("entities"),
    scenes: () => get("scenes"),
    logicalEntity(runtime) {
      const logical = get("entities").reverse.get(runtime);
      if (logical === undefined)
        throw precheck(
          `${runId}: entity ${String(runtime)} has no logical ID in logicalToRuntime`,
        );
      return logical;
    },
    runtimeEntity(logical) {
      const runtime = get("entities").forward.get(logical);
      if (runtime === undefined)
        throw precheck(
          `${runId}: logical entity ${String(logical)} has no runtime ID in logicalToRuntime`,
        );
      return runtime;
    },
    logicalScene(runtime) {
      const logical = get("scenes").reverse.get(runtime);
      if (logical === undefined)
        throw precheck(
          `${runId}: Scene ${String(runtime)} has no logical ID in logicalToRuntime`,
        );
      return logical;
    },
    runtimeScene(logical) {
      const runtime = get("scenes").forward.get(logical);
      if (runtime === undefined)
        throw precheck(
          `${runId}: logical Scene ${String(logical)} has no runtime ID in logicalToRuntime`,
        );
      return runtime;
    },
  };
}

/**
 * The display-side record of one sample, read as the edge binding reads it
 * (v3 §2.0 "表示側の記録"; v2 D6): a first-render through the parent, a
 * follow-up through its child. `null` kind `skip` is v1:54's "no child, or a
 * child that is not `graph-ready`"; `d8` is the skip that §2.3 counts as a
 * hold (the parent brought a Graph into the display without being counted).
 */
function sideOf(sample, result) {
  const followUp = sample.followUp;
  const record = result.firstRender ? followUp?.parent : followUp?.child;
  const outcome = result.firstRender
    ? sample.graph?.outcome
    : followUp?.child?.outcome;
  if (!record || outcome !== "graph-ready")
    return {
      kind: !result.displayed && result.parentContributed ? "d8" : "skip",
    };
  return {
    kind: "inspect",
    record,
    firstRender: result.firstRender === true,
    material: result.firstRender
      ? followUp.parent.contribution?.materialRevision
      : followUp.child.materialRevision,
  };
}

function pathsOf(evidence) {
  const out = [];
  if (evidence?.graphOnly)
    out.push({ kind: "graph-only", ...evidence.graphOnly });
  for (const row of Array.isArray(evidence?.pathAttachments)
    ? evidence.pathAttachments
    : [])
    out.push({ kind: "path-attachment", ...row });
  return out;
}

// ---------------------------------------------------------------------------
// §2.1 utf16-range

/**
 * The receipt's read-after-samples Evidence ranges as a map of logical
 * Revision ID to its rows (`evidenceId` → row) or `{ unavailable }`; or a
 * hold code when the observation is absent (§2.1 hold).
 */
function observationIndex(receipt) {
  const observation = receipt?.evidenceObservation;
  if (!observation || typeof observation !== "object")
    return { hold: "evidence-observation-missing" };
  if (observation.readAfterSamples !== true)
    return { hold: "evidence-observation-not-read-after-samples" };
  if (!Array.isArray(observation.typedRevisions))
    return { hold: "evidence-observation-malformed" };
  const index = new Map();
  for (const row of observation.typedRevisions) {
    if (!isId(row?.logicalRevisionId)) continue;
    if (!Array.isArray(row.evidence)) {
      index.set(row.logicalRevisionId, { unavailable: true });
      continue;
    }
    const rows = new Map();
    for (const entry of row.evidence)
      if (isId(entry?.evidenceId) && !rows.has(entry.evidenceId))
        rows.set(entry.evidenceId, entry);
    index.set(row.logicalRevisionId, { rows });
  }
  return { index };
}

function utf16RangeSample({ side, ctx }) {
  const { record, material } = side;
  const evidence = record.evidence;
  if (!evidence || typeof evidence !== "object")
    return { problems: [hold("evidence-field-missing")] };
  if (ctx.observation.hold) return { problems: [hold(ctx.observation.hold)] };
  const paths = pathsOf(evidence);
  if (paths.some((row) => !Array.isArray(row.edges)))
    return { problems: [hold("edge-evidence-field-missing")] };
  if (paths.reduce((sum, row) => sum + row.edges.length, 0) === 0)
    return { problems: [hold("no-displayed-edge")] };
  const problems = [];
  const disclosure = {
    rows: 0,
    fullRange: 0,
    notFullRange: 0,
    lengthOne: 0,
    sourceRefRows: new Map(),
  };
  const observed = Array.isArray(material?.observed) ? material.observed : [];
  for (const path of paths) {
    if (!isId(path.sceneId)) {
      problems.push(hold("path-scene-field-missing", { path: path.kind }));
      continue;
    }
    const logicalScene = ctx.maps.logicalScene(path.sceneId);
    const entry = observed.find(
      (row) => row?.kind === path.kind && row.sceneId === logicalScene,
    );
    if (!entry || !Array.isArray(entry.pairs)) {
      problems.push(hold("revision-of-path-unresolved", { path: path.kind }));
      continue;
    }
    const revisions = [
      ...new Set(entry.pairs.map((pair) => String(pair).split("|")[0])),
    ];
    const rows = new Map();
    let readable = true;
    for (const revision of revisions) {
      const read = ctx.observation.index.get(revision);
      if (!read || read.unavailable) {
        readable = false;
        problems.push(hold("typed-revision-not-read", { revision }));
        continue;
      }
      for (const [id, value] of read.rows)
        if (!rows.has(id)) rows.set(id, value);
    }
    if (!readable) continue;
    for (const edge of path.edges) {
      if (!isId(edge?.from) || !isId(edge?.to)) {
        problems.push(hold("edge-endpoint-missing"));
        continue;
      }
      const endpoints = [
        ...new Set([
          ctx.maps.logicalEntity(edge.from),
          ctx.maps.logicalEntity(edge.to),
        ]),
      ];
      for (const logical of endpoints)
        if (!Array.isArray(ctx.expectation.entityTexts?.[logical]))
          throw precheck(
            `${ctx.variantKey}: the fixture has no current text for entity ${logical}`,
          );
      const satisfied = new Set();
      // A row that could not be read (a null hash, a malformed range) leaves
      // its edge's endpoints undecided: the hold stands and (iii) is not
      // judged on the rows that were readable.
      let undecided = false;
      const shownRows = Array.isArray(edge.evidence) ? edge.evidence : null;
      if (shownRows === null) {
        problems.push(hold("edge-evidence-rows-missing"));
        continue;
      }
      for (const shown of shownRows) {
        if (!isId(shown?.evidenceId) || !isHex(shown?.quoteSha256)) {
          problems.push(hold("evidence-row-malformed"));
          undecided = true;
          continue;
        }
        const read = rows.get(shown.evidenceId);
        if (!read) {
          // (ii) the displayed `evidenceId` is not in the read Revision.
          problems.push(
            fail("evidence-id-not-in-revision", {
              evidenceId: shown.evidenceId,
            }),
          );
          continue;
        }
        if (
          !isUint(read.startUtf16) ||
          !isUint(read.endUtf16) ||
          !isHex(read.quoteSha256)
        ) {
          problems.push(hold("read-evidence-row-malformed"));
          undecided = true;
          continue;
        }
        let first = null;
        for (const logical of endpoints)
          for (const text of ctx.expectation.entityTexts[logical]) {
            const length = utf16Length(text);
            if (!(read.startUtf16 < read.endUtf16 && read.endUtf16 <= length))
              continue;
            const digest = textSha256(
              text.slice(read.startUtf16, read.endUtf16),
            );
            if (digest === shown.quoteSha256 && digest === read.quoteSha256) {
              satisfied.add(logical);
              first ??= { length };
            }
          }
        if (first === null)
          problems.push(
            fail("evidence-row-matches-no-endpoint-text", {
              evidenceId: shown.evidenceId,
            }),
          );
        else {
          disclosure.rows += 1;
          if (read.startUtf16 === 0 && read.endUtf16 === first.length)
            disclosure.fullRange += 1;
          else disclosure.notFullRange += 1;
          if (read.endUtf16 - read.startUtf16 === 1) disclosure.lengthOne += 1;
          const ref = typeof read.sourceRef === "string" ? read.sourceRef : "";
          disclosure.sourceRefRows.set(
            ref,
            (disclosure.sourceRefRows.get(ref) ?? 0) + 1,
          );
        }
      }
      // (iii) each endpoint has at least one valid row (0 rows is a fail).
      if (!undecided)
        for (const logical of endpoints)
          if (!satisfied.has(logical))
            problems.push(
              fail("endpoint-without-valid-evidence", { entity: logical }),
            );
    }
  }
  return { problems, disclosure };
}

// ---------------------------------------------------------------------------
// §2.2 explicit-pin-association

/**
 * The terminal Entity of a path walked from the seed along the displayed
 * edges (each edge's other end), or `null` when the edges are not one walk
 * from the seed that uses every edge once, or when two such walks end at
 * different Entities. Runtime IDs. The walk does not depend on the order the
 * edges are listed in: an edge is taken when it touches the current node
 * (v3 §2.2 reads the terminal of the path, not of an array).
 */
function terminalOf(seed, edges) {
  if (!isId(seed) || !Array.isArray(edges) || edges.length === 0) return null;
  const used = new Array(edges.length).fill(false);
  const ends = new Set();
  const walk = (node, left) => {
    if (left === 0) {
      ends.add(node);
      return;
    }
    for (let at = 0; at < edges.length; at += 1) {
      if (used[at]) continue;
      const edge = edges[at];
      const next =
        edge?.from === node ? edge.to : edge?.to === node ? edge.from : null;
      if (next === null || next === undefined) continue;
      used[at] = true;
      walk(next, left - 1);
      used[at] = false;
    }
  };
  walk(seed, edges.length);
  return ends.size === 1 ? [...ends][0] : null;
}

function pinSample({ side, ctx }) {
  const evidence = side.record.evidence;
  if (!evidence || typeof evidence !== "object")
    return { problems: [hold("evidence-field-missing")] };
  const expected = ctx.expectation;
  const problems = [];
  const graphOnly = evidence.graphOnly ?? null;
  const attachments = Array.isArray(evidence.pathAttachments)
    ? evidence.pathAttachments
    : null;
  if (attachments === null)
    return { problems: [hold("path-attachments-field-missing")] };
  // Graph-only row.
  if (graphOnly) {
    if (
      !isId(graphOnly.pinEntityId) ||
      !isUint(graphOnly.hop) ||
      !isId(graphOnly.sceneId)
    )
      problems.push(hold("graph-only-pin-or-hop-field-missing"));
    else {
      const scene = ctx.maps.logicalScene(graphOnly.sceneId);
      const want = expected.graphOnly;
      if (!want || want.sceneId !== scene)
        problems.push(fail("graph-only-row-outside-expectation", { scene }));
      else {
        if (graphOnly.pinEntityId !== ctx.maps.runtimeEntity(want.pinEntityId))
          problems.push(fail("graph-only-pin-differs"));
        if (graphOnly.hop !== want.hop)
          problems.push(fail("graph-only-hop-differs"));
      }
    }
  }
  // Path attachment rows.
  const wanted = new Map(expected.attachments.map((row) => [row.sceneId, row]));
  for (const row of attachments) {
    if (!isUint(row?.hop) || !Array.isArray(row.edges) || !isId(row.sceneId)) {
      problems.push(hold("attachment-hop-or-edges-field-missing"));
      continue;
    }
    const scene = ctx.maps.logicalScene(row.sceneId);
    const want = wanted.get(scene);
    if (!want) {
      // Includes `scenesWithoutPath` and a name-inferred association.
      problems.push(fail("attachment-outside-expectation", { scene }));
      continue;
    }
    // The walk starts at the seed: a receipt that does not carry it cannot
    // be judged (a hold, not a fail: the seed is the receipt's own record).
    if (!isId(ctx.seedRuntime)) {
      problems.push(hold("seed-runtime-missing"));
      continue;
    }
    const terminal = terminalOf(ctx.seedRuntime, row.edges);
    if (
      terminal === null ||
      terminal !== ctx.maps.runtimeEntity(want.targetEntityId)
    )
      problems.push(fail("attachment-terminal-differs", { scene }));
    if (row.hop !== want.hop)
      problems.push(fail("attachment-hop-differs", { scene }));
  }
  // §2.0 exception (2): nothing expected was displayed at all.
  const expectsAny =
    expected.graphOnly !== null || expected.attachments.length > 0;
  if (expectsAny && graphOnly === null && attachments.length === 0)
    problems.push(hold("no-expected-graph-only-or-attachment-displayed"));
  return { problems };
}

// ---------------------------------------------------------------------------
// §2.3 raw-excerpt-unchanged

const ROW_KEYS = ["sceneId", "kind", "excerptSha256", "excerptUtf16Length"];

function rowsWellFormed(rows) {
  return (
    Array.isArray(rows) &&
    rows.every(
      (row) =>
        isId(row?.sceneId) &&
        ["raw", "ir", "graph-only"].includes(row.kind) &&
        isHex(row.excerptSha256) &&
        isUint(row.excerptUtf16Length),
    )
  );
}

function rawSample({ sample, side }) {
  const parent = sample.followUp?.parent;
  const child = sample.followUp?.child;
  // The parent's R+IR rows and the child's, with no Graph-only row on either
  // side, are compared in the same sample (the only relative invariant).
  if (side.firstRender)
    return { problems: [hold("first-render-has-no-child-to-compare")] };
  // "The same parent's follow-up of the same query, the parent's IR complete"
  // (§2.3): the child is the graph-ready refresh of the same query Scene and
  // seed, started later than the parent (the generation counter moves by more
  // than 1 between them in a real run: the loading effect), and the parent's
  // IR returned `ir-ready`. A Raw recovery, an `index-ready` or IR-retry
  // child, or a parent whose IR timed out answers another query: hold.
  if (
    sample.irOutcome !== "ir-ready" ||
    child?.origin !== "graph-ready" ||
    !isId(parent?.sceneId) ||
    parent.sceneId !== child.sceneId ||
    !isId(parent.seed) ||
    parent.seed !== child.seed ||
    !Number.isSafeInteger(parent.queryGeneration) ||
    !Number.isSafeInteger(child.queryGeneration) ||
    child.queryGeneration <= parent.queryGeneration
  )
    return { problems: [hold("child-is-not-comparable-with-the-parent")] };
  if (!rowsWellFormed(parent.rowExcerpts) || !rowsWellFormed(child.rowExcerpts))
    return { problems: [hold("row-excerpts-field-missing")] };
  const base = (rows) => rows.filter((row) => row.kind !== "graph-only");
  const left = base(parent.rowExcerpts);
  const right = base(child.rowExcerpts);
  const same =
    left.length === right.length &&
    left.every((row, at) =>
      ROW_KEYS.every((key) => row[key] === right[at][key]),
    );
  return { problems: same ? [] : [fail("r-plus-ir-rows-changed")] };
}

// ---------------------------------------------------------------------------
// §2.4 added-scene-body-anchor

function anchorSample({ side, ctx }) {
  const evidence = side.record.evidence;
  if (!evidence || typeof evidence !== "object")
    return { problems: [hold("evidence-field-missing")] };
  const graphOnly = evidence.graphOnly ?? null;
  const want = ctx.expectation.sceneExcerpt;
  if (graphOnly === null)
    return { problems: [hold("no-graph-only-row-displayed")] };
  const range = graphOnly.canonicalRange;
  if (
    !isId(graphOnly.sceneId) ||
    !isUint(range?.start) ||
    !isUint(range?.end) ||
    !isHex(graphOnly.excerptSha256) ||
    !isUint(graphOnly.excerptUtf16Length)
  )
    return { problems: [hold("graph-only-anchor-field-missing")] };
  const problems = [];
  if (graphOnly.sceneId !== ctx.maps.runtimeScene(want.sceneId))
    problems.push(fail("anchor-scene-differs"));
  if (range.start !== want.range.start || range.end !== want.range.end)
    problems.push(fail("anchor-range-differs"));
  if (graphOnly.excerptSha256 !== textSha256(want.body))
    problems.push(fail("anchor-excerpt-hash-differs"));
  if (graphOnly.excerptUtf16Length !== utf16Length(want.body))
    problems.push(fail("anchor-excerpt-length-differs"));
  return { problems };
}

// ---------------------------------------------------------------------------

function sourceRefDisclosure(map) {
  return {
    distinctSourceRefs: map.size,
    sourceRefRows: [...map.values()].reduce((sum, count) => sum + count, 0),
  };
}

/**
 * The four items of one variant. `inputs` is `[{ sample, result }]` for the
 * variant's measured Graph arm samples (`result` is `classifyFollowUp`'s).
 * An item the variant does not apply to (fixture `requirements`) is `n/a`.
 */
export function evaluateEvidenceItems({
  variantKey,
  expectation,
  receipt,
  inputs,
}) {
  const plan = expectation.evidence;
  const maps = idMapsOf(receipt);
  const observation = observationIndex(receipt);
  const seedRuntime = receipt?.settings?.seed?.runtime ?? null;
  const items = {};
  for (const id of EVIDENCE_ITEM_IDS) {
    if (plan?.applies?.[id] !== true) {
      items[id] = { status: "n/a" };
      continue;
    }
    const perSample = [];
    let skipped = 0;
    const disclosure = {
      rows: 0,
      fullRange: 0,
      notFullRange: 0,
      lengthOne: 0,
      sourceRefRows: new Map(),
    };
    for (const { sample, result } of inputs) {
      const side = sideOf(sample, result);
      if (
        side.kind === "skip" ||
        (side.kind === "d8" && id !== "raw-excerpt-unchanged")
      ) {
        skipped += 1;
        continue;
      }
      if (side.kind === "d8") {
        perSample.push({
          repeat: sample.repeat,
          status: "hold",
          problems: [hold("d8-graph-contributed-without-a-first-render")],
        });
        continue;
      }
      const ctx = {
        variantKey,
        maps,
        observation,
        expectation: plan,
        seedRuntime,
      };
      const one =
        id === "utf16-range"
          ? utf16RangeSample({ side, ctx })
          : id === "explicit-pin-association"
            ? pinSample({ side, ctx })
            : id === "raw-excerpt-unchanged"
              ? rawSample({ sample, side })
              : anchorSample({ side, ctx });
      if (one.disclosure) {
        disclosure.rows += one.disclosure.rows;
        disclosure.fullRange += one.disclosure.fullRange;
        disclosure.notFullRange += one.disclosure.notFullRange;
        disclosure.lengthOne += one.disclosure.lengthOne;
        for (const [ref, count] of one.disclosure.sourceRefRows)
          disclosure.sourceRefRows.set(
            ref,
            (disclosure.sourceRefRows.get(ref) ?? 0) + count,
          );
      }
      perSample.push({
        repeat: sample.repeat,
        status: statusOfProblems(one.problems),
        problems: one.problems,
      });
    }
    const status =
      perSample.length === 0
        ? "hold"
        : worst(perSample.map((row) => row.status));
    items[id] = {
      status,
      checked: perSample.length,
      skipped,
      problems: perSample
        .filter((row) => row.status !== "pass")
        .flatMap((row) =>
          row.problems.map((problem) => ({ repeat: row.repeat, ...problem })),
        ),
      ...(perSample.length === 0 ? { reason: "no-sample-was-checked" } : {}),
      ...(id === "utf16-range"
        ? {
            disclosure: {
              rows: disclosure.rows,
              fullRange: disclosure.fullRange,
              notFullRange: disclosure.notFullRange,
              lengthOne: disclosure.lengthOne,
              ...sourceRefDisclosure(disclosure.sourceRefRows),
            },
          }
        : {}),
    };
  }
  return items;
}

/** A variant that is held before its samples are read: every applicable item holds. */
export function heldEvidenceItems(expectation, reason) {
  return Object.fromEntries(
    EVIDENCE_ITEM_IDS.map((id) => [
      id,
      expectation.evidence?.applies?.[id] === true
        ? { status: "hold", checked: 0, skipped: 0, problems: [], reason }
        : { status: "n/a" },
    ]),
  );
}

/**
 * v3 §2.0: the item over every catalog variant. `rows` are the variants'
 * results (`blocked` is a ledger value or null; a blocked variant has no
 * `items`), `expectations` maps a variant key to its expectation. An item
 * whose applicable variants are all blocked is `not-evaluable`, never `n/a`
 * (manifest `unverifiedRequirement`): `worstStatus` of all-`n/a` would let
 * condition 4 pass.
 */
export function aggregateEvidenceItems(rows, expectations) {
  const out = {};
  for (const id of EVIDENCE_ITEM_IDS) {
    const applicable = rows.filter(
      (row) => expectations[row.variantKey]?.evidence?.applies?.[id] === true,
    );
    const live = applicable.filter((row) => row.blocked === null);
    const statuses = live.map((row) => row.items?.[id]?.status ?? "hold");
    const part = {
      status:
        applicable.length === 0
          ? "n/a"
          : live.length === 0
            ? "not-evaluable"
            : worst(statuses),
      ...(applicable.length > 0 && live.length === 0
        ? { reason: "every-applicable-variant-is-blocked" }
        : {}),
      variants: live.length,
      applicableVariants: applicable.length,
      checked: live.reduce(
        (sum, row) => sum + (row.items?.[id]?.checked ?? 0),
        0,
      ),
      skipped: live.reduce(
        (sum, row) => sum + (row.items?.[id]?.skipped ?? 0),
        0,
      ),
    };
    if (id === "utf16-range")
      part.disclosure = live.reduce(
        (sum, row) => {
          const d = row.items?.[id]?.disclosure;
          if (!d) return sum;
          return {
            rows: sum.rows + d.rows,
            fullRange: sum.fullRange + d.fullRange,
            notFullRange: sum.notFullRange + d.notFullRange,
            lengthOne: sum.lengthOne + d.lengthOne,
            // The variants' distinct values may repeat across variants; the
            // per-variant counts are in the variant rows.
            distinctSourceRefsPerVariant: [
              ...sum.distinctSourceRefsPerVariant,
              d.distinctSourceRefs,
            ],
            sourceRefRows: sum.sourceRefRows + d.sourceRefRows,
          };
        },
        {
          rows: 0,
          fullRange: 0,
          notFullRange: 0,
          lengthOne: 0,
          distinctSourceRefsPerVariant: [],
          sourceRefRows: 0,
        },
      );
    out[id] = part;
  }
  return out;
}
