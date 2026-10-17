import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadFixedTemplate } from "./payload.mjs";
import {
  BINDING_KINDS,
  PRODUCT_WRITERS,
  QUALIFICATION_KINDS,
  RECEIPT_SCHEMA_VERSION,
  SETUP_RECEIPT_SCHEMA_VERSION,
  validateInputReference,
  validateQualificationRow,
  validateReceipt,
  validateSetupReceipt,
} from "./receipt.mjs";
import { buildSyntheticP12, buildSyntheticWorld } from "./synthetic.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const template = await loadFixedTemplate(repoRoot);
const baseWorld = buildSyntheticWorld({ template });

const receipt = () => structuredClone(baseWorld.receipt);
const setup = () => structuredClone(baseWorld.setupReceipt);

function errorsAfter(mutate, validator = validateReceipt, source = receipt) {
  const value = source();
  mutate(value);
  return validator(value);
}

const positive = (value) =>
  value.requests.find((row) => row.requestKind === "positive");
const reject = (value) =>
  value.requests.find((row) => row.requestKind === "reject");

test("receipt: the synthetic receipt and setup receipt fit their schemas", () => {
  assert.equal(RECEIPT_SCHEMA_VERSION, "nir1-final-request-receipt/1");
  assert.equal(
    SETUP_RECEIPT_SCHEMA_VERSION,
    "nir1-final-request-setup-receipt/1",
  );
  assert.deepEqual(validateReceipt(receipt()), []);
  assert.deepEqual(validateSetupReceipt(setup()), []);
  const p12 = buildSyntheticP12({ template });
  assert.deepEqual(
    validateReceipt({ ...receipt(), requests: [p12.request] }),
    [],
  );
});

test("receipt: required fields are closed and unknown fields are rejected", () => {
  for (const [mutate, expected] of [
    [
      (r) => {
        r.schemaVersion = "x";
      },
      "schemaVersion",
    ],
    [
      (r) => {
        r.contractId = "x";
      },
      "contractId",
    ],
    [
      (r) => {
        r.draftRef = "x";
      },
      "draftRef",
    ],
    [
      (r) => {
        delete r.producer;
      },
      "receipt.producer is required",
    ],
    [
      (r) => {
        r.producer.entry = "electron-journey";
      },
      "producer.entry",
    ],
    [
      (r) => {
        r.producer.featureSet = [];
      },
      "featureSet",
    ],
    [
      (r) => {
        r.run.commit = "abc";
      },
      "run.commit",
    ],
    [
      (r) => {
        r.run.tree = "abc";
      },
      "run.tree",
    ],
    [
      (r) => {
        r.run.workspaceClean = false;
      },
      "workspaceClean",
    ],
    [
      (r) => {
        r.freeze.commit = "abc";
      },
      "freeze.commit",
    ],
    [
      (r) => {
        r.freeze.recordSha256 = "abc";
      },
      "recordSha256",
    ],
    [
      (r) => {
        r.inputs.scorerSha256 = "abc";
      },
      "scorerSha256",
    ],
    [
      (r) => {
        r.inputs.fixtureVersion = 0;
      },
      "fixtureVersion",
    ],
    [
      (r) => {
        delete r.inputs.fixedTemplate.sha256;
      },
      "fixedTemplate.sha256",
    ],
    [
      (r) => {
        r.requests = [];
      },
      "requests must be a non-empty array",
    ],
    [
      (r) => {
        r.surprise = 1;
      },
      "receipt.surprise is not a known field",
    ],
    [
      (r) => {
        r.requests[0].surprise = 1;
      },
      "surprise is not a known field",
    ],
  ]) {
    assert.ok(
      errorsAfter(mutate).some((e) => e.includes(expected)),
      expected,
    );
  }
});

test("receipt: extensions are the one place a later phase may add fields", () => {
  const value = receipt();
  value.extensions = { dd1: { recorder: true } };
  value.requests[0].extensions = { dd1: 1 };
  value.producer.extensions = { dd1: 1 };
  assert.deepEqual(validateReceipt(value), []);
  assert.ok(
    errorsAfter((r) => {
      r.extensions = "x";
    }).some((e) => e.includes("extensions must be an object")),
  );
});

test("receipt: a duplicate request id is rejected", () => {
  assert.ok(
    errorsAfter((r) => {
      r.requests[1].requestId = r.requests[0].requestId;
    }).some((e) => e.includes("duplicate requestId")),
  );
});

