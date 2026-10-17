// Scorer tests on synthetic receipts (hand-built values; Native is not run).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DPH_CASE_IDS } from "./contract.mjs";
import {
  canonicalJson,
  escapeReservedPromptTags,
  estimateTokens,
  loadFixedTemplate,
  payloadDigest,
} from "./payload.mjs";
import { SAME_INPUT_FIELDS } from "./receipt.mjs";
import {
  alignEntries,
  checkSameInput,
  deriveSlots,
  readPayload,
  resolveExpectedTemplate,
  scanForbidden,
  scoreFinalRequestReceipt,
  scoreP12Pair,
  scorerDigest,
} from "./scorer.mjs";
import {
  CANARIES,
  SYNTHETIC_ROUTE,
  addSyntheticDiagnostic,
  buildSyntheticP12,
  buildSyntheticWorld,
  renderSynthetic,
  repayload,
  requestOf,
  setupOf,
} from "./synthetic.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const template = await loadFixedTemplate(repoRoot);
const baseWorld = buildSyntheticWorld({ template });

function world() {
  return structuredClone(baseWorld);
}

function score(w) {
  return scoreFinalRequestReceipt({
    fixture: w.fixture,
    receipt: w.receipt,
    setupReceipt: w.setupReceipt,
    template,
    expectedInputs: w.expectedInputs,
  });
}

function result(scored, caseId, variantId, stage = 1) {
  return scored.requests.find(
    (row) =>
      row.caseId === caseId &&
      row.variantId === variantId &&
      row.stage === stage,
  );
}

function codes(entry) {
  return [...entry.failures, ...entry.invalid].map((row) => row.code);
}

function injectIntoRaw(system, text) {
  return system.replace("\n</current_scene>", ` ${text}\n</current_scene>`);
}

const positiveId = (caseId) => `${caseId}-positive`;
const rejectId = (caseId) => `${caseId}-reject-stale`;

/** Rewrites the system message's codex entries and keeps the correspondence in step. */
function rewriteEntries(request, mutate) {
  repayload(request, (payload) => {
    const system = payload.messages[0].content;
    const open = "<codex_entries>\n";
    const close = "\n</codex_entries>";
    const start = system.indexOf(open) + open.length;
    const end = system.lastIndexOf(close);
    const entries = system.slice(start, end).split("\n");
    const rows = request.capture.rendered.renderCorrespondence.filter(
      (row) => row.position.kind === "system-codex-entry",
    );
    const next = mutate(
      entries.map((text, index) => ({
        text,
        inputOrdinal: rows[index].inputOrdinal,
      })),
    );
    payload.messages[0].content = `${system.slice(0, start)}${next.map((row) => row.text).join("\n")}${system.slice(end)}`;
    const scene = request.capture.rendered.renderCorrespondence.filter(
      (row) => row.position.kind === "system-current-scene",
    );
    const correspondence = [
      ...scene,
      ...next.map((row, index) => ({
        position: { kind: "system-codex-entry", index },
        inputOrdinal: row.inputOrdinal,
      })),
    ];
    request.capture.rendered.renderCorrespondence = correspondence;
    request.candidate.renderCorrespondence = correspondence;
  });
}

// ------------------------------------------------------------- acceptance

test("scores-positive-variants-from-receipt", () => {
  const scored = score(world());
  assert.equal(scored.status, "passed", JSON.stringify(scored.failures));
  for (const caseId of DPH_CASE_IDS) {
    const entry = result(scored, caseId, positiveId(caseId));
    assert.equal(
      entry.status,
      "passed",
      `${caseId}: ${JSON.stringify(codes(entry))}`,
    );
    assert.equal(entry.requestKind, "positive");
  }
  assert.equal(scored.summary.positive.total, 11);
  assert.equal(scored.summary.positive.passed, 11);
  assert.deepEqual(scored.evidence, {
    scope: "dp-h",
    dp1Evidence: false,
    p12: "not-measured",
    rejectVariantsCountTowardDp1: false,
  });
});

test("retention-forbidden-prose-quote-window: every case scores a clean payload", () => {
  const w = world();
  for (const caseId of DPH_CASE_IDS) {
    const request = requestOf(w.receipt, caseId, positiveId(caseId));
    const parsed = JSON.parse(request.candidate.payload);
    assert.ok(parsed.messages[0].content.includes(`MARKER-${caseId}-raw`));
    for (const canary of CANARIES) {
      assert.ok(!request.candidate.payload.includes(canary.text));
    }
  }
  assert.equal(score(w).status, "passed");
});

test("retention-forbidden-prose-quote-window: a missing required entry fails retention and the atomic group", () => {
  for (const caseId of DPH_CASE_IDS) {
    const w = world();
    const request = requestOf(
      w.receipt,
      caseId,
      positiveId(caseId),
      caseId === "P-10" ? 2 : 1,
    );
    rewriteEntries(request, (rows) => rows.filter((_, index) => index !== 3));
    const entry = result(score(w), caseId, positiveId(caseId), request.stage);
    assert.equal(entry.status, "failed", caseId);
    assert.ok(codes(entry).includes("required-entry-missing"), caseId);
    assert.ok(codes(entry).includes("atomic-group-partial"), caseId);
  }
});

test("retention-forbidden-prose-quote-window: changed prose order fails", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  rewriteEntries(request, (rows) => [...rows.slice(5), ...rows.slice(0, 5)]);
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "failed");
  assert.ok(codes(entry).includes("prose-order-changed"));
});

test("retention-forbidden-prose-quote-window: an altered exact quote fails", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-04", positiveId("P-04"));
  repayload(request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "the bell rang twice at dusk",
      "the bell rang once at dusk",
    );
  });
  const entry = result(score(w), "P-04", positiveId("P-04"));
  assert.equal(entry.status, "failed");
  assert.ok(codes(entry).includes("exact-quote-missing"));
  assert.ok(codes(entry).includes("required-entry-missing"));
  assert.ok(codes(entry).includes("entry-not-in-candidate-set"));
});

test("retention-forbidden-prose-quote-window: Raw text must be the frozen Raw", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-02", positiveId("P-02"));
  repayload(request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "雨が止んだ。",
      "雨が降った。",
    );
  });
  const entry = result(score(w), "P-02", positiveId("P-02"));
  assert.equal(entry.status, "failed");
  assert.ok(codes(entry).includes("raw-mismatch"));
});

test("window-exceeded-fails", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-05", positiveId("P-05"));
  repayload(request, (payload) => {
    payload.max_tokens = 100000;
  });
  const entry = result(score(w), "P-05", positiveId("P-05"));
  assert.equal(entry.status, "failed");
  assert.ok(codes(entry).includes("window-exceeded"));
});

test("selection over the context budget fails even when the window is not exceeded", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-06", positiveId("P-06"));
  const budget = request.capture.contextBudgetTokens;
  w.fixture.cases.find(
    (c) => c.caseId === "P-06",
  ).variants[0].requests[0].expected.contextBudgetTokens = budget;
  request.capture.candidateSet.items[0].tokens = budget + 1;
  const entry = result(score(w), "P-06", positiveId("P-06"));
  assert.ok(codes(entry).includes("selection-exceeds-budget"));
  assert.ok(codes(entry).includes("item-token-estimate-mismatch"));
});

test("forbidden-and-canary-scan: canaries, forbidden strings and ids, other cases' material", () => {
  for (const [mutate, code] of [
    [
      (system) => injectIntoRaw(system, `${CANARIES[0].text}`),
      "canary-in-payload",
    ],
    [
      (system) => injectIntoRaw(system, `${CANARIES[1].text}`),
      "canary-in-payload",
    ],
    [
      (system) => injectIntoRaw(system, `FORBIDDEN-TEXT-P-07`),
      "forbidden-text",
    ],
    [(system) => injectIntoRaw(system, `rev-P-07-bad`), "forbidden-id"],
    [(system) => injectIntoRaw(system, `rt:rev-P-07-bad`), "forbidden-id"],
    [
      (system) => injectIntoRaw(system, `MARKER-P-08-raw`),
      "other-case-material",
    ],
    [(system) => injectIntoRaw(system, `rt:rev-P-08-a`), "other-case-material"],
  ]) {
    const w = world();
    const request = requestOf(w.receipt, "P-07", positiveId("P-07"));
    repayload(request, (payload) => {
      payload.messages[0].content = mutate(payload.messages[0].content);
    });
    const entry = result(score(w), "P-07", positiveId("P-07"));
    assert.equal(entry.status, "failed", code);
    assert.ok(
      codes(entry).includes(code),
      `${code}: ${JSON.stringify(codes(entry))}`,
    );
  }
});

test("forbidden-and-canary-scan: unit", () => {
  const failures = scanForbidden({
    payload: '{"a":"x CANARY-DECISION-NOTE-7f3a91"}',
    system: "x CANARY-DECISION-NOTE-7f3a91",
    user: "",
    canaries: CANARIES,
    forbiddenTexts: ["nope"],
    forbiddenIds: [],
    otherMarkers: [],
    otherIds: [],
  });
  assert.deepEqual(
    failures.map((f) => f.code),
    ["canary-in-payload"],
  );
});

// ---------------------------------------------------------------- reject

test("scores-reject-variants-by-code-and-reason", () => {
  const scored = score(world());
  for (const caseId of DPH_CASE_IDS) {
    const stage = caseId === "P-10" ? 2 : 1;
    const entry = result(scored, caseId, rejectId(caseId), stage);
    assert.equal(entry.requestKind, "reject");
    assert.equal(entry.status, "passed", caseId);
  }
  assert.equal(scored.summary.reject.total, 9);
  assert.equal(scored.summary.reject.passed, 9);
});

test("reject-variant: a wrong code, a wrong reason or an Ok result fails", () => {
  for (const [mutate, code] of [
    [
      (r) => {
        r.dfinal.code = "NIR1_NATIVE_SOMETHING_ELSE";
      },
      "reject-code-mismatch",
    ],
    [
      (r) => {
        r.dfinal.reason = "revision-rejected";
      },
      "reject-reason-mismatch",
    ],
    [
      (r) => {
        delete r.dfinal.reason;
      },
      "reject-reason-mismatch",
    ],
    [
      (r) => {
        r.dfinal = { outcome: "ok", payloadDigest: `sha256:${"0".repeat(64)}` };
      },
      "reject-unexpected-ok",
    ],
  ]) {
    const w = world();
    mutate(requestOf(w.receipt, "P-02", rejectId("P-02")));
    const entry = result(score(w), "P-02", rejectId("P-02"));
    assert.equal(entry.status, "failed", code);
    assert.ok(codes(entry).includes(code), code);
  }
});

test("reject-variant: a payload, capture, baseline or attempt fails", () => {
  const donor = requestOf(world().receipt, "P-02", positiveId("P-02"));
  for (const [mutate, code] of [
    [
      (r) => {
        r.candidate = structuredClone(donor.candidate);
      },
      "reject-payload-present",
    ],
    [
      (r) => {
        r.capture = structuredClone(donor.capture);
      },
      "reject-capture-present",
    ],
    [
      (r) => {
        r.attemptRowsAdded = 1;
      },
      "reject-attempt-present",
    ],
  ]) {
    const w = world();
    mutate(requestOf(w.receipt, "P-02", rejectId("P-02")));
    const entry = result(score(w), "P-02", rejectId("P-02"));
    assert.equal(entry.status, "failed", code);
    assert.ok(codes(entry).includes(code), code);
  }
});

