// Synthetic, hand-built worlds for the final-request scorer's tests.
//
// Nothing here is Native output. `buildSyntheticWorld` writes a fixture, a
// receipt and a setup receipt from one set of hand-made values, using a small
// JavaScript copy of the renderer's system-message layout, so the scorer and
// the contract can be exercised without running Rust. It is a test helper:
// it is not bound by a freeze record and is never evidence for any case.
import { createHash } from "node:crypto";
import { DPH_CASE_IDS, REJECT_CODE } from "./contract.mjs";
import {
  ESTIMATOR_VERSION,
  FIXED_TEMPLATE_REF,
  FIXED_TEMPLATE_VERSION,
  canonicalJson,
  contextBudgetTokens,
  escapeReservedPromptTags,
  estimateTokens,
  payloadDigest,
} from "./payload.mjs";
import {
  CONTRACT_ID,
  DRAFT_REF,
  QUALIFICATION_KINDS,
  RECEIPT_SCHEMA_VERSION,
  SETUP_RECEIPT_SCHEMA_VERSION,
} from "./receipt.mjs";

export const SYNTHETIC_HEAD = "a".repeat(40);
export const SYNTHETIC_TREE = "b".repeat(40);
export const SYNTHETIC_FREEZE_COMMIT = "c".repeat(40);
export const SYNTHETIC_FIXTURE_SHA = "1".repeat(64);
export const SYNTHETIC_FREEZE_SHA = "2".repeat(64);
export const SYNTHETIC_SCORER_SHA = "3".repeat(64);
export const SYNTHETIC_FEATURES = ["nir1-final-request-eval"];

export const SYNTHETIC_ROUTE = Object.freeze({
  model: "synthetic-local-model",
  contextWindowTokens: 8192,
  outputTokens: 512,
});

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const PARTS = [
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
];

function partText(part, revision) {
  switch (part) {
    case "statement":
      return `{"statement":"${revision} says the harbor bell rang twice"}`;
    case "negation":
      return '{"negation":"none"}';
    case "attribution":
      return '{"attribution":"narrator"}';
    case "evidence":
      return `{"evidence":{"quote":"the bell rang twice at dusk (${revision})"}}`;
    default:
      return '{"qualification":"human-approved"}';
  }
}

function quoteOf(revision) {
  return `the bell rang twice at dusk (${revision})`;
}

function groupEntries(revision) {
  return PARTS.map((part) => ({
    logicalId: `${revision}.${part}`,
    groupLogicalId: revision,
    part,
    text: partText(part, revision),
  }));
}

const CANARIES = Object.freeze([
  {
    id: "canary-decision-note",
    kind: "decision-note",
    text: "CANARY-DECISION-NOTE-7f3a91",
  },
  {
    id: "canary-internal-metadata",
    kind: "internal-metadata",
    text: "CANARY-INTERNAL-META-2b8c04",
  },
]);

function runtimeIdOf(logicalId) {
  return `rt:${logicalId}`;
}

function qualificationsFor(kind) {
  // kind: "user" | "raw" | "revision". Every input gets all 7 kinds.
  const present = (k, extra = {}) => ({
    state: "present",
    kind: k,
    identity: `${k}:id`,
    version: `${k}:v1`,
    ...extra,
  });
  const na = (k, reason) => ({ state: "not-applicable", kind: k, reason });
  if (kind === "revision") {
    return [
      present("source"),
      present("revision"),
      present("decision"),
      present("freshness"),
      na("index", "not-index-derived"),
      present("scope", { scopeRole: "query-scene-scope" }),
      present("d1"),
    ];
  }
  return [
    present("source"),
    na("revision", "not-a-revision"),
    na("decision", kind === "user" ? "human-message" : "manuscript-source"),
    na("freshness", kind === "user" ? "fixed-user-slot" : "exact-source-token"),
    na("index", "not-index-derived"),
    present("scope", { scopeRole: "query-scene-scope" }),
    kind === "raw" ? present("d1") : na("d1", "fixed-user-slot"),
  ];
}