test("receipt: D-final's result is Ok with a digest or Err with a code", () => {
  for (const [mutate, expected] of [
    [
      (r) => {
        positive(r).dfinal.payloadDigest = "abc";
      },
      "sha256:<hex> digest for Ok",
    ],
    [
      (r) => {
        positive(r).dfinal.code = "X";
      },
      "Ok must not carry a code",
    ],
    [
      (r) => {
        positive(r).dfinal.outcome = "maybe";
      },
      "ok or err",
    ],
    [
      (r) => {
        reject(r).dfinal.code = "";
      },
      "code is required",
    ],
    [
      (r) => {
        reject(r).dfinal.payloadDigest = `sha256:${"0".repeat(64)}`;
      },
      "Err must not carry a payload digest",
    ],
  ]) {
    assert.ok(
      errorsAfter(mutate).some((e) => e.includes(expected)),
      expected,
    );
  }
});

test("receipt: the capture carries the (c-1) set and the (c-2) rendering", () => {
  for (const [mutate, expected] of [
    [
      (r) => {
        delete positive(r).capture.userMessage.digestSha256;
      },
      "userMessage.digestSha256",
    ],
    [
      (r) => {
        positive(r).capture.userMessage.digestSha256 = "xyz";
      },
      "digestSha256 must be a lowercase sha256 hex",
    ],
    [
      (r) => {
        positive(r).capture.userMessage.text = "";
      },
      "userMessage.text",
    ],
    [
      (r) => {
        delete positive(r).capture.snapshotIdentity;
      },
      "snapshotIdentity",
    ],
    [
      (r) => {
        delete positive(r).capture.route.model;
      },
      "route.model",
    ],
    [
      (r) => {
        positive(r).capture.route.contextWindowTokens = 0;
      },
      "contextWindowTokens",
    ],
    [
      (r) => {
        delete positive(r).capture.template.ref;
      },
      "template.ref",
    ],
    [
      (r) => {
        positive(r).capture.passedRevisionIds = "x";
      },
      "passedRevisionIds",
    ],
    [
      (r) => {
        delete positive(r).capture.candidateSet.digest;
      },
      "candidateSet.digest",
    ],
    [
      (r) => {
        positive(r).capture.candidateSet.items = [];
      },
      "items must be a non-empty array",
    ],
    [
      (r) => {
        positive(r).capture.candidateSet.items[1].atomicPart = "tail";
      },
      "atomicPart",
    ],
    [
      (r) => {
        positive(r).capture.candidateSet.items[0].atomicGroup = "g";
      },
      "raw item must not carry",
    ],
    [
      (r) => {
        delete positive(r).capture.candidateSet.items[1].ownerId;
      },
      "ownerId",
    ],
    [
      (r) => {
        positive(r).capture.candidateSet.candidateRefs = "x";
      },
      "candidateRefs must be an array",
    ],
    [
      (r) => {
        delete positive(r).capture.rendered.inputReferences;
      },
      "inputReferences",
    ],
    [
      (r) => {
        delete positive(r).capture.rendered.payloadDigest;
      },
      "rendered.payloadDigest",
    ],
    [
      (r) => {
        positive(r).capture.rendered.renderCorrespondence[0].position.kind =
          "user";
      },
      "known position",
    ],
    [
      (r) => {
        positive(r).capture.rendered.renderCorrespondence[1].position.index =
          -1;
      },
      "position.index",
    ],
  ]) {
    assert.ok(
      errorsAfter(mutate).some((e) => e.includes(expected)),
      expected,
    );
  }
});

test("receipt: input references and qualification rows are typed", () => {
  const errors = [];
  validateInputReference(
    { role: "context", target: { kind: "accepted-revision", revisionId: "r" } },
    "ref",
    errors,
  );
  assert.ok(errors.some((e) => e.includes("bundleDigest")));
  const bad = [];
  validateInputReference(
    { role: "wrong", target: { kind: "unknown" } },
    "ref",
    bad,
  );
  assert.equal(bad.length, 2);

  const rowErrors = (row, withOrdinal = true) => {
    const found = [];
    validateQualificationRow(row, "row", found, { withOrdinal });
    return found;
  };
  assert.deepEqual(
    rowErrors({
      inputOrdinal: 0,
      state: "present",
      kind: "source",
      identity: "a",
      version: "b",
    }),
    [],
  );
  assert.deepEqual(
    rowErrors({
      inputOrdinal: 0,
      state: "not-applicable",
      kind: "index",
      reason: "not-index-derived",
    }),
    [],
  );
  assert.deepEqual(
    rowErrors(
      {
        state: "present",
        kind: "scope",
        identity: "a",
        version: "b",
        scopeRole: "r",
      },
      false,
    ),
    [],
  );
  assert.ok(
    rowErrors({
      inputOrdinal: 0,
      state: "present",
      kind: "scope",
      identity: "a",
      version: "b",
    }).some((e) => e.includes("scopeRole")),
  );
  assert.ok(
    rowErrors({
      inputOrdinal: 0,
      state: "present",
      kind: "source",
      identity: "a",
      version: "b",
      scopeRole: "r",
    }).some((e) => e.includes("only valid for a scope")),
  );
  assert.ok(
    rowErrors({ inputOrdinal: 0, state: "not-applicable", kind: "index" }).some(
      (e) => e.includes("reason is required"),
    ),
  );
  assert.ok(
    rowErrors({
      inputOrdinal: 0,
      state: "not-applicable",
      kind: "index",
      reason: "r",
      identity: "a",
    }).some((e) => e.includes("not valid for a typed N/A")),
  );
  assert.ok(
    rowErrors({
      inputOrdinal: 0,
      state: "present",
      kind: "weird",
      identity: "a",
      version: "b",
    }).some((e) => e.includes("known qualification kind")),
  );
  assert.ok(
    rowErrors({
      state: "present",
      kind: "source",
      identity: "a",
      version: "b",
    }).some((e) => e.includes("inputOrdinal is required")),
  );
  assert.deepEqual(
    [...QUALIFICATION_KINDS],
    ["source", "revision", "decision", "freshness", "index", "scope", "d1"],
  );
});