test("reject-variant-never-counts-as-dp1", () => {
  const w = world();
  // Every positive variant fails; all reject variants still pass.
  for (const caseId of DPH_CASE_IDS) {
    const request = requestOf(
      w.receipt,
      caseId,
      positiveId(caseId),
      caseId === "P-10" ? 2 : 1,
    );
    rewriteEntries(request, (rows) => rows.slice(0, 5));
  }
  const scored = score(w);
  assert.equal(scored.status, "failed");
  assert.equal(scored.summary.reject.passed, 9);
  assert.equal(scored.evidence.dp1Evidence, false);
  assert.equal(scored.evidence.rejectVariantsCountTowardDp1, false);
  for (const entry of scored.requests.filter(
    (row) => row.requestKind === "reject",
  )) {
    assert.equal(entry.countsAsPositiveEvidence, false);
    assert.equal(entry.countsAsDp1Evidence, false);
  }
  for (const entry of scored.requests)
    assert.equal(entry.countsAsDp1Evidence, false);
});

// --------------------------------------------------------- qualification

test("scorer-skips-non-ok-and-digest-mismatch", () => {
  {
    const w = world();
    const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
    request.dfinal = {
      outcome: "err",
      code: "NIR1_PREPARED_CONTEXT_WINDOW_EXCEEDED",
    };
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "failed");
    assert.deepEqual(codes(entry), ["dfinal-not-ok"]);
  }
  {
    const w = world();
    const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
    request.dfinal.payloadDigest = `sha256:${"9".repeat(64)}`;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "failed");
    assert.deepEqual(codes(entry), ["payload-digest-mismatch"]);
  }
  {
    // The three digests agree but not with the payload bytes.
    const w = world();
    const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
    const forged = `sha256:${"7".repeat(64)}`;
    request.dfinal.payloadDigest = forged;
    request.candidate.payloadDigest = forged;
    request.capture.rendered.payloadDigest = forged;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.deepEqual(codes(entry), ["payload-digest-recompute"]);
  }
  {
    const p12 = buildSyntheticP12({ template });
    p12.request.dfinal = {
      outcome: "err",
      code: "NIR1_PREPARED_CONTEXT_WINDOW_EXCEEDED",
    };
    const scored = scoreP12Pair({
      request: p12.request,
      expectation: p12.expectation,
      template,
      fixtureRoute: p12.route,
      fixture: p12.fixture,
    });
    assert.equal(scored.status, "failed");
    assert.ok(scored.failures.some((f) => f.code === "dfinal-not-ok"));
    assert.ok(
      scored.failures.some(
        (f) => f.code === "baseline-called-for-unqualified-request",
      ),
    );
    assert.equal(scored.candidateSlot, null);
  }
});

test("baseline arm is not allowed on P-01 to P-11", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  const p12 = buildSyntheticP12({ template });
  request.baseline = p12.request.baseline;
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.ok(codes(entry).includes("baseline-not-allowed"));
});

test("history-slot: a history input fails a DP-H request", () => {
  const w = world();
  requestOf(w.receipt, "P-01", positiveId("P-01")).history = {
    inputCount: 1,
    reason: "k4-rule",
  };
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.ok(codes(entry).includes("history-input-present"));
});

// ------------------------------------------------------------ same input

test("same-input-check-rejects-*: a captured figure that differs from the frozen one fails", () => {
  const cases = [
    [
      "userMessageDigestSha256",
      (r) => {
        r.capture.userMessage.digestSha256 = "0".repeat(64);
      },
    ],
    [
      "estimatorVersion",
      (r) => {
        r.capture.estimatorVersion = "other-estimator";
      },
    ],
    [
      "template",
      (r) => {
        r.capture.template.ref = "other/ref";
      },
    ],
    [
      "contextBudgetTokens",
      (r) => {
        r.capture.contextBudgetTokens += 1;
      },
    ],
    [
      "passedRevisionIds",
      (r) => {
        r.capture.passedRevisionIds = [
          ...r.capture.passedRevisionIds,
        ].reverse();
      },
    ],
    [
      "measure",
      (r) => {
        r.capture.measure = "message-count";
      },
    ],
    [
      "route",
      (r) => {
        r.capture.route.contextWindowTokens += 1;
      },
    ],
    [
      "userMessage",
      (r) => {
        r.capture.userMessage.text += "x";
      },
    ],
  ];
  for (const [field, mutate] of cases) {
    const w = world();
    mutate(requestOf(w.receipt, "P-01", positiveId("P-01")));
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "failed", field);
    assert.ok(
      codes(entry).some((code) =>
        code.startsWith(`same-input-check-rejects-${field}`),
      ),
      `${field}: ${JSON.stringify(codes(entry))}`,
    );
  }
});

test("same-input-check-rejects-*: the Revision ids passed to D-final must be the fixture's list", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.passedRevisionIds = ["rt:rev-P-01-a"];
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.ok(
    codes(entry).includes("same-input-check-rejects-passedRevisionIds"),
  );
});

test("same-input-check-rejects-*: each P-12 arm input field is checked on its own", () => {
  const mutations = {
    capturedTurnId: (inputs) => {
      inputs.capturedTurnId = "turn-other";
    },
    userMessageDigestSha256: (inputs) => {
      inputs.userMessageDigestSha256 = "e".repeat(64);
    },
    snapshotIdentity: (inputs) => {
      inputs.snapshotIdentity = "snapshot-other";
    },
    candidateSetDigest: (inputs) => {
      inputs.candidateSetDigest = "set-other";
    },
    estimatorVersion: (inputs) => {
      inputs.estimatorVersion = "estimator-other";
    },
    template: (inputs) => {
      inputs.template = { ...inputs.template, version: "template-other" };
    },
    route: (inputs) => {
      inputs.route = { ...inputs.route, routeRevision: "route-other" };
    },
    contextBudgetTokens: (inputs) => {
      inputs.contextBudgetTokens -= 1;
    },
    measure: (inputs) => {
      inputs.measure = "tiktoken";
    },
    passedRevisionIds: (inputs) => {
      inputs.passedRevisionIds = ["rt:other"];
    },
  };
  assert.deepEqual(
    Object.keys(mutations).sort(),
    [...SAME_INPUT_FIELDS].sort(),
  );
  for (const [field, mutate] of Object.entries(mutations)) {
    const p12 = buildSyntheticP12({ template });
    mutate(p12.request.baseline.inputs);
    const scored = scoreP12Pair({
      request: p12.request,
      expectation: p12.expectation,
      template,
      fixtureRoute: p12.route,
      fixture: p12.fixture,
    });
    assert.equal(scored.status, "failed", field);
    assert.ok(
      scored.failures.some(
        (f) => f.code === `same-input-check-rejects-${field}`,
      ),
      `${field}: ${JSON.stringify(scored.failures.map((f) => f.code))}`,
    );
  }
  assert.deepEqual(
    checkSameInput(
      { ...buildSyntheticP12({ template }).request.baseline.inputs },
      {},
      { label: "x" },
    ),
    [],
  );
});

// --------------------------------------------------------------- slots

test("slot-derivation: the slot is counted from the payload, not from a counter", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.candidate.counters = { qualifiedEvidence: 1 };
  p12.request.baseline.counters = { qualifiedEvidence: 0 };
  const honest = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(honest.status, "passed", JSON.stringify(honest.failures));
  assert.equal(honest.candidateSlot, 1);
  assert.equal(honest.baselineSlot, 0);

  p12.request.baseline.counters = { qualifiedEvidence: 1 };
  const forged = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(forged.status, "failed");
  assert.ok(forged.failures.some((f) => f.code === "slot-counter-mismatch"));
});

test("slot-derivation: the entry count must match the render correspondence", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.capture.rendered.renderCorrespondence.pop();
  p12.request.candidate.renderCorrespondence.pop();
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "entry-count-mismatch"));
});

test("slot-derivation: an item text with the separator fails", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.capture.candidateSet.items[1].text += "\nsecond line";
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.ok(scored.failures.some((f) => f.code === "separator-in-text"));
});

test("slot-derivation: a malformed system message fails", () => {
  const p12 = buildSyntheticP12({ template });
  repayload(p12.request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "<codex_entries>",
      "<codex_notes>",
    );
  });
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "failed");
  assert.ok(
    scored.failures.some(
      (f) => f.code === "payload-shape:system-block-shape-mismatch",
    ),
  );
});

test("slot-derivation: parts that are not five consecutive entries of one group do not count", () => {
  const p12 = buildSyntheticP12({ template });
  const view = {
    payload: p12.request.candidate.payload,
    renderCorrespondence: p12.request.capture.rendered.renderCorrespondence,
    inputReferences: p12.request.capture.rendered.inputReferences,
    qualifications: p12.request.capture.rendered.qualifications,
  };
  const read = readPayload(view, p12.request.capture, template);
  const alignment = alignEntries({
    ...read,
    view,
    capture: p12.request.capture,
  });
  const groups = [{ ownerId: "rt:graph-g", kind: "graph-evidence" }];
  const intact = deriveSlots({
    improvementGroups: groups,
    ...read,
    view,
    capture: p12.request.capture,
    matched: alignment.matched,
  });
  assert.equal(intact.qualifiedEvidence, 1);
  // Swap two parts of the group in the matched positions: no longer in group order.
  const matched = [...alignment.matched];
  [matched[6], matched[7]] = [matched[7], matched[6]];
  assert.equal(
    deriveSlots({
      improvementGroups: groups,
      ...read,
      view,
      capture: p12.request.capture,
      matched,
    }).qualifiedEvidence,
    0,
  );
  // A group that is not of the declared kind does not count.
  assert.equal(
    deriveSlots({
      improvementGroups: [{ ownerId: "rt:graph-g", kind: "accepted-ir" }],
      ...read,
      view,
      capture: p12.request.capture,
      matched: alignment.matched,
    }).qualifiedEvidence,
    0,
  );
  // A group without a complete qualification ref set does not count.
  const incomplete = structuredClone(view);
  incomplete.qualifications = incomplete.qualifications.filter(
    (row) => !(row.inputOrdinal === 3 && row.kind === "freshness"),
  );
  assert.equal(
    deriveSlots({
      improvementGroups: groups,
      ...read,
      view: incomplete,
      capture: p12.request.capture,
      matched: alignment.matched,
    }).qualifiedEvidence,
    0,
  );
});

test("slot-derivation: five parts that sit on different inputs, or on another owner's input, do not count", () => {
  const p12 = buildSyntheticP12({ template });
  const view = {
    payload: p12.request.candidate.payload,
    renderCorrespondence: p12.request.capture.rendered.renderCorrespondence,
    inputReferences: p12.request.capture.rendered.inputReferences,
    qualifications: p12.request.capture.rendered.qualifications,
  };
  const read = readPayload(view, p12.request.capture, template);
  const alignment = alignEntries({
    ...read,
    view,
    capture: p12.request.capture,
  });
  const groups = [{ ownerId: "rt:graph-g", kind: "graph-evidence" }];
  const count = (mutateCodex) => {
    const codex = structuredClone(read.codex);
    mutateCodex(codex);
    return deriveSlots({
      improvementGroups: groups,
      ...read,
      codex,
      view,
      capture: p12.request.capture,
      matched: alignment.matched,
    });
  };
  const graphPositions = [5, 6, 7, 8, 9];
  const intact = count(() => {});
  assert.equal(intact.qualifiedEvidence, 1);
  // One part on another input ordinal.
  const split = count((codex) => {
    codex[graphPositions[2]].inputOrdinal = 2;
  });
  assert.equal(split.qualifiedEvidence, 0);
  assert.ok(
    split.groups[0].reasons.some((r) =>
      r.includes("do not belong to one input"),
    ),
  );
  // All five parts on the other owner's input.
  const foreign = count((codex) => {
    for (const position of graphPositions) codex[position].inputOrdinal = 2;
  });
  assert.equal(foreign.qualifiedEvidence, 0);
  assert.ok(
    foreign.groups[0].reasons.some((r) =>
      r.includes("do not belong to one input"),
    ),
  );
});

