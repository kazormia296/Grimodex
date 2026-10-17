// Scorer tests on synthetic receipts (hand-built values; Native is not run).
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DPH_CASE_IDS } from "./contract.mjs";
import {
  escapeReservedPromptTags,
  estimateTokens,
  loadFixedTemplate,
} from "./payload.mjs";
import { SAME_INPUT_FIELDS } from "./receipt.mjs";
import {
  alignEntries,
  checkSameInput,
  deriveSlots,
  readPayload,
  scanForbidden,
  scoreFinalRequestReceipt,
  scoreP12Pair,
  scorerDigest,
} from "./scorer.mjs";
import {
  CANARIES,
  addSyntheticDiagnostic,
  buildSyntheticP12,
  buildSyntheticWorld,
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
  });
  assert.equal(ok.status, "passed");

  const loosened = scoreP12Pair({
    request: p12.request,
    expectation: { ...p12.expectation, candidateTarget: 2 },
    template,
    fixtureRoute: p12.route,
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
  });
  assert.ok(scored.failures.some((f) => f.code === "history-input-present"));
});