function withOrdinal(rows, inputOrdinal) {
  return rows.map((row) => ({ inputOrdinal, ...row }));
}

function normalizeGroups(revisions) {
  return revisions.map((entry) =>
    typeof entry === "string"
      ? { id: entry, kind: "accepted-ir", selected: PARTS }
      : { kind: "accepted-ir", selected: PARTS, ...entry },
  );
}

/**
 * Renders one request the way the Native renderer lays out the system message.
 * `revisions` are logical ids (a whole accepted-IR group each) or
 * `{ id, kind, selected }` objects: the candidate set always holds every part
 * of every group, and `selected` lists the parts this arm renders.
 */
export function renderSynthetic({
  template,
  route,
  userMessage,
  rawText,
  revisions,
  requestToken,
}) {
  const groups = normalizeGroups(revisions);
  const items = [
    {
      itemId: "item:raw",
      kind: "raw",
      text: rawText,
      tokens: estimateTokens(rawText),
      ownerId: "raw-source:scene",
      bindingDigest: "binding:raw",
    },
  ];
  const candidateInputs = [
    { role: "user", target: { kind: "message", versionId: "msg:v1" } },
    {
      role: "context",
      target: {
        kind: "raw-source",
        sourceKey: "raw-source:scene",
        revisionToken: "tok:1",
      },
    },
  ];
  const inputReferences = [...candidateInputs];
  const candidateRefs = [];
  const entryRows = [];
  for (const group of groups) {
    const ownerId = runtimeIdOf(group.id);
    const reference =
      group.kind === "graph-evidence"
        ? {
            role: "context",
            target: {
              kind: "graph-evidence",
              evidenceRef: ownerId,
              sourceKey: "raw-source:scene",
              revisionToken: "tok:1",
            },
          }
        : {
            role: "context",
            target: {
              kind: "accepted-revision",
              revisionId: ownerId,
              bundleDigest: `bundle:${group.id}`,
            },
          };
    candidateRefs.push({
      ownerId,
      input: reference,
      qualifications: qualificationsFor("revision"),
    });
    let ordinal;
    if (group.selected.length > 0) {
      ordinal = inputReferences.length;
      inputReferences.push(reference);
    }
    for (const part of PARTS) {
      const text = partText(part, group.id);
      items.push({
        itemId: `item:${group.id}.${part}`,
        kind: group.kind,
        text,
        tokens: estimateTokens(text),
        ownerId,
        bindingDigest: `binding:${group.id}`,
        atomicGroup: `group:${group.id}`,
        atomicPart: part,
      });
      if (group.selected.includes(part))
        entryRows.push({ text, inputOrdinal: ordinal });
    }
  }
  const renderCorrespondence = [
    { position: { kind: "system-current-scene" }, inputOrdinal: 1 },
    ...entryRows.map((row, index) => ({
      position: { kind: "system-codex-entry", index },
      inputOrdinal: row.inputOrdinal,
    })),
  ];
  const qualifications = [
    ...withOrdinal(qualificationsFor("user"), 0),
    ...withOrdinal(qualificationsFor("raw"), 1),
    ...inputReferences.flatMap((_, ordinal) =>
      ordinal < 2 ? [] : withOrdinal(qualificationsFor("revision"), ordinal),
    ),
  ];
  const system = `${template.base}\n\n<current_scene>\n${escapeReservedPromptTags(rawText)}\n</current_scene>\n\n<codex_entries>\n${entryRows
    .map((row) => escapeReservedPromptTags(row.text))
    .join("\n")}\n</codex_entries>\n\n${template.reminder}`;
  const payload = {
    model: route.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMessage },
    ],
    max_tokens: route.outputTokens,
  };
  const budget = contextBudgetTokens({
    template,
    userMessage,
    contextWindowTokens: route.contextWindowTokens,
    outputTokens: route.outputTokens,
  });
  return {
    payload: canonicalJson(payload),
    payloadDigest: payloadDigest(payload),
    items,
    candidateRefs,
    inputReferences,
    qualifications,
    renderCorrespondence,
    budget,
    requestToken,
  };
}