test("slot-derivation: a Revision with several atomic groups is judged per (owner, atomic group)", () => {
  const p12 = buildSyntheticP12({ template });
  const capture = structuredClone(p12.request.capture);
  const view = {
    payload: p12.request.candidate.payload,
    renderCorrespondence: capture.rendered.renderCorrespondence,
    inputReferences: capture.rendered.inputReferences,
    qualifications: capture.rendered.qualifications,
  };
  const read = readPayload(view, capture, template);
  const alignment = alignEntries({ ...read, view, capture });
  const graphItems = capture.candidateSet.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.ownerId === "rt:graph-g");
  assert.equal(graphItems.length, 5);
  // The product emits one atomic group per record: the same Revision now
  // holds a second record's five items, rendered as five more entries of the
  // same input.
  const codex = structuredClone(read.codex);
  const matched = [...alignment.matched];
  const graphPositions = graphItems.map(({ index }) =>
    alignment.matched.indexOf(index),
  );
  for (const [offset, { item }] of graphItems.entries()) {
    capture.candidateSet.items.push({
      ...item,
      itemId: `${item.itemId}.second`,
      atomicGroup: `${item.atomicGroup}.second`,
    });
    matched.push(capture.candidateSet.items.length - 1);
    codex.push(structuredClone(read.codex[graphPositions[offset]]));
  }
  const derive = (matchedRows) =>
    deriveSlots({
      improvementGroups: [{ ownerId: "rt:graph-g", kind: "graph-evidence" }],
      ...read,
      codex,
      view,
      capture,
      matched: matchedRows,
    });
  const both = derive(matched);
  assert.equal(both.qualifiedEvidence, 1);
  assert.equal(both.groups[0].atomicGroups.length, 2);
  assert.ok(both.groups[0].atomicGroups.every((entry) => entry.counted));
  // Only the second record is rendered: still the owner's evidence, and the
  // first record's missing parts are named per atomic group.
  const secondOnly = matched.map((value, position) =>
    graphPositions.includes(position) ? -1 : value,
  );
  const partial = derive(secondOnly);
  assert.equal(partial.qualifiedEvidence, 1);
  assert.equal(
    partial.groups[0].atomicGroups.filter((entry) => !entry.counted).length,
    1,
  );
  // Neither record is rendered: not counted, with the reasons of both.
  const none = derive(matched.map(() => -1));
  assert.equal(none.qualifiedEvidence, 0);
  assert.ok(none.groups[0].reasons.length >= 2);
});

test("slot-derivation: closed markers of another group are not counted for this group", () => {
  const p12 = buildSyntheticP12({ template });
  // The baseline renders only the evidence and qualification of the Graph group.
  // Its negation and attribution markers are identical to ir-x's, but they sit
  // in ir-x's positions, so the Graph group still counts 0.
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.baselineSlot, 0);
  assert.deepEqual(scored.baselineGroups[0].counted, false);
});

test("atomic-group-partial-fails: the candidate arm renders all parts of a group or none", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-11", positiveId("P-11"));
  rewriteEntries(request, (rows) => rows.filter((_, index) => index !== 1));
  const entry = result(score(w), "P-11", positiveId("P-11"));
  assert.ok(codes(entry).includes("atomic-group-partial"));
  // The P-12 baseline removes item by item, so a partial group there is not a failure.
  const p12 = buildSyntheticP12({ template });
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.ok(!scored.failures.some((f) => f.code === "atomic-group-partial"));
});

test("p12-identical-payload-not-pass", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.baseline.payload = p12.request.candidate.payload;
  p12.request.baseline.payloadDigest = p12.request.candidate.payloadDigest;
  p12.request.baseline.renderCorrespondence = structuredClone(
    p12.request.candidate.renderCorrespondence,
  );
  p12.request.baseline.inputReferences = structuredClone(
    p12.request.capture.rendered.inputReferences,
  );
  p12.request.baseline.qualifications = structuredClone(
    p12.request.capture.rendered.qualifications,
  );
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "p12-identical-payload"));
  assert.ok(scored.failures.some((f) => f.code === "p12-not-improved"));
});

test("p12: the 0-to-1 target is fixed, an unrenderable baseline cannot pass, and a missing baseline fails", () => {
  const p12 = buildSyntheticP12({ template });
  const ok = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(ok.status, "passed");

  const loosened = scoreP12Pair({
    request: p12.request,
    expectation: { ...p12.expectation, candidateTarget: 2 },
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.ok(
    loosened.failures.some((f) => f.code === "p12-expectation-changed"),
  );

  const unrenderable = structuredClone(p12.request);
  unrenderable.baseline = {
    arm: "baseline",
    outcome: "unrenderable",
    reason: "raw-only",
    persistedRows: 0,
  };
  const fail = scoreP12Pair({
    request: unrenderable,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(fail.status, "failed");
  assert.ok(fail.failures.some((f) => f.code === "p12-baseline-unrenderable"));

  const missing = structuredClone(p12.request);
  missing.baseline = null;
  assert.ok(
    scoreP12Pair({
      request: missing,
      expectation: p12.expectation,
      template,
      fixtureRoute: p12.route,
      fixture: p12.fixture,
    }).failures.some((f) => f.code === "p12-baseline-missing"),
  );
});

test("p12: a candidate that does not improve over the baseline fails", () => {
  const p12 = buildSyntheticP12({ template });
  // Both arms hold the whole group: slot 1 and 1.
  const both = buildSyntheticP12({ template });
  both.request.baseline.payload = both.request.candidate.payload;
  both.request.baseline.payloadDigest = both.request.candidate.payloadDigest;
  both.request.baseline.renderCorrespondence =
    both.request.candidate.renderCorrespondence;
  both.request.baseline.inputReferences =
    both.request.capture.rendered.inputReferences;
  both.request.baseline.qualifications =
    both.request.capture.rendered.qualifications;
  const scored = scoreP12Pair({
    request: both.request,
    expectation: both.expectation,
    template,
    fixtureRoute: both.route,
    fixture: both.fixture,
  });
  assert.ok(scored.failures.some((f) => f.code === "p12-slot-mismatch"));
  assert.equal(p12.expectation.baselineTarget, 0);
});

// ------------------------------------------------------------ completeness

test("capture-completeness-required: a missing kind makes the run invalid", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.capture.rendered.qualifications =
    request.capture.rendered.qualifications.filter(
      (row) => !(row.inputOrdinal === 2 && row.kind === "decision"),
    );
  const scored = score(w);
  const entry = result(scored, "P-01", positiveId("P-01"));
  assert.equal(entry.status, "invalid");
  assert.ok(codes(entry).includes("capture-incomplete:completeness"));
  assert.equal(scored.status, "invalid");
});

test("capture-completeness-required: no qualification refs at all is invalid", () => {
  const w = world();
  requestOf(
    w.receipt,
    "P-01",
    positiveId("P-01"),
  ).capture.rendered.qualifications = [];
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "invalid");
});

test("capture-completeness-required: a ref beside a typed N/A, a duplicate or an N/A without a reason are not complete", () => {
  for (const [mutate, expected] of [
    [
      (rows) =>
        rows.push({
          inputOrdinal: 2,
          state: "not-applicable",
          kind: "decision",
          reason: "manuscript-source",
        }),
      "both a decision ref and a typed N/A",
    ],
    [
      (rows) =>
        rows.push({
          ...rows.find(
            (row) => row.inputOrdinal === 2 && row.kind === "source",
          ),
        }),
      "duplicate source ref",
    ],
  ]) {
    const w = world();
    const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
    mutate(request.capture.rendered.qualifications);
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid", expected);
    assert.ok(
      entry.invalid.some((row) => row.message.includes(expected)),
      expected,
    );
  }
});

test("capture-completeness-required: (c-1) refs must equal (c-2) refs apart from the ordinal", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.capture.candidateSet.candidateRefs[0].qualifications.pop();
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "invalid");
  assert.ok(codes(entry).includes("capture-ref-mismatch"));

  const w2 = world();
  const request2 = requestOf(w2.receipt, "P-01", positiveId("P-01"));
  request2.capture.candidateSet.candidateRefs = [];
  const entry2 = result(score(w2), "P-01", positiveId("P-01"));
  assert.equal(entry2.status, "invalid");
  assert.ok(codes(entry2).includes("capture-ref-mismatch"));
});

test("capture-completeness-required: the rendered inputs must start with the user and hold one Raw", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.capture.candidateSet.items =
    request.capture.candidateSet.items.filter((item) => item.kind !== "raw");
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.ok(codes(entry).includes("capture-incomplete:raw-item"));
});

// ------------------------------------------------------------ stale receipt

test("stale-receipt-rejected", () => {
  const mutations = {
    head: (w) => {
      w.expectedInputs.head = "d".repeat(40);
    },
    tree: (w) => {
      w.expectedInputs.tree = "d".repeat(40);
    },
    fixtureSha256: (w) => {
      w.expectedInputs.fixtureSha256 = "d".repeat(64);
    },
    freezeSha256: (w) => {
      w.expectedInputs.freezeSha256 = "d".repeat(64);
    },
    scorerSha256: (w) => {
      w.expectedInputs.scorerSha256 = "d".repeat(64);
    },
    featureSet: (w) => {
      w.expectedInputs.featureSet = [
        "nir1-final-request-eval",
        "native-current-human-capture",
      ];
    },
    freezeCommit: (w) => {
      w.expectedInputs.freezeCommit = "d".repeat(40);
    },
    templateSha: (w) => {
      w.receipt.inputs.fixedTemplate.sha256 = "d".repeat(64);
    },
    estimator: (w) => {
      w.receipt.inputs.estimatorVersion = "other";
    },
    fixtureVersion: (w) => {
      w.receipt.inputs.fixtureVersion = 2;
    },
    setupRun: (w) => {
      w.setupReceipt.run.commit = "d".repeat(40);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const w = world();
    mutate(w);
    const scored = score(w);
    assert.equal(scored.status, "rejected", name);
    assert.ok(
      scored.failures.every((f) => f.code === "stale-receipt-rejected"),
      name,
    );
    assert.deepEqual(scored.requests, [], name);
  }
});

test("stale-receipt-rejected: an omitted or malformed expectedInputs field never skips the comparison", () => {
  const fields = [
    "head",
    "tree",
    "fixtureSha256",
    "freezeSha256",
    "scorerSha256",
    "featureSet",
    "freezeCommit",
  ];
  for (const field of fields) {
    const w = world();
    delete w.expectedInputs[field];
    const scored = score(w);
    assert.equal(scored.status, "rejected", `missing ${field}`);
    assert.deepEqual(scored.requests, [], field);
    assert.ok(
      scored.failures.some((f) =>
        f.message.includes(`expectedInputs.${field}`),
      ),
      field,
    );
    const malformed = world();
    malformed.expectedInputs[field] = field === "featureSet" ? "x" : 7;
    assert.equal(score(malformed).status, "rejected", `malformed ${field}`);
  }
  for (const value of [{}, null, undefined, []]) {
    const w = world();
    w.expectedInputs = value;
    assert.equal(score(w).status, "rejected");
  }
  // The old fail-open scenario: swapped run identity plus an empty
  // expectedInputs must be rejected, not passed.
  const w = world();
  w.receipt.run.commit = "d".repeat(40);
  w.receipt.inputs.fixtureSha256 = "d".repeat(64);
  w.expectedInputs = {};
  assert.equal(score(w).status, "rejected");
});

test("a receipt or setup receipt that does not fit its schema is rejected", () => {
  const w = world();
  delete w.receipt.requests[0].capture;
  assert.equal(score(w).status, "rejected");
  const w2 = world();
  w2.setupReceipt.cases[0].extra = true;
  assert.equal(score(w2).status, "rejected");
});

test("scorerDigest is order-independent and changes with any file", () => {
  const files = [
    { path: "b.mjs", sha256: "1".repeat(64) },
    { path: "a.mjs", sha256: "2".repeat(64) },
  ];
  assert.equal(scorerDigest(files), scorerDigest([...files].reverse()));
  assert.notEqual(
    scorerDigest(files),
    scorerDigest([files[0], { ...files[1], sha256: "3".repeat(64) }]),
  );
});

// ------------------------------------------------------------- coverage

test("a missing, duplicated or unexpected request is a failure", () => {
  const w = world();
  w.receipt.requests = w.receipt.requests.filter(
    (row) => !(row.caseId === "P-01" && row.variantId === positiveId("P-01")),
  );
  const missing = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(missing.status, "failed");
  assert.deepEqual(codes(missing), ["request-missing"]);

  const w2 = world();
  const extra = structuredClone(
    requestOf(w2.receipt, "P-01", positiveId("P-01")),
  );
  extra.requestId = "req-extra";
  extra.caseId = "P-03";
  w2.receipt.requests.push(extra);
  const scored = score(w2);
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "request-unexpected"));

  const w3 = world();
  requestOf(w3.receipt, "P-01", rejectId("P-01")).requestKind = "positive";
  assert.ok(
    codes(result(score(w3), "P-01", rejectId("P-01"))).includes(
      "request-kind-mismatch",
    ),
  );
});