test("receipt: arms carry a payload only when rendered; the baseline brings its own render input", () => {
  assert.ok(
    errorsAfter((r) => {
      positive(r).candidate.arm = "baseline";
    }).some((e) => e.includes("candidate.arm must be candidate")),
  );
  assert.ok(
    errorsAfter((r) => {
      delete positive(r).candidate.payload;
    }).some((e) => e.includes("payload is required")),
  );
  const p12 = buildSyntheticP12({ template });
  const withRequest = (mutate) => {
    const request = structuredClone(p12.request);
    mutate(request);
    return validateReceipt({ ...receipt(), requests: [request] });
  };
  assert.ok(
    withRequest((q) => {
      q.baseline.outcome = "unrenderable";
    }).some((e) => e.includes("must not carry a payload")),
  );
  assert.ok(
    withRequest((q) => {
      delete q.baseline.inputs;
    }).some((e) => e.includes("baseline.inputs")),
  );
  assert.ok(
    withRequest((q) => {
      delete q.baseline.inputReferences;
    }).some((e) => e.includes("inputReferences")),
  );
  assert.ok(
    withRequest((q) => {
      q.baseline.counters = { qualifiedEvidence: -1 };
    }).some((e) => e.includes("counters")),
  );
  assert.ok(
    withRequest((q) => {
      q.baseline.outcome = "other";
    }).some((e) => e.includes("known arm outcome")),
  );
  const unrenderable = structuredClone(p12.request);
  unrenderable.baseline = {
    arm: "baseline",
    outcome: "unrenderable",
    reason: "raw-only",
    persistedRows: 0,
  };
  assert.deepEqual(
    validateReceipt({ ...receipt(), requests: [unrenderable] }),
    [],
  );
});

test("receipt: history and attempt rows are required in every request", () => {
  assert.ok(
    errorsAfter((r) => {
      delete positive(r).history;
    }).some((e) => e.includes("history")),
  );
  assert.ok(
    errorsAfter((r) => {
      positive(r).history.inputCount = -1;
    }).some((e) => e.includes("inputCount")),
  );
  assert.ok(
    errorsAfter((r) => {
      positive(r).attemptRowsAdded = -1;
    }).some((e) => e.includes("attemptRowsAdded")),
  );
  assert.ok(
    errorsAfter((r) => {
      positive(r).stage = 0;
    }).some((e) => e.includes("stage")),
  );
  assert.ok(
    errorsAfter((r) => {
      positive(r).requestKind = "maybe";
    }).some((e) => e.includes("requestKind")),
  );
  assert.ok(
    errorsAfter((r) => {
      positive(r).passedRevisionIds = [];
    }).some((e) => e.includes("passedRevisionIds")),
  );
});