function inputsOf(capture) {
  return {
    capturedTurnId: capture.capturedTurnId,
    userMessageDigestSha256: capture.userMessage.digestSha256,
    snapshotIdentity: capture.snapshotIdentity,
    candidateSetDigest: capture.candidateSet.digest,
    estimatorVersion: capture.estimatorVersion,
    template: capture.template,
    route: capture.route,
    contextBudgetTokens: capture.contextBudgetTokens,
    measure: capture.measure,
    passedRevisionIds: capture.passedRevisionIds,
  };
}

function caseSpec(caseId, template) {
  const userMessage = `この場面の続きを書いてください。(${caseId})`;
  const rawText = `雨が止んだ。港の鐘が鳴った。MARKER-${caseId}-raw`;
  const budget = contextBudgetTokens({
    template,
    userMessage,
    contextWindowTokens: SYNTHETIC_ROUTE.contextWindowTokens,
    outputTokens: SYNTHETIC_ROUTE.outputTokens,
  });
  return { caseId, userMessage, rawText, budget };
}

function positiveExpectation(
  spec,
  revisions,
  forbiddenLogicalIds,
  earlier = [],
) {
  const entries = revisions.flatMap(groupEntries);
  const earlierEntries = earlier.flatMap(groupEntries);
  return {
    contextBudgetTokens: spec.budget,
    rawText: spec.rawText,
    codexEntries: entries,
    selectedGroupLogicalIds: revisions,
    exactQuotes: revisions.map((revision) => ({
      logicalId: `${revision}.evidence`,
      quote: quoteOf(revision),
    })),
    forbidden: {
      logicalIds: [
        ...forbiddenLogicalIds,
        ...earlierEntries.map((entry) => entry.logicalId),
      ],
      texts: [
        `FORBIDDEN-TEXT-${spec.caseId}`,
        // Only text the new stage's own entries do not repeat can be forbidden.
        ...earlierEntries
          .map((entry) => entry.text)
          .filter((text) => !entries.some((entry) => entry.text === text)),
      ],
    },
    embeddedCanaryIds: CANARIES.map((canary) => canary.id),
  };
}

/**
 * Builds a consistent fixture, receipt and setup receipt for the nine DP-H
 * cases. P-10 has two stages (a binding change and a newly prepared Revision);
 * every case has one positive and one reject variant.
 */