// ------------------------------------------------------------------ setup

test("setup_invalid_runs_are_not_scored: an unusable setup makes the request invalid, not failed", () => {
  const cases = [
    [
      "run-marked-invalid",
      (s) => {
        s.valid = false;
        s.invalidReason = "scope authority changed";
      },
    ],
    [
      "direct-dml",
      (s) => {
        s.directDmlObserved = true;
      },
    ],
    [
      "non-product-writer",
      (s) => {
        s.events[0].writer = "sqlite3";
      },
    ],
    [
      "write-after-first-prepare",
      (s) => {
        const prepare = s.events.findIndex((e) => e.kind === "prepare");
        s.events.splice(prepare + 1, 0, {
          seq: 0,
          stage: 1,
          kind: "tree",
          writer: "tree_node_patch",
        });
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "restricted-missing",
      (s) => {
        s.events = s.events.filter((e) => e.kind !== "restricted");
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "restricted-after-capture",
      (s) => {
        const restricted = s.events.findIndex((e) => e.kind === "restricted");
        const capture = s.events.findIndex((e) => e.kind === "capture");
        [s.events[restricted], s.events[capture]] = [
          s.events[capture],
          s.events[restricted],
        ];
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "chat-session",
      (s) => {
        s.chatSession.statementMatchesRenderer = false;
      },
    ],
    [
      "history-slot",
      (s) => {
        s.history.inputCount = 2;
      },
    ],
    [
      "scope-authority-changed",
      (s) => {
        s.verifications[1].scopeAuthorityRevision = "scope-rev-changed";
      },
    ],
    [
      "revision-not-eligible",
      (s) => {
        s.verifications[1].revisions[0].a3 = "ineligible";
      },
    ],
    [
      "revision-not-eligible",
      (s) => {
        s.verifications[1].revisions[0].freshness = "stale";
      },
    ],
    [
      "d2a-not-restricted",
      (s) => {
        s.verifications[1].d2a.restricted = false;
      },
    ],
    [
      "revision-unverified",
      (s) => {
        s.verifications[1].revisions.pop();
      },
    ],
    [
      "verification-missing",
      (s) => {
        s.verifications.pop();
      },
    ],
    [
      "no-prepare",
      (s) => {
        s.events = s.events.filter((e) => e.kind !== "prepare");
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "event-order",
      (s) => {
        s.events[1].seq = 1;
      },
    ],
    [
      "approve-missing",
      (s) => {
        s.events = s.events.filter((e) => e.kind !== "approve");
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "approve-before-prepare",
      (s) => {
        const approves = s.events.filter((e) => e.kind === "approve");
        const prepares = s.events.filter((e) => e.kind === "prepare");
        const seqs = [...approves, ...prepares].map((e) => e.seq).sort();
        // Approvals take the earlier seq numbers than the prepares.
        approves.forEach((e, i) => {
          e.seq = seqs[i];
        });
        prepares.forEach((e, i) => {
          e.seq = seqs[approves.length + i];
        });
        s.events.sort((a, b) => a.seq - b.seq);
      },
    ],
    [
      "chat-session-missing",
      (s) => {
        s.events = s.events.filter((e) => e.kind !== "chat-session");
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "chat-session-after-restricted",
      (s) => {
        const chat = s.events.findIndex((e) => e.kind === "chat-session");
        const restricted = s.events.findIndex((e) => e.kind === "restricted");
        [s.events[chat], s.events[restricted]] = [
          s.events[restricted],
          s.events[chat],
        ];
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
    [
      "restricted-before-writes",
      (s) => {
        // A setup write (route settings) lands after restricted was set.
        const [route] = s.events.splice(
          s.events.findIndex((e) => e.kind === "route-settings"),
          1,
        );
        const restricted = s.events.findIndex((e) => e.kind === "restricted");
        s.events.splice(restricted + 1, 0, route);
        s.events.forEach((e, i) => {
          e.seq = i + 1;
        });
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const w = world();
    mutate(setupOf(w.setupReceipt, "P-01", positiveId("P-01")));
    const scored = score(w);
    const entry = result(scored, "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid", code);
    assert.ok(
      codes(entry).includes(`setup-invalid:${code}`),
      `${code}: ${JSON.stringify(codes(entry))}`,
    );
    assert.equal(scored.status, "invalid", code);
  }
});

test("setup_invalid_runs_are_not_scored: a missing setup case or id map is invalid", () => {
  const w = world();
  w.setupReceipt.cases = w.setupReceipt.cases.filter(
    (row) => !(row.caseId === "P-01" && row.variantId === positiveId("P-01")),
  );
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "invalid");
  assert.ok(codes(entry).includes("setup-invalid:setup-receipt-missing"));

  const w2 = world();
  setupOf(w2.setupReceipt, "P-01", positiveId("P-01")).idMap.shift();
  assert.equal(result(score(w2), "P-01", positiveId("P-01")).status, "invalid");
});

test("p10_request2_uses_newly_prepared_revision_not_reapproved_old", () => {
  const w = world();
  const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
  const stage2 = setup.events.filter(
    (e) => e.stage === 2 && e.kind === "prepare",
  );
  assert.ok(stage2.length > 0);
  const stage1Ids = new Set(
    setup.events
      .filter((e) => e.stage === 1 && e.kind === "prepare")
      .map((e) => e.runtimeId),
  );
  for (const event of stage2) assert.ok(!stage1Ids.has(event.runtimeId));
  assert.equal(score(w).status, "passed");
  const request2 = requestOf(w.receipt, "P-10", positiveId("P-10"), 2);
  assert.ok(!request2.candidate.payload.includes("rev-P-10-a"));
});

test("p10_without_new_revision_is_setup_failure", () => {
  const w = world();
  const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
  setup.events = setup.events.filter(
    (e) => !(e.stage === 2 && (e.kind === "prepare" || e.kind === "approve")),
  );
  setup.events.forEach((e, i) => {
    e.seq = i + 1;
  });
  const scored = score(w);
  const entry = result(scored, "P-10", positiveId("P-10"), 2);
  assert.equal(entry.status, "invalid");
  assert.ok(
    codes(entry).includes("setup-invalid:no-prepare") ||
      codes(entry).includes("setup-invalid:p10-without-new-revision"),
  );
});

test("p10_reapproval_of_old_revision_is_rejected", () => {
  const w = world();
  const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
  // Request 2 "approves again" the old Revision instead of a newly prepared one.
  for (const event of setup.events.filter(
    (e) => e.stage === 2 && e.kind === "approve",
  )) {
    event.runtimeId = "rt:rev-P-10-a";
    event.logicalId = "rev-P-10-a";
  }
  const entry = result(score(w), "P-10", positiveId("P-10"), 2);
  assert.equal(entry.status, "invalid");
  assert.ok(
    codes(entry).includes("setup-invalid:p10-reapproval-of-old-revision"),
  );
  assert.ok(
    codes(entry).includes("setup-invalid:p10-new-revision-not-approved"),
  );

  const w2 = world();
  const setup2 = setupOf(w2.setupReceipt, "P-10", positiveId("P-10"));
  for (const event of setup2.events.filter(
    (e) => e.stage === 2 && e.kind === "prepare",
  )) {
    event.runtimeId = "rt:rev-P-10-a";
  }
  const entry2 = result(score(w2), "P-10", positiveId("P-10"), 2);
  assert.ok(
    codes(entry2).includes("setup-invalid:p10-reprepared-old-revision"),
  );
});

test("p10: stage 2 needs a binding-changing write, a new chat session and prepare/approve events", () => {
  const stage2 = (w) =>
    setupOf(w.setupReceipt, "P-10", positiveId("P-10")).events;
  const renumber = (setup) => {
    setup.events.forEach((e, i) => {
      e.seq = i + 1;
    });
  };
  const run = (mutate, code) => {
    const w = world();
    const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
    mutate(setup);
    renumber(setup);
    const entry = result(score(w), "P-10", positiveId("P-10"), 2);
    assert.equal(entry.status, "invalid", code);
    assert.ok(
      codes(entry).includes(`setup-invalid:${code}`),
      `${code}: ${JSON.stringify(codes(entry))}`,
    );
  };
  // Every stage-2 event removed: the second request audits nothing.
  run((setup) => {
    setup.events = setup.events.filter(
      (e) => !(e.stage === 2 && e.kind !== "chat-session"),
    );
  }, "no-prepare");
  // No binding change before the new Revision was prepared.
  run((setup) => {
    setup.events = setup.events.filter(
      (e) => !(e.stage === 2 && ["scope", "tree", "codex"].includes(e.kind)),
    );
  }, "p10-without-binding-change");
  // No new chat session for request 2.
  run((setup) => {
    setup.events = setup.events.filter(
      (e) => !(e.stage === 2 && e.kind === "chat-session"),
    );
  }, "chat-session-missing");
  // Prepared but never approved.
  run((setup) => {
    setup.events = setup.events.filter(
      (e) => !(e.stage === 2 && e.kind === "approve"),
    );
  }, "p10-new-revision-not-approved");
  assert.ok(stage2(world()).some((e) => e.stage === 2 && e.kind === "scope"));

  // A binding-change event of any of the five binding kinds counts as the
  // change; the old tree/scope writes are not the only vocabulary.
  for (const binding of [
    "scope",
    "source",
    "revision",
    "decision",
    "freshness",
  ]) {
    const w = world();
    const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
    const index = setup.events.findIndex(
      (e) => e.stage === 2 && e.kind === "scope",
    );
    setup.events[index] = {
      seq: 0,
      stage: 2,
      kind: "binding-change",
      writer: "narrative_extraction_append_human_decision",
      binding,
    };
    setup.events = setup.events.filter(
      (e) => !(e.stage === 2 && e.kind === "tree"),
    );
    renumber(setup);
    const scored = score(w);
    assert.equal(scored.status, "passed", binding);
  }
  const w = world();
  const setup = setupOf(w.setupReceipt, "P-10", positiveId("P-10"));
  setup.events.find((e) => e.stage === 2 && e.kind === "scope").binding =
    "index-generation";
  assert.equal(score(w).status, "rejected");
});

test("same-input-check-rejects-passedRevisionIds: a reject variant's passed ids must be the fixture's list", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", rejectId("P-01"));
  request.passedRevisionIds = request.passedRevisionIds.slice(1);
  const entry = result(score(w), "P-01", rejectId("P-01"));
  assert.equal(entry.status, "failed");
  assert.ok(
    codes(entry).includes("same-input-check-rejects-passedRevisionIds"),
  );
});

test("retention-forbidden-prose-quote-window: a captured Raw item cannot stand in for the frozen Raw", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-02", positiveId("P-02"));
  repayload(request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "雨が止んだ。",
      "雨が降った。",
    );
  });
  // The capture's Raw item now agrees with the (wrong) payload; only the frozen Raw differs.
  const raw = request.capture.candidateSet.items.find(
    (item) => item.kind === "raw",
  );
  raw.text = raw.text.replace("雨が止んだ。", "雨が降った。");
  const entry = result(score(w), "P-02", positiveId("P-02"));
  assert.equal(entry.status, "failed");
  assert.ok(
    entry.failures.some(
      (f) => f.code === "raw-mismatch" && f.message.includes("frozen Raw"),
    ),
  );
});

test("p12: the baseline arm's input and qualification refs must be the captured ones", () => {
  const run = (mutate) => {
    const p12 = buildSyntheticP12({ template });
    mutate(p12.request.baseline);
    return scoreP12Pair({
      request: p12.request,
      expectation: p12.expectation,
      template,
      fixtureRoute: p12.route,
      fixture: p12.fixture,
    });
  };
  const ok = run(() => {});
  assert.equal(ok.status, "passed");
  const forgedQualification = run((baseline) => {
    const row = baseline.qualifications.find(
      (r) => r.inputOrdinal === 2 && r.kind === "revision",
    );
    row.identity = "forged";
    row.version = "forged";
  });
  assert.equal(forgedQualification.status, "invalid");
  assert.ok(
    forgedQualification.invalid.some(
      (f) =>
        f.code === "capture-ref-mismatch" && f.message.startsWith("baseline:"),
    ),
  );
  const forgedInput = run((baseline) => {
    const graph = baseline.inputReferences.find(
      (input) => input.target.kind === "graph-evidence",
    );
    graph.target.revisionToken = "forged";
  });
  assert.equal(forgedInput.status, "invalid");
  assert.ok(
    forgedInput.invalid.some((f) =>
      f.message.includes("differs from the captured reference"),
    ),
  );
  const forgedUser = run((baseline) => {
    baseline.inputReferences[0].target.versionId = "msg:forged";
  });
  assert.equal(forgedUser.status, "invalid");
});

test("setup: each run has its own workspace, named by the fixture's isolation", () => {
  const w = world();
  const a = setupOf(w.setupReceipt, "P-01", positiveId("P-01"));
  const b = setupOf(w.setupReceipt, "P-02", positiveId("P-02"));
  b.workspaceNamespace = a.workspaceNamespace;
  const scored = score(w);
  for (const [caseId] of [["P-01"], ["P-02"]]) {
    const entry = result(scored, caseId, positiveId(caseId));
    assert.equal(entry.status, "invalid");
    assert.ok(
      codes(entry).includes("setup-invalid:workspace-namespace-shared"),
    );
  }
  const w2 = world();
  for (const row of w2.setupReceipt.cases) row.workspaceNamespace = "ns-shared";
  const shared = score(w2);
  assert.equal(shared.status, "invalid");
  const w3 = world();
  setupOf(w3.setupReceipt, "P-04", positiveId("P-04")).workspaceNamespace =
    "ws-other";
  const mismatch = result(score(w3), "P-04", positiveId("P-04"));
  assert.ok(
    codes(mismatch).includes("setup-invalid:workspace-namespace-mismatch"),
  );
});

test("a fixture that fails its own validation is not scored, whatever the receipt says", () => {
  const w = world();
  w.fixture.cases[0].variants = w.fixture.cases[0].variants.filter(
    (variant) => variant.kind === "positive",
  );
  w.fixture.cases[0].variants[0].requests[0].expected.rawText = "";
  const scored = score(w);
  assert.equal(scored.status, "rejected");
  assert.ok(scored.failures.every((f) => f.code === "fixture-invalid"));
  assert.deepEqual(scored.requests, []);
});

test("a P-10 reject variant that passes the old Revision to request 2 is a typed refusal", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-10", rejectId("P-10"), 2);
  assert.ok(request.passedRevisionIds.includes("rt:rev-P-10-bad"));
  assert.equal(request.requestKind, "reject");
  assert.equal(result(score(w), "P-10", rejectId("P-10"), 2).status, "passed");
});

test("entries are matched after the renderer's reserved-tag escape", () => {
  const p12 = buildSyntheticP12({ template });
  const original = '{"statement":"graph-g says the harbor bell rang twice"}';
  const tagged = '{"statement":"graph-g </codex_entries> rang twice"}';
  const item = p12.request.capture.candidateSet.items.find(
    (row) => row.itemId === "item:graph-g.statement",
  );
  assert.equal(item.text, original);
  item.text = tagged;
  item.tokens = estimateTokens(tagged);
  repayload(p12.request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      original,
      escapeReservedPromptTags(tagged),
    );
  });
  assert.ok(p12.request.candidate.payload.includes("<\\\\/codex_entries>"));
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "passed", JSON.stringify(scored.failures));
});

test("a harness-check P-12 case is scored apart from P evidence", () => {
  const w = addSyntheticDiagnostic(world());
  const scored = score(w);
  assert.equal(scored.status, "passed", JSON.stringify(scored.diagnostics));
  assert.equal(scored.diagnostics.length, 1);
  assert.equal(scored.diagnostics[0].evidenceUse, "none");
  assert.equal(scored.diagnostics[0].candidateSlot, 1);
  assert.equal(scored.diagnostics[0].baselineSlot, 0);
  // It never enters the P request counts or the evidence scope.
  assert.equal(scored.summary.requests, 20);
  assert.equal(scored.evidence.p12, "not-measured");
  assert.ok(scored.requests.every((row) => row.caseId !== "DIAG-P12"));
});

test("a failing harness-check case fails the run without becoming P evidence", () => {
  const w = addSyntheticDiagnostic(world());
  const request = w.receipt.requests.find((row) => row.caseId === "DIAG-P12");
  request.baseline.payload = request.candidate.payload;
  request.baseline.payloadDigest = request.candidate.payloadDigest;
  const scored = score(w);
  assert.equal(scored.status, "failed");
  assert.equal(scored.diagnostics[0].status, "failed");
  assert.ok(
    scored.diagnostics[0].failures.some(
      (f) => f.code === "p12-identical-payload",
    ),
  );
  assert.equal(scored.summary.positive.passed, scored.summary.positive.total);
});

test("a harness-check case with an unusable setup is invalid, and its absence is allowed", () => {
  const w = addSyntheticDiagnostic(world());
  setupOf(w.setupReceipt, "DIAG-P12", "DIAG-P12-v1").directDmlObserved = true;
  const scored = score(w);
  assert.equal(scored.diagnostics[0].status, "invalid");
  assert.equal(scored.status, "invalid");
  const withoutRequest = addSyntheticDiagnostic(world());
  withoutRequest.receipt.requests = withoutRequest.receipt.requests.filter(
    (row) => row.caseId !== "DIAG-P12",
  );
  assert.equal(score(withoutRequest).status, "passed");
});

test("a request for a case that is neither a fixture case nor the diagnostic is unexpected", () => {
  const w = world();
  const extra = structuredClone(
    requestOf(w.receipt, "P-01", positiveId("P-01")),
  );
  extra.requestId = "req-p12";
  extra.caseId = "P-12";
  w.receipt.requests.push(extra);
  const scored = score(w);
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "request-unexpected"));
});