test("setup receipt: events, writers, verifications and the chat session are typed", () => {
  const withSetup = (mutate) =>
    errorsAfter(mutate, validateSetupReceipt, setup);
  for (const [mutate, expected] of [
    [
      (s) => {
        s.schemaVersion = "x";
      },
      "schemaVersion",
    ],
    [
      (s) => {
        s.run.commit = "abc";
      },
      "run.commit",
    ],
    [
      (s) => {
        s.cases = [];
      },
      "cases must be a non-empty array",
    ],
    [
      (s) => {
        s.cases[1].caseId = s.cases[0].caseId;
        s.cases[1].variantId = s.cases[0].variantId;
      },
      "duplicate",
    ],
    [
      (s) => {
        s.cases[0].events[0].kind = "dml";
      },
      "known setup event kind",
    ],
    [
      (s) => {
        s.cases[0].events[0].seq = 0;
      },
      "seq",
    ],
    [
      (s) => {
        delete s.cases[0].events[0].writer;
      },
      "writer",
    ],
    [
      (s) => {
        s.cases[0].events = [];
      },
      "events must be a non-empty array",
    ],
    [
      (s) => {
        s.cases[0].directDmlObserved = "no";
      },
      "directDmlObserved",
    ],
    [
      (s) => {
        s.cases[0].writersUsed = [];
      },
      "writersUsed",
    ],
    [
      (s) => {
        s.cases[0].verifications[0].point = "later";
      },
      "setup-end or request-pre",
    ],
    [
      (s) => {
        delete s.cases[0].verifications[0].scopeAuthorityRevision;
      },
      "scopeAuthorityRevision",
    ],
    [
      (s) => {
        delete s.cases[0].verifications[0].d2a.restricted;
      },
      "d2a.restricted",
    ],
    [
      (s) => {
        delete s.cases[0].verifications[0].revisions[0].a3;
      },
      "a3 is required",
    ],
    [
      (s) => {
        s.cases[0].idMap[0] = { logicalId: "x" };
      },
      "runtimeId",
    ],
    [
      (s) => {
        delete s.cases[0].chatSession.statementMatchesRenderer;
      },
      "statementMatchesRenderer",
    ],
    [
      (s) => {
        delete s.cases[0].history;
      },
      "history",
    ],
    [
      (s) => {
        s.cases[0].valid = false;
      },
      "invalidReason is required",
    ],
    [
      (s) => {
        s.cases[0].surprise = 1;
      },
      "surprise is not a known field",
    ],
  ]) {
    assert.ok(
      withSetup(mutate).some((e) => e.includes(expected)),
      expected,
    );
  }
  assert.deepEqual(
    withSetup((s) => {
      s.cases[0].valid = false;
      s.cases[0].invalidReason = "scope authority changed";
    }),
    [],
  );
});

test("setup receipt: a binding-change event names one of the five P-10 binding kinds", () => {
  const withEvent = (event) =>
    errorsAfter(
      (s) => {
        s.cases[0].events[0] = {
          seq: 1,
          stage: 1,
          writer: "narrative_extraction_append_human_decision",
          ...event,
        };
      },
      validateSetupReceipt,
      setup,
    );
  for (const binding of BINDING_KINDS) {
    assert.deepEqual(withEvent({ kind: "binding-change", binding }), []);
  }
  assert.ok(
    withEvent({ kind: "binding-change" }).some((e) =>
      e.includes("binding is required"),
    ),
  );
  assert.ok(
    withEvent({ kind: "binding-change", binding: "index-generation" }).some(
      (e) => e.includes("binding must be one of"),
    ),
  );
});

test("product writers are the draft's list and nothing like a raw SQL writer", () => {
  assert.ok(PRODUCT_WRITERS.includes("nir1_entity_relation_revision_prepare"));
  assert.ok(
    PRODUCT_WRITERS.includes("narrative_extraction_append_human_decision"),
  );
  assert.ok(PRODUCT_WRITERS.includes("db_execute:createSession"));
  assert.ok(PRODUCT_WRITERS.includes("activate_first_restricted_publication"));
  assert.ok(!PRODUCT_WRITERS.some((name) => /sql|insert|dml|seed/i.test(name)));
});

// Not routed commands: the Rust settings writer, the renderer's createSession
// statement and the Native activation function.
const UNROUTED_WRITERS = new Set([
  "write_ai_settings",
  "db_execute:createSession",
  "activate_first_restricted_publication",
]);

function internalCommands() {
  const source = readFileSync(
    path.join(repoRoot, "electron/main/profileEgress.ts"),
    "utf8",
  );
  const start = source.indexOf("const INTERNAL_COMMANDS = new Set([");
  assert.ok(start >= 0, "INTERNAL_COMMANDS must exist in profileEgress.ts");
  const end = source.indexOf("]);", start);
  return new Set(
    [...source.slice(start, end).matchAll(/^\s*"([a-z0-9_]+)",/gm)].map(
      (match) => match[1],
    ),
  );
}

test("product writers: every routed writer is in the product's internal command table", () => {
  const routed = internalCommands();
  assert.ok(routed.size > 100);
  for (const name of PRODUCT_WRITERS) {
    if (UNROUTED_WRITERS.has(name)) continue;
    assert.ok(routed.has(name), `${name} is not an internal command`);
  }
  // The writers a setup needs to create Scenes and write the tree, the
  // Scope, the Chronicle, the project and the Codex are all named.
  for (const name of [
    "tree_node_create",
    "tree_node_patch",
    "save_scene_body_bundle",
    "narrative_scene_scope_update",
    "narrative_scene_scope_registry_update",
    "temporal_scene_patch",
    "chronicle_bulk_mutate",
    "project_patch",
    "codex_create",
    "codex_mutate",
    "save_ai_settings",
  ]) {
    assert.ok(PRODUCT_WRITERS.includes(name), `${name} must be allowed`);
  }
});