export function buildSyntheticWorld({ template, caseIds = DPH_CASE_IDS }) {
  const fixtureCases = [];
  const receiptRequests = [];
  const setupCases = [];
  let counter = 0;
  for (const caseId of caseIds) {
    const spec = caseSpec(caseId, template);
    const staged = caseId === "P-10";
    const stage1 = [`rev-${caseId}-a`, `rev-${caseId}-b`];
    const stage2 = staged ? [`rev-${caseId}-c`, `rev-${caseId}-d`] : null;
    const bad = `rev-${caseId}-bad`;
    const positiveRequests = [
      {
        stage: 1,
        revisionIds: stage1,
        expected: positiveExpectation(spec, stage1, [bad]),
      },
    ];
    if (stage2) {
      positiveRequests.push({
        stage: 2,
        revisionIds: stage2,
        expected: positiveExpectation(spec, stage2, [bad, ...stage1], stage1),
      });
    }
    const rejectRequests = positiveRequests.map((request, index) =>
      index === positiveRequests.length - 1
        ? {
            stage: request.stage,
            revisionIds: [...request.revisionIds, bad],
            expected: { code: REJECT_CODE, reason: "revision-stale" },
          }
        : request,
    );
    fixtureCases.push({
      caseId,
      task: `synthetic task ${caseId}`,
      isolation: {
        workspaceId: `ws-${caseId}`,
        conversationId: `conv-${caseId}`,
        artifactNamespace: `ns-${caseId}`,
      },
      userMessage: spec.userMessage,
      markers: [`MARKER-${caseId}-raw`, `FORBIDDEN-TEXT-${caseId}`],
      variants: [
        {
          variantId: `${caseId}-positive`,
          kind: "positive",
          ...(staged ? { binding: "scope" } : {}),
          requests: positiveRequests,
        },
        {
          variantId: `${caseId}-reject-stale`,
          kind: "reject",
          baseVariantId: `${caseId}-positive`,
          negative: "stale",
          ineligibleLogicalId: bad,
          requests: rejectRequests,
        },
      ],
    });

    for (const variant of fixtureCases.at(-1).variants) {
      const variantRequests = variant.requests;
      const logicalIds = [...new Set([...stage1, ...(stage2 ?? []), bad])];
      const idMap = logicalIds.map((logicalId) => ({
        logicalId,
        runtimeId: runtimeIdOf(logicalId),
      }));
      const events = [];
      let seq = 0;
      const push = (kind, stage, writer, extra = {}) => {
        seq += 1;
        events.push({ seq, stage, kind, writer, ...extra });
      };
      push("route-settings", 1, "write_ai_settings");
      push("scope", 1, "narrative_scene_scope_update");
      push("tree", 1, "tree_node_patch");
      push("codex", 1, "codex_create");
      if (variant.kind === "reject") {
        push("prepare-negative", 1, "nir1_entity_relation_revision_prepare", {
          logicalId: bad,
          runtimeId: runtimeIdOf(bad),
        });
        push(
          "approve-negative",
          1,
          "narrative_extraction_append_human_decision",
          { logicalId: bad, runtimeId: runtimeIdOf(bad) },
        );
        push("tree", 1, "tree_node_patch");
        push("invalidate-negative", 1, "tree_node_patch");
      }
      for (const logicalId of stage1) {
        push("prepare", 1, "nir1_entity_relation_revision_prepare", {
          logicalId,
          runtimeId: runtimeIdOf(logicalId),
        });
      }
      for (const logicalId of stage1) {
        push("approve", 1, "narrative_extraction_append_human_decision", {
          logicalId,
          runtimeId: runtimeIdOf(logicalId),
        });
      }
      push("chat-session", 1, "db_execute:createSession");
      if (stage2) push("chat-session", 2, "db_execute:createSession");
      push("restricted", 1, "activate_first_restricted_publication");
      push("capture", 1, "activate_first_restricted_publication");
      if (stage2) {
        push("scope", 2, "narrative_scene_scope_update");
        push("tree", 2, "tree_node_patch");
        for (const logicalId of stage2) {
          push("prepare", 2, "nir1_entity_relation_revision_prepare", {
            logicalId,
            runtimeId: runtimeIdOf(logicalId),
          });
        }
        for (const logicalId of stage2) {
          push("approve", 2, "narrative_extraction_append_human_decision", {
            logicalId,
            runtimeId: runtimeIdOf(logicalId),
          });
        }
        push("capture", 2, "activate_first_restricted_publication");
      }
      const verifications = variantRequests.flatMap((request) => {
        const required = request.revisionIds.filter((id) => id !== bad);
        const revisions = required.map((logicalId) => ({
          logicalId,
          runtimeId: runtimeIdOf(logicalId),
          a2: "eligible",
          a3: "eligible",
          freshness: "fresh",
        }));
        const scope = `scope-rev-${request.stage}`;
        return [
          {
            point: "setup-end",
            stage: request.stage,
            revisions,
            scopeAuthorityRevision: scope,
            d2a: { restricted: false, inFlightStopped: false },
          },
          {
            point: "request-pre",
            stage: request.stage,
            revisions,
            scopeAuthorityRevision: scope,
            d2a: { restricted: true, inFlightStopped: true },
          },
        ];
      });
      setupCases.push({
        caseId,
        variantId: variant.variantId,
        workspaceNamespace: `ws-${caseId}/${variant.variantId}`,
        events,
        writersUsed: [...new Set(events.map((event) => event.writer))],
        directDmlObserved: false,
        verifications,
        idMap,
        chatSession: {
          writer: "db_execute:createSession",
          statementMatchesRenderer: true,
          createdBeforeRestricted: true,
        },
        history: { inputCount: 0, reason: "not-applicable" },
        valid: true,
      });

      for (const [index, request] of variantRequests.entries()) {
        counter += 1;
        const isReject =
          variant.kind === "reject" && index === variantRequests.length - 1;
        const passed = request.revisionIds.map(runtimeIdOf);
        const base = {
          requestId: `req-${counter}`,
          caseId,
          variantId: variant.variantId,
          requestKind: isReject ? "reject" : "positive",
          stage: request.stage,
          passedRevisionIds: passed,
          baseline: null,
          history: { inputCount: 0, reason: "not-applicable" },
          attemptRowsAdded: 0,
        };
        if (isReject) {
          receiptRequests.push({
            ...base,
            dfinal: {
              outcome: "err",
              code: REJECT_CODE,
              reason: "revision-stale",
            },
            capture: null,
            candidate: null,
          });
          continue;
        }
        const rendered = renderSynthetic({
          template,
          route: SYNTHETIC_ROUTE,
          userMessage: spec.userMessage,
          rawText: spec.rawText,
          revisions: request.revisionIds,
          requestToken: `token-${counter}`,
        });
        const capture = captureOf({
          rendered,
          userMessage: spec.userMessage,
          caseId,
          passed,
        });
        capture.candidateSet.digest = `candidate-set-${caseId}-${request.stage}`;
        receiptRequests.push({
          ...base,
          dfinal: { outcome: "ok", payloadDigest: rendered.payloadDigest },
          capture,
          candidate: {
            arm: "candidate",
            outcome: "rendered",
            payload: rendered.payload,
            payloadDigest: rendered.payloadDigest,
            renderCorrespondence: rendered.renderCorrespondence,
          },
        });
      }
    }
  }

  const fixture = {
    schemaVersion: "nir1-final-request-fixture/1",
    contractId: CONTRACT_ID,
    draftRef: DRAFT_REF,
    fixtureVersion: 1,
    phase: "dp-h",
    fixtureId: "synthetic-fixture",
    estimatorVersion: ESTIMATOR_VERSION,
    fixedTemplate: { version: FIXED_TEMPLATE_VERSION, ref: FIXED_TEMPLATE_REF },
    route: { ...SYNTHETIC_ROUTE },
    canaries: CANARIES.map((canary) => ({ ...canary })),
    excludedNegatives: ["source", "revision", "decision", "freshness"].map(
      (negative) => ({
        caseId: "P-10",
        negative,
        reason: "synthetic: covered by a DD-1 mixed variant",
      }),
    ),
    cases: fixtureCases,
  };
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    contractId: CONTRACT_ID,
    draftRef: DRAFT_REF,
    producer: {
      entry: "cargo-test",
      evalFeature: "nir1-final-request-eval",
      featureSet: [...SYNTHETIC_FEATURES],
    },
    run: { commit: SYNTHETIC_HEAD, tree: SYNTHETIC_TREE, workspaceClean: true },
    freeze: {
      path: "evals/nir1-packing/final-request.freeze.v1.json",
      recordSha256: SYNTHETIC_FREEZE_SHA,
      commit: SYNTHETIC_FREEZE_COMMIT,
    },
    inputs: {
      fixtureSha256: SYNTHETIC_FIXTURE_SHA,
      scorerSha256: SYNTHETIC_SCORER_SHA,
      fixtureVersion: 1,
      estimatorVersion: ESTIMATOR_VERSION,
      fixedTemplate: {
        version: template.version,
        ref: template.ref,
        sha256: template.sha256,
      },
    },
    requests: receiptRequests,
  };
  const setupReceipt = {
    schemaVersion: SETUP_RECEIPT_SCHEMA_VERSION,
    contractId: CONTRACT_ID,
    run: { commit: SYNTHETIC_HEAD, tree: SYNTHETIC_TREE },
    cases: setupCases,
  };
  const expectedInputs = {
    head: SYNTHETIC_HEAD,
    tree: SYNTHETIC_TREE,
    fixtureSha256: SYNTHETIC_FIXTURE_SHA,
    freezeSha256: SYNTHETIC_FREEZE_SHA,
    scorerSha256: SYNTHETIC_SCORER_SHA,
    featureSet: [...SYNTHETIC_FEATURES],
    freezeCommit: SYNTHETIC_FREEZE_COMMIT,
  };
  return { fixture, receipt, setupReceipt, expectedInputs, template };
}