test("baseline_payload_not_persisted: a baseline arm that added persisted rows fails", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.baseline.persistedRows = 1;
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "baseline-persisted"));
});

test("the candidate arm's render correspondence must be the captured one", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.candidate.renderCorrespondence =
    request.candidate.renderCorrespondence.slice(0, -1);
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "failed");
  assert.deepEqual(codes(entry), ["render-correspondence-mismatch"]);
});

test("candidate material of an owner that was not passed, or of a kind DP-H does not use, fails", () => {
  const w = world();
  const request = requestOf(w.receipt, "P-01", positiveId("P-01"));
  request.capture.candidateSet.items.find(
    (item) => item.kind === "accepted-ir",
  ).ownerId = "rt:not-passed";
  assert.ok(
    codes(result(score(w), "P-01", positiveId("P-01"))).includes(
      "candidate-owner-not-passed",
    ),
  );

  const w2 = world();
  const request2 = requestOf(w2.receipt, "P-01", positiveId("P-01"));
  request2.capture.candidateSet.items.find(
    (item) => item.kind === "accepted-ir",
  ).kind = "graph-evidence";
  assert.ok(
    codes(result(score(w2), "P-01", positiveId("P-01"))).includes(
      "candidate-kind-not-allowed",
    ),
  );
});

test("a P-12 request with a history input fails", () => {
  const p12 = buildSyntheticP12({ template });
  p12.request.history = { inputCount: 1, reason: "k4-rule" };
  const scored = scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.ok(scored.failures.some((f) => f.code === "history-input-present"));
});

// -------------------------------------------- setup verification binding

function setupFor(w, caseId, variantId) {
  return setupOf(w.setupReceipt, caseId, variantId);
}

function invalidCodes(scored, caseId, variantId, stage = 1) {
  const entry = result(scored, caseId, variantId, stage);
  return { entry, codes: codes(entry) };
}

test("setup-verification: a setup using tree_node_create (Scene creation) is a valid setup", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  const tree = setup.events.find((e) => e.kind === "tree");
  tree.writer = "tree_node_create";
  setup.writersUsed = [...new Set(setup.events.map((e) => e.writer))];
  const scored = score(w);
  assert.equal(scored.status, "passed", JSON.stringify(scored.failures));
  for (const writer of [
    "chronicle_bulk_mutate",
    "project_patch",
    "narrative_scene_scope_registry_update",
    "save_scene_body_bundle",
  ]) {
    const w2 = world();
    const s2 = setupFor(w2, "P-01", positiveId("P-01"));
    s2.events.find((e) => e.kind === "tree").writer = writer;
    s2.writersUsed = [...new Set(s2.events.map((e) => e.writer))];
    assert.equal(score(w2).status, "passed", writer);
  }
});

test("setup-verification: a non-product writer is still setup-invalid", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  setup.events.find((e) => e.kind === "tree").writer = "direct_sql_insert";
  setup.writersUsed = [...new Set(setup.events.map((e) => e.writer))];
  const { entry, codes: found } = invalidCodes(
    score(w),
    "P-01",
    positiveId("P-01"),
  );
  assert.equal(entry.status, "invalid");
  assert.ok(found.includes("setup-invalid:non-product-writer"));
});

test("setup-verification: an empty setup-end list does not verify the Revisions", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  for (const row of setup.verifications) {
    if (row.point === "setup-end") row.revisions = [];
  }
  const scored = score(w);
  const { entry, codes: found } = invalidCodes(
    scored,
    "P-01",
    positiveId("P-01"),
  );
  assert.equal(entry.status, "invalid");
  assert.ok(found.includes("setup-invalid:revision-unverified"));
  assert.equal(scored.status, "invalid");
});