function captureOf({ rendered, userMessage, caseId, passed }) {
  return {
    requestToken: rendered.requestToken,
    capturedTurnId: `turn-${caseId}`,
    userMessage: {
      text: userMessage,
      digestSha256: sha256(userMessage),
      versionId: "msg:v1",
    },
    snapshotIdentity: `snapshot-${caseId}`,
    estimatorVersion: ESTIMATOR_VERSION,
    template: { version: FIXED_TEMPLATE_VERSION, ref: FIXED_TEMPLATE_REF },
    route: { routeRevision: "route-rev-1", ...SYNTHETIC_ROUTE },
    contextBudgetTokens: rendered.budget,
    measure: "item-estimate-sum",
    passedRevisionIds: passed,
    candidateSet: {
      digest: `candidate-set-${caseId}`,
      items: rendered.items,
      candidateRefs: rendered.candidateRefs,
    },
    rendered: {
      payloadDigest: rendered.payloadDigest,
      renderCorrespondence: rendered.renderCorrespondence,
      inputReferences: rendered.inputReferences,
      qualifications: rendered.qualifications,
    },
  };
}

/**
 * A P-12-shaped pair: the candidate renders the whole Graph evidence group,
 * the baseline (item-by-item removal) keeps only two of its five parts. Used
 * for the scorer's P-12 tests and as the harness-check diagnostic shape; it is
 * never evidence for any case.
 */