test("setup-verification: every setup-end list of the synthetic world is checked, not only the first", () => {
  const w = world();
  for (const setup of w.setupReceipt.cases) {
    for (const row of setup.verifications) {
      if (row.point === "setup-end") row.revisions = [];
    }
  }
  const scored = score(w);
  assert.equal(scored.summary.positive.passed, 0);
  assert.equal(scored.status, "invalid");
});

test("setup-verification: a verification of another runtime id than the prepared one is invalid", () => {
  const w = world();
  for (const setup of w.setupReceipt.cases) {
    for (const row of setup.verifications) {
      if (row.point !== "request-pre") continue;
      for (const revision of row.revisions) revision.runtimeId = "rt:bogus";
    }
  }
  const scored = score(w);
  const { entry, codes: found } = invalidCodes(
    scored,
    "P-01",
    positiveId("P-01"),
  );
  assert.equal(entry.status, "invalid");
  assert.ok(found.includes("setup-invalid:verification-runtime-id-mismatch"));
  assert.equal(scored.summary.positive.passed, 0);
});

test("setup-verification: a duplicate verification row cannot hide an ineligible Revision", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  const pre = setup.verifications.find((row) => row.point === "request-pre");
  setup.verifications.push({
    ...structuredClone(pre),
    scopeAuthorityRevision: "scope-rev-other",
    revisions: pre.revisions.map((revision) => ({
      ...revision,
      a3: "ineligible",
    })),
  });
  const { entry, codes: found } = invalidCodes(
    score(w),
    "P-01",
    positiveId("P-01"),
  );
  assert.equal(entry.status, "invalid");
  assert.ok(found.includes("setup-invalid:verification-duplicate"));
});

test("setup-verification: a Revision verified twice in one row is invalid", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  const pre = setup.verifications.find((row) => row.point === "request-pre");
  pre.revisions.push({
    ...pre.revisions[0],
    runtimeId: "rt:other",
    a3: "ineligible",
  });
  const { codes: found } = invalidCodes(score(w), "P-01", positiveId("P-01"));
  assert.ok(found.includes("setup-invalid:verification-duplicate-revision"));
  const w2 = world();
  const s2 = setupFor(w2, "P-01", positiveId("P-01"));
  const pre2 = s2.verifications.find((row) => row.point === "request-pre");
  pre2.revisions.push({ ...pre2.revisions[0] });
  const { codes: found2 } = invalidCodes(score(w2), "P-01", positiveId("P-01"));
  assert.ok(found2.includes("setup-invalid:verification-duplicate-revision"));
});

test("setup-verification: the id map names a logical id once", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  setup.idMap.push({
    logicalId: setup.idMap[0].logicalId,
    runtimeId: "rt:dup",
  });
  const { codes: found } = invalidCodes(score(w), "P-01", positiveId("P-01"));
  assert.ok(found.includes("setup-invalid:idmap-duplicate"));
});

test("setup-verification: a stale setup-end entry (not eligible) is invalid at that point", () => {
  const w = world();
  const setup = setupFor(w, "P-01", positiveId("P-01"));
  const end = setup.verifications.find((row) => row.point === "setup-end");
  end.revisions[0].a2 = "ineligible";
  const { codes: found } = invalidCodes(score(w), "P-01", positiveId("P-01"));
  assert.ok(found.includes("setup-invalid:revision-not-eligible"));
});

test("reject setup: the negative must be prepared, approved and invalidated, in this order, once each", () => {
  const cases = [
    [
      "negative-event-missing",
      (s) => {
        s.events = s.events.filter(
          (e) =>
            e.kind !== "approve-negative" && e.kind !== "invalidate-negative",
        );
      },
    ],
    [
      "negative-event-missing",
      (s) => {
        s.events = s.events.filter((e) => e.kind !== "prepare-negative");
      },
    ],
    [
      "negative-event-duplicate",
      (s) => {
        const approve = s.events.find((e) => e.kind === "approve-negative");
        s.events.splice(s.events.indexOf(approve) + 1, 0, { ...approve });
      },
    ],
    [
      "negative-runtime-id-mismatch",
      (s) => {
        s.events.find((e) => e.kind === "invalidate-negative").runtimeId =
          "rt:wrong";
      },
    ],
    [
      "negative-order",
      (s) => {
        const approve = s.events.find((e) => e.kind === "approve-negative");
        const invalidate = s.events.find(
          (e) => e.kind === "invalidate-negative",
        );
        [approve.kind, invalidate.kind] = [invalidate.kind, approve.kind];
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const w = world();
    const setup = setupFor(w, "P-02", rejectId("P-02"));
    mutate(setup);
    setup.events.forEach((e, i) => {
      e.seq = i + 1;
    });
    const scored = score(w);
    const { entry, codes: found } = invalidCodes(
      scored,
      "P-02",
      rejectId("P-02"),
    );
    assert.equal(entry.status, "invalid", code);
    assert.ok(
      found.includes(`setup-invalid:${code}`),
      `${code}: ${JSON.stringify(found)}`,
    );
  }
});

test("reject setup: the negative is recorded as not eligible at request-pre", () => {
  const w = world();
  const setup = setupFor(w, "P-02", rejectId("P-02"));
  const pre = setup.verifications.find((row) => row.point === "request-pre");
  const negative = pre.revisions.find((r) => r.logicalId === "rev-P-02-bad");
  assert.ok(negative, "the synthetic world records the negative");
  // Not verified at all.
  pre.revisions = pre.revisions.filter((r) => r !== negative);
  let found = invalidCodes(score(w), "P-02", rejectId("P-02")).codes;
  assert.ok(found.includes("setup-invalid:negative-unverified"));
  // Verified as still eligible.
  const w2 = world();
  const pre2 = setupFor(w2, "P-02", rejectId("P-02")).verifications.find(
    (row) => row.point === "request-pre",
  );
  Object.assign(
    pre2.revisions.find((r) => r.logicalId === "rev-P-02-bad"),
    {
      a2: "eligible",
      a3: "eligible",
      freshness: "fresh",
    },
  );
  found = invalidCodes(score(w2), "P-02", rejectId("P-02")).codes;
  assert.ok(found.includes("setup-invalid:negative-eligible"));
  // Verified under another runtime id.
  const w3 = world();
  const pre3 = setupFor(w3, "P-02", rejectId("P-02")).verifications.find(
    (row) => row.point === "request-pre",
  );
  pre3.revisions.find((r) => r.logicalId === "rev-P-02-bad").runtimeId = "rt:x";
  found = invalidCodes(score(w3), "P-02", rejectId("P-02")).codes;
  assert.ok(found.includes("setup-invalid:verification-runtime-id-mismatch"));
});

test("reject setup: a negative that is an old Revision of an earlier stage needs no negative events but must be recorded ineligible", () => {
  const w = world();
  // Turn the P-10 reject variant into one whose negative is the old stage-1 Revision.
  const variant = w.fixture.cases
    .find((c) => c.caseId === "P-10")
    .variants.find((v) => v.variantId === rejectId("P-10"));
  const old = "rev-P-10-a";
  const bad = variant.ineligibleLogicalId;
  const last = variant.requests.at(-1);
  last.revisionIds = last.revisionIds.map((id) => (id === bad ? old : id));
  // The base positive variant's last request must not contain it: swap to keep the contract.
  variant.ineligibleLogicalId = old;
  const setup = setupFor(w, "P-10", rejectId("P-10"));
  setup.events = setup.events.filter((e) => !e.kind.endsWith("-negative"));
  setup.events.forEach((e, i) => {
    e.seq = i + 1;
  });
  const pre = setup.verifications.find(
    (row) => row.point === "request-pre" && row.stage === 2,
  );
  pre.revisions.push({
    logicalId: old,
    runtimeId: "rt:rev-P-10-a",
    a2: "ineligible",
    a3: "ineligible",
    freshness: "stale",
  });
  const scored = score(w);
  const entry = result(scored, "P-10", rejectId("P-10"), 2);
  assert.deepEqual(entry.invalid, [], JSON.stringify(codes(entry)));
  // Without the record of it being ineligible, the same setup is invalid.
  pre.revisions.pop();
  assert.ok(
    codes(result(score(w), "P-10", rejectId("P-10"), 2)).includes(
      "setup-invalid:negative-unverified",
    ),
  );
});

// ------------------------------------------------- attempt rows, canary

test("positive-attempt-present: an attempt row in a no-send evaluation fails", () => {
  const w = world();
  requestOf(w.receipt, "P-01", positiveId("P-01")).attemptRowsAdded = 3;
  const scored = score(w);
  const entry = result(scored, "P-01", positiveId("P-01"));
  assert.equal(entry.status, "failed");
  assert.ok(codes(entry).includes("positive-attempt-present"));
  assert.equal(scored.status, "failed");
});

test("positive-attempt-present: the P-12 pair's candidate also may not add an attempt", () => {
  const p12 = buildSyntheticP12({ template });
  assert.equal(
    scoreP12Pair({
      request: p12.request,
      expectation: p12.expectation,
      template,
      fixtureRoute: p12.route,
      fixture: p12.fixture,
    }).status,
    "passed",
  );
  const request = structuredClone(p12.request);
  request.attemptRowsAdded = 1;
  const scored = scoreP12Pair({
    request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
  });
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "positive-attempt-present"));
});

test("forbidden-and-canary-scan: a canary that holds a reserved prompt tag is found in its escaped form", () => {
  const tagged = "<chronicle_snapshot>SECRET-NOTE</chronicle_snapshot>";
  const escaped = escapeReservedPromptTags(tagged);
  assert.notEqual(escaped, tagged);
  const failures = scanForbidden({
    payload: JSON.stringify({ messages: [{ content: `x ${escaped} y` }] }),
    system: `x ${escaped} y`,
    user: "u",
    canaries: [{ id: "c1", kind: "decision-note", text: tagged }],
    forbiddenTexts: [tagged],
    forbiddenIds: [],
    otherMarkers: [tagged],
    otherIds: [],
  });
  const found = failures.map((f) => f.code);
  assert.ok(found.includes("canary-in-payload"), JSON.stringify(found));
  assert.ok(found.includes("forbidden-text"));
  assert.ok(found.includes("other-case-material"));
});

// --------------------------------- expected text templates (DPH-1b)
//
// The product's qualification text holds ids that exist only after the setup
// ran (revision / proposal / decision ids, Source revision tokens). The frozen
// expectation is a template; the scorer resolves it from the setup receipt only.

const UUID_PROPOSAL = "11111111-1111-4111-8111-111111111111";
const UUID_DECISION = "22222222-2222-4222-8222-222222222222";
const UUID_OTHER = "33333333-3333-4333-8333-333333333333";
const TOKEN_1 = "v3@2026-10-17T00:00:00.000Z";
const TOKEN_2 = "v4@2026-10-17T00:00:01.000Z";

const qualificationTemplate = (revision, scene) =>
  `{"approval":"human-approved","decisionId":"{{decisionId:${revision}}}","proposalId":"{{proposalId:${revision}}}","revisionId":"{{revisionId:${revision}}}","sourceToken":"{{revisionToken:${scene}}}"}`;

const qualificationText = (revision, values) =>
  `{"approval":"human-approved","decisionId":"${values.decisionId}","proposalId":"${values.proposalId}","revisionId":"rt:${revision}","sourceToken":"${values.token}"}`;

/**
 * Turns the qualification part of `rev-<caseId>-a` into a template, gives the
 * setup receipt the matching ids / token, and puts the resolved text in the
 * payload and the capture. Returns the pieces the tests mutate.
 */
function templatize(w, caseId, { stage = 1 } = {}) {
  const revision = stage === 1 ? `rev-${caseId}-a` : `rev-${caseId}-c`;
  const scene = `scene-${caseId}`;
  const variantId = positiveId(caseId);
  const variant = w.fixture.cases
    .find((row) => row.caseId === caseId)
    .variants.find((row) => row.variantId === variantId);
  const spec = variant.requests[stage - 1];
  spec.expected.codexEntries.find(
    (entry) => entry.logicalId === `${revision}.qualification`,
  ).text = qualificationTemplate(revision, scene);
  const setup = setupOf(w.setupReceipt, caseId, variantId);
  const row = setup.idMap.find((entry) => entry.logicalId === revision);
  const approve = setup.events.find(
    (event) => event.kind === "approve" && event.runtimeId === row.runtimeId,
  );
  setup.runtimeValues = [
    ...(setup.runtimeValues ?? []),
    {
      kind: "revisionToken",
      logicalId: scene,
      stage,
      value: TOKEN_1,
      source: "product-reader-function",
      resolvedAtSeq: approve.seq,
    },
  ];
  const request = requestOf(w.receipt, caseId, variantId, stage);
  const values = {
    proposalId: stage === 1 ? UUID_PROPOSAL : UUID_OTHER,
    decisionId: stage === 1 ? UUID_DECISION : UUID_OTHER,
    token: stage === 1 ? TOKEN_1 : TOKEN_2,
  };
  row.proposalId = values.proposalId;
  row.decisionId = values.decisionId;
  setup.runtimeValues.at(-1).value = values.token;
  const apply = (nextValues) => {
    const text = qualificationText(revision, nextValues);
    rewriteEntries(request, (rows) =>
      rows.map((entry, index) => (index === 4 ? { ...entry, text } : entry)),
    );
    const item = request.capture.candidateSet.items.find(
      (candidate) => candidate.itemId === `item:${revision}.qualification`,
    );
    item.text = text;
    item.tokens = estimateTokens(text);
  };
  apply(values);
  return { setup, request, row, revision, scene, values, apply, spec };
}

test("template-resolved-from-setup-receipt: a templated qualification scores as the literal entry would", () => {
  const w = world();
  templatize(w, "P-01");
  const scored = score(w);
  const entry = result(scored, "P-01", positiveId("P-01"));
  assert.equal(entry.status, "passed", JSON.stringify(codes(entry)));
  assert.equal(scored.status, "passed", JSON.stringify(scored.failures));
});

/** P-10 with both stages templated; stage 2 forbids the old qualification template. */
function templatizeP10(w) {
  const first = templatize(w, "P-10", { stage: 1 });
  const second = templatize(w, "P-10", { stage: 2 });
  second.spec.expected.forbidden.texts.push(
    qualificationTemplate(first.revision, first.scene),
  );
  return { first, second };
}

test("template-resolved-from-setup-receipt: P-10 resolves each stage with its own setup values", () => {
  const w = world();
  templatizeP10(w);
  const scored = score(w);
  for (const stage of [1, 2]) {
    const entry = result(scored, "P-10", positiveId("P-10"), stage);
    assert.equal(
      entry.status,
      "passed",
      JSON.stringify([stage, codes(entry), scored.failures]),
    );
  }
  // (The reject variant shares the stage-1 expectation but not this setup, so
  // only the positive variant is asserted here.)
});

test("template-wrong-value-fails: a wrong id or token in the payload entry is a failure", () => {
  for (const [name, values] of [
    ["proposalId", { proposalId: UUID_OTHER }],
    ["decisionId", { decisionId: UUID_OTHER }],
    ["token", { token: TOKEN_2 }],
  ]) {
    const w = world();
    const t = templatize(w, "P-01");
    t.apply({ ...t.values, ...values });
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "failed", name);
    const found = codes(entry);
    assert.ok(found.includes("required-entry-missing"), `${name}: ${found}`);
    assert.ok(found.includes("unexpected-entry"), `${name}: ${found}`);
  }
  // A literal that still says the placeholder is not a resolved value either.
  const w = world();
  const t = templatize(w, "P-01");
  t.apply({ ...t.values, proposalId: "{{proposalId:rev-P-01-a}}" });
  assert.equal(result(score(w), "P-01", positiveId("P-01")).status, "failed");
});

test("template-wrong-value-fails: the right values in the wrong place (another Revision's ids) fail", () => {
  const w = world();
  const t = templatize(w, "P-01");
  const other = t.setup.idMap.find((entry) => entry.logicalId === "rev-P-01-b");
  other.proposalId = UUID_OTHER;
  other.decisionId = UUID_OTHER;
  // The entry carries rev-b's ids while the expectation names rev-a.
  t.apply({ ...t.values, proposalId: UUID_OTHER, decisionId: UUID_OTHER });
  assert.equal(result(score(w), "P-01", positiveId("P-01")).status, "failed");
});

test("template-observed-output-cannot-resolve: a value only the payload holds leaves the run invalid", () => {
  // The payload holds a well-formed proposal id, but the setup receipt does
  // not fix one: the scorer does not read it back from the output.
  for (const [name, mutate] of [
    [
      "proposalId missing",
      (t) => {
        delete t.row.proposalId;
      },
    ],
    [
      "decisionId missing",
      (t) => {
        delete t.row.decisionId;
      },
    ],
    [
      "token missing",
      (t) => {
        t.setup.runtimeValues = [];
      },
    ],
    [
      "token row of another stage",
      (t) => {
        t.setup.runtimeValues[0].stage = 2;
      },
    ],
    [
      "token row of another source",
      (t) => {
        t.setup.runtimeValues[0].logicalId = "scene-other";
      },
    ],
  ]) {
    const w = world();
    const t = templatize(w, "P-01");
    mutate(t);
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid", name);
    // A row of another stage is also setup-invalid (its event is not in that
    // stage); the other cases reach the scorer and name the placeholder.
    assert.ok(
      codes(entry).some(
        (code) =>
          code === "setup-invalid:placeholder-unresolved" ||
          (name.includes("another stage") &&
            code === "setup-invalid:placeholder-source-missing"),
      ),
      name,
    );
    assert.deepEqual(entry.failures, [], name);
  }
});

test("template-observed-output-cannot-resolve: a value sourced from a request's output is rejected by the schema", () => {
  for (const source of [
    "payload",
    "capture",
    "dfinal-result",
    "candidate-payload",
    "native-output",
  ]) {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.runtimeValues[0].source = source;
    const scored = score(w);
    assert.equal(scored.status, "rejected", source);
    assert.ok(
      scored.failures.some((f) =>
        f.message.includes("runtimeValues[0].source"),
      ),
      source,
    );
  }
  // The resolver takes the setup case and the stages, never a payload.
  assert.equal(resolveExpectedTemplate.length, 3);
  const w = world();
  const t = templatize(w, "P-01");
  const payload = requestOf(w.receipt, "P-01", positiveId("P-01")).candidate
    .payload;
  t.row.proposalId = undefined;
  delete t.row.proposalId;
  const resolved = resolveExpectedTemplate(
    qualificationTemplate("rev-P-01-a", "scene-P-01"),
    t.setup,
    [1],
  );
  assert.deepEqual(resolved.texts, []);
  assert.deepEqual(resolved.unresolved, ["{{proposalId:rev-P-01-a}}"]);
  assert.ok(payload.includes(UUID_PROPOSAL));
});

test("template-source-order: a value fixed after the capture, before the writes, or by no event is setup-invalid", () => {
  // After the capture: the value's event follows the capture event.
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.events.push({
      seq: 99,
      stage: 1,
      kind: "approve",
      writer: "narrative_extraction_append_human_decision",
      runtimeId: "rt:late",
    });
    t.setup.runtimeValues[0].resolvedAtSeq = 99;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(codes(entry).includes("setup-invalid:placeholder-after-capture"));
  }
  // Before the stage's last tree / Scope / Codex write.
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.runtimeValues[0].resolvedAtSeq = 1;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(codes(entry).includes("setup-invalid:placeholder-before-writes"));
  }
  // By no event at all.
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.runtimeValues[0].resolvedAtSeq = 500;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(
      codes(entry).includes("setup-invalid:placeholder-source-missing"),
    );
  }
  // The capture event itself is not a setup event.
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.runtimeValues[0].resolvedAtSeq = t.setup.events.find(
      (e) => e.kind === "capture",
    ).seq;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(
      codes(entry).includes("setup-invalid:placeholder-source-missing"),
    );
  }
  // A proposal id with no prepare event of that Revision.
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.events = t.setup.events.filter(
      (e) => !(e.kind === "prepare" && e.runtimeId === t.row.runtimeId),
    );
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(
      codes(entry).includes("setup-invalid:placeholder-source-missing"),
    );
  }
  // A decision id whose approve event follows the capture.
  {
    const w = world();
    const t = templatize(w, "P-01");
    const approve = t.setup.events.find(
      (e) => e.kind === "approve" && e.runtimeId === t.row.runtimeId,
    );
    approve.seq = 99;
    t.setup.events.sort((a, b) => a.seq - b.seq);
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid");
    assert.ok(codes(entry).includes("setup-invalid:placeholder-after-capture"));
  }
  // Two rows for the same (kind, source, stage).
  {
    const w = world();
    const t = templatize(w, "P-01");
    t.setup.runtimeValues.push({ ...t.setup.runtimeValues[0] });
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.ok(codes(entry).includes("setup-invalid:placeholder-duplicate"));
  }
});

test("template-source-order: a resolved value is bounded ASCII", () => {
  for (const [name, value, field] of [
    ["too long token", "t".repeat(81), "token"],
    ["escape character", 'a"b', "token"],
    ["too long id", "i".repeat(37), "proposalId"],
    ["newline", "a\nb", "decisionId"],
    ["tab", "a\tb", "decisionId"],
  ]) {
    const w = world();
    const t = templatize(w, "P-01");
    if (field === "token") t.setup.runtimeValues[0].value = value;
    else t.row[field] = value;
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid", name);
  }
});

test("template-forbidden: a forbidden template resolves with the earlier stage's values", () => {
  const w = world();
  const { first, second } = templatizeP10(w);
  // The stage-2 payload repeats the OLD qualification (stage-1 ids and token).
  const oldText = qualificationText(first.revision, first.values);
  repayload(second.request, (payload) => {
    payload.messages[0].content = injectIntoRaw(
      payload.messages[0].content,
      oldText,
    );
  });
  const leaked = result(score(w), "P-10", positiveId("P-10"), 2);
  assert.ok(
    codes(leaked).includes("forbidden-text"),
    JSON.stringify(codes(leaked)),
  );
  // The same text with another token is not the old stage's entry.
  const w2 = world();
  const t2 = templatizeP10(w2);
  repayload(t2.second.request, (payload) => {
    payload.messages[0].content = injectIntoRaw(
      payload.messages[0].content,
      qualificationText(t2.first.revision, {
        ...t2.first.values,
        token: TOKEN_2,
      }),
    );
  });
  const other = result(score(w2), "P-10", positiveId("P-10"), 2);
  assert.ok(
    !codes(other).includes("forbidden-text"),
    JSON.stringify(codes(other)),
  );
});

test("template-forbidden: a forbidden proposal / decision id of an old Revision is found", () => {
  const w = world();
  const { first, second } = templatizeP10(w);
  repayload(second.request, (payload) => {
    payload.messages[0].content = injectIntoRaw(
      payload.messages[0].content,
      first.values.proposalId,
    );
  });
  const leaked = result(score(w), "P-10", positiveId("P-10"), 2);
  assert.ok(
    codes(leaked).includes("forbidden-id"),
    JSON.stringify(codes(leaked)),
  );
});

test("template-forbidden: a forbidden template no earlier stage can resolve is setup-invalid", () => {
  const w = world();
  const { second } = templatizeP10(w);
  second.spec.expected.forbidden.texts.push(
    '{"x":"{{sourceToken:never-set}}"}',
  );
  const entry = result(score(w), "P-10", positiveId("P-10"), 2);
  assert.equal(entry.status, "invalid");
  assert.ok(codes(entry).includes("setup-invalid:placeholder-unresolved"));
});