export function buildSyntheticP12({ template }) {
  const userMessage = "診断用の続きを書いてください。(DIAG)";
  const rawText = "診断用の本文。MARKER-DIAG-raw";
  const passed = [runtimeIdOf("ir-x"), runtimeIdOf("graph-g")];
  const candidate = renderSynthetic({
    template,
    route: SYNTHETIC_ROUTE,
    userMessage,
    rawText,
    revisions: [
      "ir-x",
      { id: "graph-g", kind: "graph-evidence", selected: PARTS },
    ],
    requestToken: "token-diag",
  });
  const baseline = renderSynthetic({
    template,
    route: SYNTHETIC_ROUTE,
    userMessage,
    rawText,
    revisions: [
      "ir-x",
      {
        id: "graph-g",
        kind: "graph-evidence",
        selected: ["evidence", "qualification"],
      },
    ],
    requestToken: "token-diag",
  });
  const capture = captureOf({
    rendered: candidate,
    userMessage,
    caseId: "DIAG",
    passed,
  });
  const request = {
    requestId: "req-diag",
    caseId: "DIAG-P12",
    variantId: "DIAG-P12-v1",
    requestKind: "positive",
    stage: 1,
    passedRevisionIds: passed,
    dfinal: { outcome: "ok", payloadDigest: candidate.payloadDigest },
    capture,
    candidate: {
      arm: "candidate",
      outcome: "rendered",
      payload: candidate.payload,
      payloadDigest: candidate.payloadDigest,
      renderCorrespondence: candidate.renderCorrespondence,
    },
    baseline: {
      arm: "baseline",
      outcome: "rendered",
      persistedRows: 0,
      payload: baseline.payload,
      payloadDigest: baseline.payloadDigest,
      renderCorrespondence: baseline.renderCorrespondence,
      inputReferences: baseline.inputReferences,
      qualifications: baseline.qualifications,
      inputs: inputsOf(capture),
    },
    history: { inputCount: 0, reason: "not-applicable" },
    attemptRowsAdded: 0,
  };
  const expectation = {
    slot: "qualifiedEvidence",
    baselineTarget: 0,
    candidateTarget: 1,
    improvementGroups: [
      { ownerId: runtimeIdOf("graph-g"), kind: "graph-evidence" },
    ],
    contextBudgetTokens: candidate.budget,
  };
  return {
    request,
    expectation,
    template,
    route: { ...SYNTHETIC_ROUTE },
    parts: PARTS,
  };
}

/**
 * Adds the optional harness-check (P-12 diagnostic) case to a synthetic world:
 * its fixture entry, setup receipt case and receipt request. It is never P
 * evidence.
 */
export function addSyntheticDiagnostic(world) {
  const p12 = buildSyntheticP12({ template: world.template });
  world.fixture.diagnosticCases = [
    {
      caseId: "DIAG-P12",
      evidenceUse: "none",
      userMessage: "診断用の続きを書いてください。(DIAG)",
      materials: [{ logicalId: "ir-x", text: "diagnostic only" }],
      p12: {
        variantId: "DIAG-P12-v1",
        revisionIds: ["ir-x", "graph-g"],
        improvementGroups: [{ logicalId: "graph-g", kind: "graph-evidence" }],
        contextBudgetTokens: p12.expectation.contextBudgetTokens,
      },
    },
  ];
  const events = [];
  let seq = 0;
  const push = (kind, writer, extra = {}) => {
    seq += 1;
    events.push({ seq, stage: 1, kind, writer, ...extra });
  };
  push("scope", "narrative_scene_scope_update");
  for (const logicalId of ["ir-x", "graph-g"]) {
    push("prepare", "nir1_entity_relation_revision_prepare", {
      logicalId,
      runtimeId: runtimeIdOf(logicalId),
    });
  }
  for (const logicalId of ["ir-x", "graph-g"]) {
    push("approve", "narrative_extraction_append_human_decision", {
      logicalId,
      runtimeId: runtimeIdOf(logicalId),
    });
  }
  push("chat-session", "db_execute:createSession");
  push("restricted", "activate_first_restricted_publication");
  push("capture", "activate_first_restricted_publication");
  const revisions = ["ir-x", "graph-g"].map((logicalId) => ({
    logicalId,
    runtimeId: runtimeIdOf(logicalId),
    a2: "eligible",
    a3: "eligible",
    freshness: "fresh",
  }));
  world.setupReceipt.cases.push({
    caseId: "DIAG-P12",
    variantId: "DIAG-P12-v1",
    workspaceNamespace: "ws-DIAG-P12",
    events,
    writersUsed: [...new Set(events.map((event) => event.writer))],
    directDmlObserved: false,
    verifications: [
      {
        point: "setup-end",
        stage: 1,
        revisions,
        scopeAuthorityRevision: "scope-diag",
        d2a: { restricted: false, inFlightStopped: false },
      },
      {
        point: "request-pre",
        stage: 1,
        revisions,
        scopeAuthorityRevision: "scope-diag",
        d2a: { restricted: true, inFlightStopped: true },
      },
    ],
    idMap: ["ir-x", "graph-g"].map((logicalId) => ({
      logicalId,
      runtimeId: runtimeIdOf(logicalId),
    })),
    chatSession: {
      writer: "db_execute:createSession",
      statementMatchesRenderer: true,
      createdBeforeRestricted: true,
    },
    history: { inputCount: 0, reason: "not-applicable" },
    valid: true,
  });
  world.receipt.requests.push(structuredClone(p12.request));
  return world;
}

/** Replaces a request's payload with `mutate(parsedPayload)` and re-derives every digest. */
export function repayload(request, mutate) {
  const parsed = JSON.parse(request.candidate.payload);
  mutate(parsed);
  const payload = canonicalJson(parsed);
  const digest = payloadDigest(parsed);
  request.candidate.payload = payload;
  request.candidate.payloadDigest = digest;
  request.dfinal.payloadDigest = digest;
  request.capture.rendered.payloadDigest = digest;
}

export function requestOf(receipt, caseId, variantId, stage = 1) {
  return receipt.requests.find(
    (row) =>
      row.caseId === caseId &&
      row.variantId === variantId &&
      row.stage === stage,
  );
}

export function setupOf(setupReceipt, caseId, variantId) {
  return setupReceipt.cases.find(
    (row) => row.caseId === caseId && row.variantId === variantId,
  );
}

export {
  CANARIES,
  PARTS,
  QUALIFICATION_KINDS,
  inputsOf,
  groupEntries,
  quoteOf,
  runtimeIdOf,
};