// ----------------------------------------- P-12 pair: shared request checks

function scoreP12(p12, overrides = {}) {
  return scoreP12Pair({
    request: p12.request,
    expectation: p12.expectation,
    template,
    fixtureRoute: p12.route,
    fixture: p12.fixture,
    otherMarkers: ["MARKER-P-01-raw"],
    otherIds: ["rt:rev-P-01-a"],
    ...overrides,
  });
}

/** Rewrites the baseline arm's payload and re-derives its digest. */
function repayloadBaseline(request, mutate) {
  const parsed = JSON.parse(request.baseline.payload);
  mutate(parsed);
  request.baseline.payload = canonicalJson(parsed);
  request.baseline.payloadDigest = payloadDigest(parsed);
}

test("p12-shared-checks: the honest pair passes with the shared checks on", () => {
  const scored = scoreP12(buildSyntheticP12({ template }));
  assert.equal(scored.status, "passed", JSON.stringify(scored.failures));
});

test("p12-shared-checks: a baseline that drops or replaces Raw fails (Raw is required in both arms)", () => {
  for (const raw of ["x", "診断"]) {
    const p12 = buildSyntheticP12({ template });
    repayloadBaseline(p12.request, (payload) => {
      payload.messages[0].content = payload.messages[0].content.replace(
        "診断用の本文。MARKER-DIAG-raw",
        raw,
      );
    });
    const scored = scoreP12(p12);
    assert.equal(scored.status, "failed", raw);
    assert.ok(
      scored.failures.some(
        (f) => f.code === "raw-mismatch" && f.message.startsWith("baseline"),
      ),
      raw,
    );
  }
});

test("p12-shared-checks: a candidate whose Raw carries a canary fails, even with every digest realigned", () => {
  const p12 = buildSyntheticP12({ template });
  const poisoned = `診断用の本文。MARKER-DIAG-raw ${CANARIES[0].text}`;
  repayload(p12.request, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "診断用の本文。MARKER-DIAG-raw",
      poisoned,
    );
  });
  p12.request.capture.candidateSet.items[0].text = poisoned;
  const scored = scoreP12(p12);
  assert.equal(scored.status, "failed");
  assert.ok(scored.failures.some((f) => f.code === "canary-in-payload"));
  // The frozen Raw text is the diagnostic's, not what the capture says.
  assert.ok(scored.failures.some((f) => f.code === "raw-mismatch"));
});

test("p12-shared-checks: another case's marker or id in either arm fails", () => {
  for (const arm of ["candidate", "baseline"]) {
    const p12 = buildSyntheticP12({ template });
    const mutate = (payload) => {
      payload.messages[1].content += " MARKER-P-01-raw rt:rev-P-01-a";
    };
    if (arm === "candidate") repayload(p12.request, mutate);
    else repayloadBaseline(p12.request, mutate);
    const scored = scoreP12(p12);
    assert.equal(scored.status, "failed", arm);
    assert.ok(
      scored.failures.some(
        (f) => f.code === "other-case-material" && f.message.startsWith(arm),
      ),
      arm,
    );
  }
});

test("p12-shared-checks: the capture must hold the diagnostic's user message, estimator and template", () => {
  const userMessage = buildSyntheticP12({ template });
  userMessage.expectation.userMessage = "別のメッセージ";
  const byMessage = scoreP12(userMessage);
  assert.equal(byMessage.status, "failed");
  assert.ok(
    byMessage.failures.some(
      (f) => f.code === "same-input-check-rejects-userMessage",
    ),
  );
  const estimator = buildSyntheticP12({ template });
  estimator.request.capture.estimatorVersion = "nir1-context-estimator-v0";
  estimator.request.baseline.inputs.estimatorVersion =
    "nir1-context-estimator-v0";
  assert.ok(
    scoreP12(estimator).failures.some(
      (f) => f.code === "same-input-check-rejects-estimatorVersion",
    ),
  );
  const ref = buildSyntheticP12({ template });
  ref.request.capture.template.ref = "other-template-ref";
  ref.request.baseline.inputs.template = { ...ref.request.capture.template };
  assert.ok(
    scoreP12(ref).failures.some(
      (f) => f.code === "same-input-check-rejects-template",
    ),
  );
  const route = buildSyntheticP12({ template });
  route.request.capture.route.model = "another-model";
  route.request.baseline.inputs.route = { ...route.request.capture.route };
  assert.ok(
    scoreP12(route).failures.some(
      (f) => f.code === "same-input-check-rejects-route",
    ),
  );
});

test("p12-shared-checks: an expectation without Raw, user message or the fixture is not scored as a pass", () => {
  for (const mutate of [
    (p12) => delete p12.expectation.rawText,
    (p12) => delete p12.expectation.userMessage,
    (p12) => delete p12.expectation.passedRuntimeIds,
    (p12) => delete p12.fixture,
  ]) {
    const p12 = buildSyntheticP12({ template });
    mutate(p12);
    const scored = scoreP12(p12, { fixture: p12.fixture });
    assert.equal(scored.status, "failed");
    assert.ok(
      scored.failures.some((f) => f.code === "p12-expectation-incomplete"),
    );
  }
});

test("p12-shared-checks: the scored diagnostic receives the fixture's canaries and every case's material", () => {
  const w = addSyntheticDiagnostic(world());
  const request = w.receipt.requests.find((row) => row.caseId === "DIAG-P12");
  repayloadBaseline(request, (payload) => {
    payload.messages[1].content += " MARKER-P-01-raw";
  });
  const scored = score(w);
  assert.equal(scored.status, "failed");
  assert.ok(
    scored.diagnostics[0].failures.some(
      (f) => f.code === "other-case-material",
    ),
  );
  const raw = addSyntheticDiagnostic(world());
  const rawRequest = raw.receipt.requests.find(
    (row) => row.caseId === "DIAG-P12",
  );
  repayloadBaseline(rawRequest, (payload) => {
    payload.messages[0].content = payload.messages[0].content.replace(
      "診断用の本文。MARKER-DIAG-raw",
      "x",
    );
  });
  const rawScored = score(raw);
  assert.equal(rawScored.diagnostics[0].status, "failed");
  assert.ok(
    rawScored.diagnostics[0].failures.some((f) => f.code === "raw-mismatch"),
  );
});

// ------------------------------- alignment keeps the candidate set's order

/**
 * One Revision (`rt:revB`) with two atomic groups: group A (dropped by the
 * budget) and group B (the only one in the payload). Both share the closed
 * negation and attribution texts.
 */
function twoGroupWorld() {
  const rendered = renderSynthetic({
    template,
    route: SYNTHETIC_ROUTE,
    userMessage: "続きを書いてください。",
    rawText: "本文。",
    revisions: [{ id: "revA", selected: [] }, "revB"],
    requestToken: "token-two-groups",
  });
  const items = rendered.items.map((item) =>
    item.ownerId === "rt:revA" ? { ...item, ownerId: "rt:revB" } : item,
  );
  const capture = { candidateSet: { items } };
  const view = {
    payload: rendered.payload,
    renderCorrespondence: rendered.renderCorrespondence,
    inputReferences: rendered.inputReferences,
    qualifications: rendered.qualifications,
  };
  const read = readPayload(view, capture, template);
  return { capture, view, read, items };
}

test("alignEntries: a later atomic group's closed markers are not paired with an earlier group's items", () => {
  const { capture, view, read } = twoGroupWorld();
  assert.deepEqual(read.failures, []);
  const alignment = alignEntries({ ...read, view, capture });
  // raw=0, group A=1..5, group B=6..10: the payload holds exactly group B.
  assert.deepEqual(alignment.matched, [6, 7, 8, 9, 10]);
  assert.deepEqual(alignment.failures, []);
  const slots = deriveSlots({
    improvementGroups: [{ ownerId: "rt:revB", kind: "accepted-ir" }],
    ...read,
    view,
    capture,
    matched: alignment.matched,
  });
  assert.equal(slots.qualifiedEvidence, 1);
  const judged = slots.groups[0].atomicGroups;
  assert.equal(judged.length, 2);
  assert.equal(
    judged.find((g) => g.atomicGroup === "group:revB").counted,
    true,
  );
  assert.equal(
    judged.find((g) => g.atomicGroup === "group:revA").counted,
    false,
  );
});

test("alignEntries: entries out of the candidate set's order are a failure", () => {
  const { capture, view, read } = twoGroupWorld();
  const reversed = {
    ...read,
    cut: { ...read.cut, entries: [...read.cut.entries].reverse() },
  };
  const alignment = alignEntries({ ...reversed, view, capture });
  assert.ok(
    alignment.failures.some((f) => f.code === "entry-not-in-candidate-set"),
  );
});

test("alignEntries: a partial atomic group is still reported once the first group is in order", () => {
  const { capture, view, read } = twoGroupWorld();
  const partial = {
    ...read,
    cut: { ...read.cut, entries: read.cut.entries.slice(0, 3) },
    codex: read.codex.slice(0, 3),
  };
  const alignment = alignEntries({ ...partial, view, capture });
  assert.deepEqual(alignment.matched, [6, 7, 8]);
  assert.ok(alignment.failures.some((f) => f.code === "atomic-group-partial"));
});

// ---------------------------------------- review follow-ups (P3 items)

test("template-source-order: a legacy Source token with a space resolves and scores", () => {
  const w = world();
  const t = templatize(w, "P-01");
  const legacy = "v3@2026-10-18 07:05:22";
  t.setup.runtimeValues.at(-1).value = legacy;
  t.apply({ ...t.values, token: legacy });
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "passed", JSON.stringify(codes(entry)));
});

test("setup-verification: a setup event is recorded by a writer of its kind", () => {
  const cases = [
    ["prepare", "codex_create"],
    ["approve", "nir1_entity_relation_revision_prepare"],
    ["approve", "codex_create"],
    ["chat-session", "tree_node_create"],
    ["restricted", "codex_create"],
    ["tree", "narrative_extraction_append_human_decision"],
    ["route-settings", "tree_node_create"],
  ];
  for (const [kind, writer] of cases) {
    const w = world();
    const setup = setupFor(w, "P-01", positiveId("P-01"));
    setup.events.find((event) => event.kind === kind).writer = writer;
    setup.writersUsed = [...new Set(setup.events.map((e) => e.writer))];
    const entry = result(score(w), "P-01", positiveId("P-01"));
    assert.equal(entry.status, "invalid", `${kind} by ${writer}`);
    assert.ok(
      codes(entry).includes("setup-invalid:writer-kind-mismatch"),
      `${kind} by ${writer}: ${codes(entry)}`,
    );
  }
  // The honest receipt records every event with a writer of its kind.
  assert.equal(score(world()).status, "passed");
});

test("template-forbidden: a forbidden template that resolves into an expected entry is a fixture error, not a product failure", () => {
  const w = world();
  const t = templatize(w, "P-01");
  // The same token the expected entry holds, forbidden by a placeholder of
  // another kind: both resolve to the same bytes.
  const spec = t.spec;
  spec.expected.forbidden.texts.push("{{sourceToken:scene-P-01}}");
  t.setup.runtimeValues.push({
    ...t.setup.runtimeValues.at(-1),
    kind: "sourceToken",
  });
  const entry = result(score(w), "P-01", positiveId("P-01"));
  assert.equal(entry.status, "invalid");
  assert.ok(
    codes(entry).includes("setup-invalid:forbidden-overlaps-expected"),
    String(codes(entry)),
  );
});
