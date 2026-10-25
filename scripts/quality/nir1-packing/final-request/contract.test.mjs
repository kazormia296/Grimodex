import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  APPROVING_VERDICT,
  EVIDENCE_FIXTURE_VERSION,
  FIXTURE_VERSIONS,
  fixtureMaterials,
  fixtureVersionSpec,
  replacedMaterialReuseErrors,
  FREEZE_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  PLACEHOLDER_KINDS,
  PLACEHOLDER_VALUE_PATTERN,
  SCORER_FILES,
  deriveFreezeCommit as deriveFreezeCommitOfVersion,
  estimateTemplateTokens,
  resolveTemplate,
  templateErrors,
  templatePlaceholders,
  isAncestorCommit,
  sha256,
  validateFinalRequestFixture,
  validateFreezeRecord as validateFreezeRecordOfVersion,
  validateNir1FinalRequestFixtures,
  validateReviewRecord,
  verifyFreezeOrder,
  verifyFrozenSnapshot as verifyFrozenSnapshotOfVersion,
} from "./contract.mjs";
import { estimateTokens, loadFixedTemplate } from "./payload.mjs";
import { CONTRACT_ID, DRAFT_REF } from "./receipt.mjs";
import { buildSyntheticWorld } from "./synthetic.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const template = await loadFixedTemplate(repoRoot);
const baseWorld = buildSyntheticWorld({ template });

// The synthetic frozen world is the freezable replacement version (2); the
// version it replaces is the real version 1 (the HOLD history), whose
// materials the synthetic fixture does not share.
const V1 = FIXTURE_VERSIONS[1];
const V2 = FIXTURE_VERSIONS[2];
const FIXTURE_PATH = V2.fixturePath;
const FREEZE_PATH = V2.freezePath;
const REVIEW_PATH = V2.reviewPath;
const README_PATH = V2.readmePath;
const PARITY_VECTOR_PATH = V2.parityVectorPath;
const v1FixtureBytes = await readFile(path.join(repoRoot, V1.fixturePath));
const v1FreezeBytes = await readFile(path.join(repoRoot, V1.freezePath));
const replacedRecords = Object.freeze({
  fixture: JSON.parse(v1FixtureBytes),
  freeze: JSON.parse(v1FreezeBytes),
});
const v2Fixture = { ...structuredClone(baseWorld.fixture), fixtureVersion: 2 };
const realParityBytes = await readFile(
  path.join(repoRoot, V2.parityVectorPath),
);

/** validateFreezeRecord for the synthetic version-2 world (overridable). */
function validateFreezeRecord(freeze, options = {}) {
  return validateFreezeRecordOfVersion(freeze, {
    fixture: v2Fixture,
    replaced: replacedRecords,
    ...options,
  });
}
const verifyFrozenSnapshot = (args) =>
  verifyFrozenSnapshotOfVersion({ fixtureVersion: 2, ...args });
const deriveFreezeCommit = (args) =>
  deriveFreezeCommitOfVersion({ fixtureVersion: 2, ...args });

function fixture() {
  return structuredClone(baseWorld.fixture);
}

function errorsOf(mutate, options = { template }) {
  const value = fixture();
  mutate(value);
  return validateFinalRequestFixture(value, options);
}

function firstPositive(value, caseId = "P-01") {
  return value.cases.find((c) => c.caseId === caseId).variants[0].requests[0];
}

// ---------------------------------------------------------------- fixture

test("a consistent synthetic fixture validates, including the budget formula", () => {
  assert.deepEqual(validateFinalRequestFixture(fixture(), { template }), []);
  assert.deepEqual(validateFinalRequestFixture(fixture()), []);
});

test("fixture: schema header, version, phase and route are closed", () => {
  for (const [mutate, expected] of [
    [
      (f) => {
        f.schemaVersion = "x";
      },
      "schemaVersion",
    ],
    [
      (f) => {
        f.contractId = "x";
      },
      "contractId",
    ],
    [
      (f) => {
        f.draftRef = "x";
      },
      "draftRef",
    ],
    [
      (f) => {
        f.fixtureVersion = 3;
      },
      "fixtureVersion",
    ],
    [
      (f) => {
        f.phase = "dd-1";
      },
      "phase",
    ],
    [
      (f) => {
        f.estimatorVersion = "x";
      },
      "estimatorVersion",
    ],
    [
      (f) => {
        f.fixedTemplate.version = "x";
      },
      "fixedTemplate",
    ],
    [
      (f) => {
        f.route.contextWindowTokens = 0;
      },
      "contextWindowTokens",
    ],
    [
      (f) => {
        delete f.route.model;
      },
      "route.model",
    ],
    [
      (f) => {
        delete f.excludedNegatives;
      },
      "excludedNegatives",
    ],
  ]) {
    assert.ok(
      errorsOf(mutate).some((e) => e.includes(expected)),
      expected,
    );
  }
});

test("fixture: exactly the nine DP-H cases, each isolated", () => {
  assert.ok(
    errorsOf((f) => {
      f.cases.pop();
    }).some((e) => e.includes("exactly P-01")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[1].caseId = "P-03";
    }).some((e) => e.includes("cases[1].caseId")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[1].isolation.workspaceId = f.cases[0].isolation.workspaceId;
    }).some((e) => e.includes("workspaceId is shared")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[1].isolation.artifactNamespace =
        f.cases[0].isolation.artifactNamespace;
    }).some((e) => e.includes("artifactNamespace is shared")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[0].variants.splice(1);
      f.cases[0].variants[0].kind = "reject";
    }).length > 0,
  );
});

test("fixture: canaries cover both kinds and stay out of the expected payload", () => {
  assert.ok(
    errorsOf((f) => {
      f.canaries = f.canaries.slice(0, 1);
    }).some((e) => e.includes("internal-metadata")),
  );
  assert.ok(
    errorsOf((f) => {
      f.canaries[0].text = "short";
    }).some((e) => e.includes("detection string")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.codexEntries[0].text += f.canaries[0].text;
    }).some((e) => e.includes("contains canary")),
  );
});

test("fixture: expected entries are whole, ordered, consecutive and separator-free", () => {
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.codexEntries[0].text += "\\n";
    }).length === 0,
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.codexEntries[0].text = "a\nb";
    }).some((e) => e.includes("separator")),
  );
  assert.ok(
    errorsOf((f) => {
      const entries = firstPositive(f).expected.codexEntries;
      [entries[1], entries[2]] = [entries[2], entries[1]];
    }).some((e) => e.includes("in that order")),
  );
  assert.ok(
    errorsOf((f) => {
      const request = firstPositive(f);
      const [first, second, ...rest] = request.expected.codexEntries;
      request.expected.codexEntries = [
        first,
        ...rest.slice(0, 1),
        second,
        ...rest.slice(1),
      ];
    }).length > 0,
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.codexEntries = [];
    }).some((e) => e.includes("non-empty array of IR entries")),
  );
});

test("fixture: the context budget follows the formula and holds the selection", () => {
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.contextBudgetTokens += 1;
    }).some((e) => e.includes("budget formula")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.contextBudgetTokens = 5;
    }, {}).some((e) => e.includes("exceeds contextBudgetTokens")),
  );
});

test("fixture: exact quotes and forbidden material are consistent", () => {
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.exactQuotes[0].quote = "not in the entry";
    }).some((e) => e.includes("substring")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.exactQuotes = [];
    }).some((e) => e.includes("exactQuotes")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.forbidden.logicalIds.push("rev-P-01-a");
    }).some((e) => e.includes("names selected")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.forbidden.texts.push("MARKER-P-01-raw");
    }).some((e) => e.includes("contains")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.embeddedCanaryIds.push("unknown");
    }).some((e) => e.includes("unknown canary")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.rawText = "<current_scene> in raw";
    }).some((e) => e.includes("reserved prompt tag")),
  );
});

test("fixture: a reject variant is its positive variant plus exactly one ineligible Revision", () => {
  const rejectOf = (f) => f.cases[0].variants[1];
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).requests[0].revisionIds.pop();
    }).some((e) => e.includes("exactly one ineligible")),
  );
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).requests[0].revisionIds.push("rev-extra");
    }).some((e) => e.includes("exactly one ineligible")),
  );
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).ineligibleLogicalId = "other";
    }).some((e) => e.includes("exactly one ineligible")),
  );
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).baseVariantId = "missing";
    }).some((e) => e.includes("baseVariantId")),
  );
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).requests[0].expected.code = "OTHER";
    }).some((e) => e.includes("NIR1_NATIVE_A2_UNAVAILABLE")),
  );
  assert.ok(
    errorsOf((f) => {
      rejectOf(f).requests[0].expected.reason = "";
    }).some((e) => e.includes("reason")),
  );
  assert.ok(
    errorsOf((f) => {
      delete rejectOf(f).negative;
    }).some((e) => e.includes("negative")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[0].variants.pop();
    }).length === 0,
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[0].variants.shift();
    }).some((e) => e.includes("positive variant")),
  );
});

test("fixture: P-10 stages are ordered and the reject variant targets request 2", () => {
  const p10 = (f) => f.cases.find((c) => c.caseId === "P-10");
  assert.equal(p10(fixture()).variants[0].requests.length, 2);
  assert.ok(
    errorsOf((f) => {
      p10(f).variants[0].requests[1].stage = 3;
    }).some((e) => e.includes("stage must be 2")),
  );
  assert.ok(
    errorsOf((f) => {
      p10(f).variants[1].requests[1].revisionIds =
        p10(f).variants[0].requests[1].revisionIds;
    }).some((e) => e.includes("exactly one ineligible")),
  );
});

test("fixture: marker strings, logical ids and diagnostics stay inside their case", () => {
  assert.ok(
    errorsOf((f) => {
      firstPositive(f, "P-02").expected.rawText += " MARKER-P-01-raw";
    }).some((e) => e.includes("marker")),
  );
  assert.ok(
    errorsOf((f) => {
      f.cases[1].variants[0].requests[0].revisionIds[0] =
        f.cases[0].variants[0].requests[0].revisionIds[0];
    }).some((e) => e.includes("is shared by cases")),
  );
  const diagnostic = {
    caseId: "DIAG-P12",
    evidenceUse: "none",
    userMessage: "diagnostic message",
    rawText: "diagnostic raw text",
    materials: [{ logicalId: "diag-x", text: "diagnostic only text" }],
    p12: {
      variantId: "DIAG-P12-v1",
      revisionIds: ["diag-x", "diag-g"],
      improvementGroups: [{ logicalId: "diag-g", kind: "graph-evidence" }],
      contextBudgetTokens: 500,
    },
  };
  assert.deepEqual(
    errorsOf((f) => {
      f.diagnosticCases = [diagnostic];
    }),
    [],
  );
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [
        {
          ...diagnostic,
          p12: {
            ...diagnostic.p12,
            improvementGroups: [
              { logicalId: "elsewhere", kind: "graph-evidence" },
            ],
          },
        },
      ];
    }).some((e) => e.includes("p12 needs")),
  );
  // The diagnostic's Raw is required (both P-12 arms hold it), is not a
  // reserved-tag text and does not reuse a fixture case's text.
  for (const [rawText, needle] of [
    [undefined, "rawText is required"],
    ["", "rawText is required"],
    ["<chronicle_snapshot>x", "reserved prompt tag"],
  ]) {
    assert.ok(
      errorsOf((f) => {
        f.diagnosticCases = [{ ...diagnostic, rawText }];
      }).some((e) => e.includes(needle)),
      String(rawText),
    );
  }
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [
        {
          ...diagnostic,
          rawText: firstPositive(f, "P-01").expected.rawText,
        },
      ];
    }).some((e) => e.includes("rawText reuses text of a fixture case")),
  );
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [{ ...diagnostic, evidenceUse: "p-evidence" }];
    }).some((e) => e.includes("never P evidence")),
  );
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [{ ...diagnostic, caseId: "P-12" }];
    }).some((e) => e.includes("DIAG-")),
  );
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [
        { ...diagnostic, materials: [{ logicalId: "rev-P-01-a", text: "x" }] },
      ];
    }).some((e) => e.includes("reuses logical id")),
  );
  assert.ok(
    errorsOf((f) => {
      f.diagnosticCases = [
        {
          ...diagnostic,
          materials: [
            {
              logicalId: "diag-y",
              text: f.cases[0].variants[0].requests[0].expected.rawText,
            },
          ],
        },
      ];
    }).some((e) => e.includes("reuses text")),
  );
});

// ----------------------------------------------------------------- review

function reviewRecord(fixtureBytes) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    verdict: APPROVING_VERDICT,
    reviewer: {
      agent: "reviewer-agent",
      model: "opus",
      distinctFromFixtureAuthor: true,
      distinctFromImplementers: true,
      readOnly: true,
      nativeOutputObserved: false,
    },
    fixtureSha256: sha256(fixtureBytes),
    requiredChanges: [],
    cases: baseWorld.fixture.cases.map((testCase) => ({
      caseId: testCase.caseId,
      verdict: APPROVING_VERDICT,
    })),
  };
}

const fixtureBytes = Buffer.from(JSON.stringify(v2Fixture));

test("review record: an approving review is independent, read-only and bound to the fixture bytes", () => {
  const ok = reviewRecord(fixtureBytes);
  assert.deepEqual(
    validateReviewRecord(ok, {
      fixtureSha256: sha256(fixtureBytes),
      fixture: baseWorld.fixture,
    }),
    [],
  );
  for (const [mutate, expected] of [
    [
      (r) => {
        r.reviewer.distinctFromFixtureAuthor = false;
      },
      "distinct from the fixture author",
    ],
    [
      (r) => {
        r.reviewer.distinctFromImplementers = false;
      },
      "distinct from the harness implementers",
    ],
    [
      (r) => {
        r.reviewer.readOnly = false;
      },
      "read-only",
    ],
    [
      (r) => {
        r.reviewer.nativeOutputObserved = true;
      },
      "must not have observed Native output",
    ],
    [
      (r) => {
        r.requiredChanges = ["fix P-02"];
      },
      "no required change",
    ],
    [
      (r) => {
        r.cases.pop();
      },
      "cover every fixture case",
    ],
    [
      (r) => {
        r.cases[0].verdict = "changes-required";
      },
      "does not approve",
    ],
    [
      (r) => {
        r.fixtureSha256 = "0".repeat(64);
      },
      "changed after the review",
    ],
    [
      (r) => {
        r.schemaVersion = "x";
      },
      "schemaVersion",
    ],
    [
      (r) => {
        r.verdict = "maybe";
      },
      "verdict",
    ],
    [
      (r) => {
        delete r.reviewer.model;
      },
      "reviewer.model",
    ],
  ]) {
    const record = structuredClone(ok);
    mutate(record);
    const errors = validateReviewRecord(record, {
      fixtureSha256: sha256(fixtureBytes),
      fixture: baseWorld.fixture,
    });
    assert.ok(
      errors.some((e) => e.includes(expected)),
      expected,
    );
  }
});

// ----------------------------------------------------------------- freeze

const scorerBytes = new Map(
  SCORER_FILES.map((file, index) => [
    file,
    Buffer.from(`scorer module ${index}`),
  ]),
);

function perRequestOf(fixtureValue) {
  const rows = [];
  for (const testCase of fixtureValue.cases) {
    for (const variant of testCase.variants) {
      for (const [index, request] of variant.requests.entries()) {
        if (variant.kind === "reject" && index === variant.requests.length - 1)
          continue;
        const selected =
          estimateTokens(request.expected.rawText) +
          request.expected.codexEntries.reduce(
            (sum, entry) => sum + estimateTokens(entry.text),
            0,
          );
        rows.push({
          caseId: testCase.caseId,
          variantId: variant.variantId,
          stage: request.stage,
          contextBudgetTokens: request.expected.contextBudgetTokens,
          selectedTokens: selected,
          marginTokens: request.expected.contextBudgetTokens - selected,
        });
      }
    }
  }
  return rows;
}

function freezeWorld() {
  const review = reviewRecord(fixtureBytes);
  const reviewBytes = Buffer.from(JSON.stringify(review));
  const readmeBytes = Buffer.from("fixture README");
  // Version 2 shares version 1's parity vector path, so it binds the same bytes.
  const parityBytes = realParityBytes;
  const bytes = new Map([
    [FIXTURE_PATH, fixtureBytes],
    [REVIEW_PATH, reviewBytes],
    [README_PATH, readmeBytes],
    [PARITY_VECTOR_PATH, parityBytes],
    [V1.fixturePath, v1FixtureBytes],
    [V1.freezePath, v1FreezeBytes],
    ...scorerBytes,
  ]);
  const freeze = {
    schemaVersion: FREEZE_SCHEMA_VERSION,
    contractId: CONTRACT_ID,
    draftRef: DRAFT_REF,
    fixtureVersion: 2,
    status: "frozen",
    nativeOutputObservedBeforeFreeze: false,
    frozenAt: "2026-10-18T00:00:00Z",
    reviewVerdict: APPROVING_VERDICT,
    fixture: { path: FIXTURE_PATH, sha256: sha256(fixtureBytes) },
    reviewRecord: { path: REVIEW_PATH, sha256: sha256(reviewBytes) },
    readme: { path: README_PATH, sha256: sha256(readmeBytes) },
    parityVector: { path: PARITY_VECTOR_PATH, sha256: sha256(parityBytes) },
    scorer: {
      files: SCORER_FILES.map((file) => ({
        path: file,
        sha256: sha256(scorerBytes.get(file)),
      })),
    },
    contextBudget: {
      formula:
        "window - (fixedSystem + user + envelope + output + margin + separators)",
      terms: { fixedSystemTokens: 531 },
      perRequest: perRequestOf(baseWorld.fixture),
    },
    authorSeparation: {
      fixtureAuthor: { agent: "author-agent" },
      expectationReviewer: { agent: "reviewer-agent" },
      harnessImplementers: [
        ...replacedRecords.freeze.authorSeparation.harnessImplementers,
        ...V2.requiredImplementers,
      ],
      nativeReceiptProvidedToAuthor: false,
    },
    supersedes: {
      fixtureVersion: 1,
      fixture: { path: V1.fixturePath, sha256: sha256(v1FixtureBytes) },
      freezeRecord: { path: V1.freezePath, sha256: sha256(v1FreezeBytes) },
      freezeRecordCommit: V1.pinned.freezeRecordCommit,
      decision: V1.supersededDecision,
    },
  };
  return { freeze, bytes, review };
}

test("freeze-record-binds-fixture-scorer-review-sha256: a consistent record validates", () => {
  const { freeze, bytes, review } = freezeWorld();
  assert.deepEqual(validateFreezeRecord(freeze, { bytes, review }), []);
});

test("freeze-record-binds-fixture-scorer-review-sha256: a changed bound file breaks the freeze", () => {
  for (const path_ of [FIXTURE_PATH, REVIEW_PATH, ...SCORER_FILES]) {
    const { freeze, bytes, review } = freezeWorld();
    bytes.set(path_, Buffer.from("changed after the freeze"));
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes(`sha256 for ${path_} differs`)),
      path_,
    );
  }
  const { freeze, bytes, review } = freezeWorld();
  bytes.delete(SCORER_FILES[0]);
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review }).some((e) =>
      e.includes("is missing"),
    ),
  );
});

test("freeze-record-binds-fixture-scorer-review-sha256: a frozen record must bind the README and the parity vector", () => {
  for (const key of ["readme", "parityVector"]) {
    const { freeze, bytes, review } = freezeWorld();
    delete freeze[key];
    assert.ok(
      validateFreezeRecord(freeze, { bytes, review }).some((e) =>
        e.includes(`a frozen record must bind freeze.${key}`),
      ),
      key,
    );
  }
  // A changed parity vector or README breaks the freeze.
  for (const file of [README_PATH, PARITY_VECTOR_PATH]) {
    const { freeze, bytes, review } = freezeWorld();
    bytes.set(file, Buffer.from("changed after the freeze"));
    assert.ok(
      validateFreezeRecord(freeze, { bytes, review }).some((e) =>
        e.includes(`sha256 for ${file} differs`),
      ),
      file,
    );
  }
  // A wrong path is refused too.
  const { freeze, bytes, review } = freezeWorld();
  freeze.parityVector.path = "evals/nir1-packing/other.json";
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review }).some((e) =>
      e.includes("freeze.parityVector.path must be"),
    ),
  );
});

test("freeze-record-binds-fixture-scorer-review-sha256: the record must bind every scorer module", () => {
  const { freeze, bytes, review } = freezeWorld();
  freeze.scorer.files = freeze.scorer.files.filter(
    (file) => !file.path.endsWith("receipt.mjs"),
  );
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review }).some(
      (e) => e.includes("must bind") && e.includes("receipt.mjs"),
    ),
  );
});

test("freeze record: Native must not have been observed, and the order of roles is enforced", () => {
  for (const [mutate, expected] of [
    [
      (f) => {
        f.nativeOutputObservedBeforeFreeze = true;
      },
      "nativeOutputObservedBeforeFreeze",
    ],
    [
      (f) => {
        f.frozenAt = "yesterday";
      },
      "frozenAt",
    ],
    [
      (f) => {
        f.fixtureVersion = 3;
      },
      "fixtureVersion",
    ],
    [
      (f) => {
        f.status = "done";
      },
      "status",
    ],
    [
      (f) => {
        f.reviewVerdict = "pending";
      },
      "reviewVerdict approve",
    ],
    [
      (f) => {
        f.authorSeparation.harnessImplementers.push("author-agent");
      },
      "fixture author must not be a harness implementer",
    ],
    [
      (f) => {
        f.authorSeparation.harnessImplementers.push("reviewer-agent");
      },
      "expectation reviewer must not be a harness implementer",
    ],
    [
      (f) => {
        f.authorSeparation.expectationReviewer.agent = "author-agent";
      },
      "must differ",
    ],
    [
      (f) => {
        f.authorSeparation.nativeReceiptProvidedToAuthor = true;
      },
      "nativeReceiptProvidedToAuthor",
    ],
    [
      (f) => {
        f.authorSeparation.harnessImplementers = [];
      },
      "harnessImplementers",
    ],
    [
      (f) => {
        delete f.contextBudget.formula;
      },
      "formula",
    ],
    [
      (f) => {
        f.contextBudget.perRequest[0].marginTokens = 1;
      },
      "marginTokens must be",
    ],
    [
      (f) => {
        f.contextBudget.perRequest = [];
      },
      "perRequest",
    ],
    [
      (f) => {
        f.fixture.path = "evals/other.json";
      },
      "freeze.fixture.path",
    ],
  ]) {
    const { freeze, bytes, review } = freezeWorld();
    mutate(freeze);
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
  }
});

test("freeze record: an observation of Native on the materials is recorded honestly and blocks the freeze", () => {
  const observation = {
    by: "a harness builder",
    what: "ran every variant of the fixture through D-final before the freeze",
    commit: "a14eac73",
  };
  // A pending record may say true when it lists what was observed.
  {
    const { freeze, bytes, review } = freezeWorld();
    freeze.status = "pending-review";
    freeze.reviewVerdict = "pending";
    freeze.nativeOutputObservedBeforeFreeze = true;
    freeze.nativeObservations = [observation];
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      !errors.some((e) => e.includes("nativeOutputObservedBeforeFreeze")),
      errors.join(" | "),
    );
  }
  // A frozen record may not.
  {
    const { freeze, bytes, review } = freezeWorld();
    freeze.nativeOutputObservedBeforeFreeze = true;
    freeze.nativeObservations = [observation];
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes("a frozen record must have")),
      errors.join(" | "),
    );
  }
  // true without an observation, and false with one, are both inconsistent.
  for (const [flag, list, expected] of [
    [true, undefined, "must say what was observed"],
    [true, [], "must say what was observed"],
    [false, [observation], "must be true"],
  ]) {
    const { freeze, bytes, review } = freezeWorld();
    freeze.status = "pending-review";
    freeze.reviewVerdict = "pending";
    freeze.nativeOutputObservedBeforeFreeze = flag;
    if (list !== undefined) freeze.nativeObservations = list;
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
  }
  // An observation entry needs who, what and which commit.
  {
    const { freeze, bytes, review } = freezeWorld();
    freeze.status = "pending-review";
    freeze.reviewVerdict = "pending";
    freeze.nativeOutputObservedBeforeFreeze = true;
    freeze.nativeObservations = [{ by: "someone" }];
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes("needs by, what and commit")),
      errors.join(" | "),
    );
  }
});

test("freeze record: a frozen status needs an approving, valid review record; pending does not", () => {
  const { freeze, bytes, review } = freezeWorld();
  const changes = { ...review, verdict: "changes-required" };
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review: changes }).some((e) =>
      e.includes("approving review record"),
    ),
  );
  assert.ok(
    validateFreezeRecord(freeze, { bytes }).some((e) =>
      e.includes("requires its review record"),
    ),
  );
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review, reviewErrors: ["bad"] }).some(
      (e) => e.includes("valid review record"),
    ),
  );
  const pending = { ...freeze, status: "pending-review" };
  delete pending.reviewVerdict;
  assert.deepEqual(validateFreezeRecord(pending, { bytes }), []);
});

// -------------------------------------------------------------------- git

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "nir1-freeze-"));
  git(dir, "init", "-q");
  await writeFile(path.join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "freeze");
  const freezeCommit = git(dir, "rev-parse", "HEAD");
  await writeFile(path.join(dir, "b.txt"), "b");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "run");
  const runCommit = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "side", freezeCommit);
  await writeFile(path.join(dir, "c.txt"), "c");
  git(dir, "add", "c.txt");
  git(dir, "commit", "-q", "-m", "side");
  const sideCommit = git(dir, "rev-parse", "HEAD");
  return { dir, freezeCommit, runCommit, sideCommit };
}

test("freeze-commit-is-ancestor-of-head: real git history", async () => {
  const { dir, freezeCommit, runCommit, sideCommit } = await tempRepo();
  try {
    assert.equal(isAncestorCommit(dir, freezeCommit, runCommit), true);
    assert.equal(isAncestorCommit(dir, freezeCommit, freezeCommit), true);
    assert.equal(isAncestorCommit(dir, runCommit, freezeCommit), false);
    assert.equal(isAncestorCommit(dir, runCommit, sideCommit), false);
    assert.deepEqual(
      verifyFreezeOrder({
        repoRoot: dir,
        freezeCommit,
        runCommits: [runCommit, sideCommit],
      }),
      [],
    );
    const reversed = verifyFreezeOrder({
      repoRoot: dir,
      freezeCommit: runCommit,
      runCommits: [freezeCommit],
    });
    assert.ok(reversed[0].includes("is not an ancestor"));
    const diverged = verifyFreezeOrder({
      repoRoot: dir,
      freezeCommit: runCommit,
      runCommits: [sideCommit],
    });
    assert.ok(diverged[0].includes("is not an ancestor"));
    // A commit the repository does not know cannot be verified: an error, never "ancestor".
    const unknown = verifyFreezeOrder({
      repoRoot: dir,
      freezeCommit: "e".repeat(40),
      runCommits: [runCommit],
    });
    assert.ok(unknown[0].includes("could not be verified"));
    assert.throws(() => isAncestorCommit(dir, "e".repeat(40), runCommit));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeze-commit-is-ancestor-of-head: one synchronous bounded git child per commit, exit codes mapped", () => {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    const error = new Error("not ancestor");
    error.status = 1;
    throw error;
  };
  const a = "1".repeat(40);
  const b = "2".repeat(40);
  assert.equal(isAncestorCommit("/repo", a, b, { execFile }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["merge-base", "--is-ancestor", a, b]);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.shell, undefined);
  // The same run commit is checked once, however often it appears.
  const ok = [];
  verifyFreezeOrder({
    repoRoot: "/repo",
    freezeCommit: a,
    runCommits: [b, b, b],
    execFile: (...args) => {
      ok.push(args);
      return "";
    },
  });
  assert.equal(ok.length, 1);
  // A timeout or a missing git is never read as "yes".
  const timeout = () => {
    const error = new Error("spawnSync git ETIMEDOUT");
    error.code = "ETIMEDOUT";
    throw error;
  };
  assert.throws(() => isAncestorCommit("/repo", a, b, { execFile: timeout }));
  assert.ok(
    verifyFreezeOrder({
      repoRoot: "/repo",
      freezeCommit: a,
      runCommits: [b],
      execFile: timeout,
    })[0].includes("could not be verified"),
  );
  assert.deepEqual(
    verifyFreezeOrder({
      repoRoot: "/repo",
      freezeCommit: "x",
      runCommits: [b],
    }),
    ["freeze commit must be a full commit id"],
  );
  assert.deepEqual(
    verifyFreezeOrder({ repoRoot: "/repo", freezeCommit: a, runCommits: [] }),
    ["at least one run commit is required"],
  );
  assert.throws(() => isAncestorCommit("/repo", "main", b), /full commit id/);
});

// ----------------------------------------------------- frozen snapshot

async function writeRepoFile(dir, relative, bytes) {
  await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
  await writeFile(path.join(dir, relative), bytes);
}

/** A temp repository whose history is: (pending record), freeze commit, run commit. */
async function frozenRepo({ pendingFirst = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "nir1-snapshot-"));
  git(dir, "init", "-q");
  const { freeze, bytes } = freezeWorld();
  for (const [file, content] of bytes) await writeRepoFile(dir, file, content);
  let pendingCommit;
  if (pendingFirst) {
    const pending = { ...freeze, status: "pending-review" };
    delete pending.reviewVerdict;
    await writeRepoFile(dir, FREEZE_PATH, JSON.stringify(pending));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "pending");
    pendingCommit = git(dir, "rev-parse", "HEAD");
  }
  await writeRepoFile(dir, FREEZE_PATH, JSON.stringify(freeze));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "freeze");
  const freezeCommit = git(dir, "rev-parse", "HEAD");
  await writeRepoFile(dir, "other.txt", "unrelated");
  git(dir, "add", "other.txt");
  git(dir, "commit", "-q", "-m", "run");
  const runCommit = git(dir, "rev-parse", "HEAD");
  return { dir, freeze, freezeCommit, runCommit, pendingCommit };
}

test("frozen-snapshot: the freeze commit is derived from history and the run's bytes equal the frozen bytes", async () => {
  const { dir, freezeCommit, runCommit } = await frozenRepo();
  try {
    const result = verifyFrozenSnapshot({ repoRoot: dir, runCommit });
    assert.deepEqual(result.errors, []);
    assert.equal(result.freezeCommit, freezeCommit);
    // The receipt's reported freeze commit must be the derived one.
    assert.deepEqual(
      verifyFrozenSnapshot({
        repoRoot: dir,
        runCommit,
        expectedFreezeCommit: freezeCommit,
      }).errors,
      [],
    );
    assert.ok(
      verifyFrozenSnapshot({
        repoRoot: dir,
        runCommit,
        expectedFreezeCommit: runCommit,
      }).errors.some((e) => e.includes("is not the first commit")),
    );
    // A run on the freeze commit itself is accepted: the record is already committed.
    assert.deepEqual(
      verifyFrozenSnapshot({ repoRoot: dir, runCommit: freezeCommit }).errors,
      [],
    );
    assert.deepEqual(deriveFreezeCommit({ repoRoot: dir, runCommit }), {
      commit: freezeCommit,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen-snapshot: a pending-review record is not a freeze; the first frozen version is", async () => {
  const { dir, freezeCommit, runCommit, pendingCommit } = await frozenRepo({
    pendingFirst: true,
  });
  try {
    assert.notEqual(pendingCommit, freezeCommit);
    assert.equal(
      verifyFrozenSnapshot({ repoRoot: dir, runCommit }).freezeCommit,
      freezeCommit,
    );
    // Run at the pending commit: nothing was frozen yet.
    const early = verifyFrozenSnapshot({
      repoRoot: dir,
      runCommit: pendingCommit,
    });
    assert.ok(early.errors.some((e) => e.includes("no commit holds a frozen")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen-snapshot: changing the fixture and re-binding the record in one later commit is detected", async () => {
  const { dir, freeze, freezeCommit } = await frozenRepo();
  try {
    // After "observing", fix the expectation and move the record's sha256 with it.
    const changed = JSON.parse(
      await readFile(path.join(dir, FIXTURE_PATH), "utf8"),
    );
    changed.cases[0].task = "changed after the freeze";
    const changedBytes = Buffer.from(JSON.stringify(changed));
    await writeRepoFile(dir, FIXTURE_PATH, changedBytes);
    freeze.fixture.sha256 = sha256(changedBytes);
    await writeRepoFile(dir, FREEZE_PATH, JSON.stringify(freeze));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rewrite expectations");
    const later = git(dir, "rev-parse", "HEAD");
    const result = verifyFrozenSnapshot({ repoRoot: dir, runCommit: later });
    assert.equal(result.freezeCommit, freezeCommit);
    assert.ok(
      result.errors.some((e) =>
        e.includes("freeze record at the run commit differs"),
      ),
    );
    assert.ok(
      result.errors.some(
        (e) =>
          e.includes(FIXTURE_PATH) &&
          e.includes("differs from the frozen bytes"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen-snapshot: any changed bound file, a deleted record and an unreadable history are errors", async () => {
  for (const file of [FIXTURE_PATH, REVIEW_PATH, ...SCORER_FILES]) {
    const { dir } = await frozenRepo();
    try {
      await writeRepoFile(dir, file, "changed without touching the record");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "change");
      const result = verifyFrozenSnapshot({
        repoRoot: dir,
        runCommit: git(dir, "rev-parse", "HEAD"),
      });
      assert.ok(
        result.errors.some((e) => e.includes(file) && e.includes("differs")),
        file,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { dir, runCommit } = await frozenRepo();
  try {
    git(dir, "rm", "-q", FREEZE_PATH);
    git(dir, "commit", "-q", "-m", "delete the record");
    const deleted = verifyFrozenSnapshot({
      repoRoot: dir,
      runCommit: git(dir, "rev-parse", "HEAD"),
    });
    assert.ok(deleted.errors.length > 0);
    const unknown = verifyFrozenSnapshot({
      repoRoot: dir,
      runCommit: "e".repeat(40),
    });
    assert.ok(unknown.errors.length > 0);
    assert.deepEqual(
      verifyFrozenSnapshot({ repoRoot: dir, runCommit }).errors,
      [],
    );
    const timeout = () => {
      const error = new Error("spawnSync git ETIMEDOUT");
      error.code = "ETIMEDOUT";
      throw error;
    };
    assert.ok(
      verifyFrozenSnapshot({ repoRoot: dir, runCommit, execFile: timeout })
        .errors.length > 0,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- fixture/freeze consistency

test("freeze record: scorer.files may not list a path twice", () => {
  const { freeze, bytes, review } = freezeWorld();
  freeze.scorer.files.push({
    ...freeze.scorer.files[0],
    sha256: "e".repeat(64),
  });
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review }).some((e) =>
      e.includes("more than once"),
    ),
  );
});

test("freeze record: one path bound by two fields may not hide a wrong sha256", () => {
  const { freeze, bytes, review } = freezeWorld();
  assert.deepEqual(validateFreezeRecord(freeze, { bytes, review }), []);
  // freeze.fixture carries a wrong sha256 while scorer.files re-binds the same
  // path with the right one: the Map used to keep only the later row.
  const rightFixture = freeze.fixture.sha256;
  freeze.fixture.sha256 = "0".repeat(64);
  freeze.scorer.files.push({ path: freeze.fixture.path, sha256: rightFixture });
  const errors = validateFreezeRecord(freeze, { bytes, review });
  assert.ok(
    errors.some((e) => e.includes("is bound more than once")),
    JSON.stringify(errors),
  );
});

test("review record: a fixture whose cases hold a non-object yields errors, not a TypeError", () => {
  const review = { verdict: "approve", requiredChanges: [], cases: [] };
  let errors;
  assert.doesNotThrow(() => {
    errors = validateReviewRecord(review, { fixture: { cases: [null, 7] } });
  });
  assert.ok(errors.some((e) => e.includes("cover every fixture case")));
});

test("freeze record: the reviewer named in the record is the review record's reviewer", () => {
  const { freeze, bytes, review } = freezeWorld();
  freeze.authorSeparation.expectationReviewer.agent = "someone-else";
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review }).some((e) =>
      e.includes("differs from the review record's reviewer"),
    ),
  );
});

test("freeze record: perRequest must be the fixture's budgets and selected tokens, row for row", () => {
  const value = fixture();
  const check = (mutate) => {
    const { freeze, bytes, review } = freezeWorld();
    mutate(freeze.contextBudget.perRequest);
    return validateFreezeRecord(freeze, { bytes, review, fixture: value });
  };
  assert.deepEqual(
    check(() => {}),
    [],
  );
  assert.ok(
    check((rows) => {
      rows[0].contextBudgetTokens += 1;
      rows[0].marginTokens += 1;
    }).some((e) => e.includes("differs from the fixture")),
  );
  assert.ok(
    check((rows) => {
      rows[0].selectedTokens += 1;
      rows[0].marginTokens -= 1;
    }).some((e) => e.includes("selectedTokens differs")),
  );
  assert.ok(
    check((rows) => {
      rows.pop();
    }).some((e) => e.includes("has no row for the fixture request")),
  );
  assert.ok(
    check((rows) => {
      rows.push({ ...rows[0] });
    }).some((e) => e.includes("more than once")),
  );
  assert.ok(
    check((rows) => {
      rows[0].variantId = "nope";
    }).some((e) => e.includes("is not a positive request")),
  );
});

test("fixture: a later stage uses new Revisions and forbids the old ids and text", () => {
  const p10 = (f) => f.cases.find((c) => c.caseId === "P-10");
  assert.ok(
    errorsOf((f) => {
      const variant = p10(f).variants[0];
      variant.requests[1].revisionIds = [...variant.requests[0].revisionIds];
    }).some((e) => e.includes("reuses the earlier-stage Revision")),
  );
  assert.ok(
    errorsOf((f) => {
      const request = p10(f).variants[0].requests[1];
      request.expected.forbidden.logicalIds =
        request.expected.forbidden.logicalIds.filter(
          (id) => !id.startsWith("rev-P-10-a"),
        );
    }).some((e) => e.includes("must include the earlier-stage id")),
  );
  assert.ok(
    errorsOf((f) => {
      const request = p10(f).variants[0].requests[1];
      request.expected.forbidden.texts =
        request.expected.forbidden.texts.filter(
          (text) => !text.includes("rev-P-10-a"),
        );
    }).some((e) => e.includes("must include the earlier-stage text")),
  );
  // The reject variant may pass an old Revision as its one ineligible id.
  assert.deepEqual(
    errorsOf((f) => {
      const variant = p10(f).variants[1];
      const old = variant.requests[0].revisionIds[0];
      const last = variant.requests[1];
      last.revisionIds = [
        ...variant.requests[1].revisionIds.filter(
          (id) => id !== variant.ineligibleLogicalId,
        ),
        old,
      ];
      variant.ineligibleLogicalId = old;
    }),
    [],
  );
});

test("fixture: P-10 covers the five binding kinds or states why not", () => {
  const p10 = (f) => f.cases.find((c) => c.caseId === "P-10");
  assert.ok(
    errorsOf((f) => {
      delete p10(f).variants[0].binding;
    }).some((e) => e.includes(".binding must be one of")),
  );
  assert.ok(
    errorsOf((f) => {
      f.excludedNegatives = f.excludedNegatives.filter(
        (row) => row.negative !== "freshness",
      );
    }).some((e) => e.includes("binding freshness has no positive variant")),
  );
  assert.ok(
    errorsOf((f) => {
      f.excludedNegatives.push({
        caseId: "P-10",
        negative: "scope",
        reason: "x",
      });
    }).some((e) => e.includes("both covered and excluded")),
  );
});

test("a JSON null fixture or freeze record is reported, not thrown", async () => {
  const dir = await tempRoot();
  try {
    await writeFile(path.join(dir, FIXTURE_PATH), "null");
    const nullFixture = await validateNir1FinalRequestFixtures({
      repoRoot: dir,
    });
    assert.equal(nullFixture.status, "invalid");
    assert.ok(nullFixture.errors.length > 0);
    const bytes = Buffer.from(JSON.stringify(v2Fixture));
    await writeFile(path.join(dir, FIXTURE_PATH), bytes);
    await writeFile(path.join(dir, FREEZE_PATH), "null");
    const nullFreeze = await validateNir1FinalRequestFixtures({
      repoRoot: dir,
    });
    assert.equal(nullFreeze.status, "invalid");
    assert.ok(nullFreeze.errors.some((e) => e.includes("freeze record")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- repository report

async function tempRoot({ withV1 = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "nir1-final-request-"));
  await mkdir(path.join(dir, "src/prompts/ja"), { recursive: true });
  for (const file of [
    "chatSystemBase.txt",
    "chatSystemDataBoundaryReminder.txt",
  ]) {
    await cp(
      path.join(repoRoot, "src/prompts/ja", file),
      path.join(dir, "src/prompts/ja", file),
    );
  }
  await mkdir(path.join(dir, "evals/nir1-packing"), { recursive: true });
  // Version 1 stays placed as the HOLD history in every repository.
  if (withV1) {
    for (const file of [
      V1.fixturePath,
      V1.freezePath,
      V1.reviewPath,
      V1.readmePath,
      V1.parityVectorPath,
    ]) {
      await cp(path.join(repoRoot, file), path.join(dir, file));
    }
  }
  return dir;
}

test("the repository report treats a missing fixture as not-placed, not as an error", async () => {
  const dir = await tempRoot();
  try {
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(report.status, "not-placed");
    assert.deepEqual(report.errors, []);
    assert.equal(report.freeze.status, "not-placed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the repository report rejects a freeze or review record that has no fixture", async () => {
  const dir = await tempRoot();
  try {
    await writeFile(path.join(dir, FREEZE_PATH), "{}");
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(report.status, "not-placed");
    assert.ok(
      report.errors.some((e) => e.includes("freeze record exists without")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the repository report validates a placed fixture: pending-review, then frozen, then invalid after a change", async () => {
  const dir = await tempRoot();
  try {
    const bytes = Buffer.from(JSON.stringify(v2Fixture));
    await writeFile(path.join(dir, FIXTURE_PATH), bytes);
    const pending = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.deepEqual(pending.errors, []);
    assert.equal(pending.status, "pending-review");
    assert.deepEqual(
      pending.cases.map((c) => c.caseId),
      baseWorld.fixture.cases.map((c) => c.caseId),
    );

    // Scorer modules are bound by path, so the temp root needs them too.
    for (const file of SCORER_FILES) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await cp(path.join(repoRoot, file), path.join(dir, file));
    }
    const review = reviewRecord(bytes);
    const reviewBytes = Buffer.from(JSON.stringify(review));
    await writeFile(path.join(dir, REVIEW_PATH), reviewBytes);
    const { freeze, bytes: worldBytes } = freezeWorld();
    for (const file of [README_PATH, PARITY_VECTOR_PATH]) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), worldBytes.get(file));
    }
    freeze.fixture.sha256 = sha256(bytes);
    freeze.reviewRecord.sha256 = sha256(reviewBytes);
    freeze.scorer.files = await Promise.all(
      SCORER_FILES.map(async (file) => ({
        path: file,
        sha256: sha256(
          await import("node:fs/promises").then((fs) =>
            fs.readFile(path.join(dir, file)),
          ),
        ),
      })),
    );
    await writeFile(path.join(dir, FREEZE_PATH), JSON.stringify(freeze));
    const frozen = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.deepEqual(frozen.errors, []);
    assert.equal(frozen.status, "frozen");

    await writeFile(
      path.join(dir, FIXTURE_PATH),
      Buffer.concat([bytes, Buffer.from("\n")]),
    );
    const tampered = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(tampered.status, "invalid");
    assert.ok(
      tampered.errors.some(
        (e) => e.includes("sha256 for") && e.includes(FIXTURE_PATH),
      ),
    );
    assert.ok(
      tampered.errors.some((e) => e.includes("changed after the review")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real repository's final-request fixture state has no errors", async () => {
  const report = await validateNir1FinalRequestFixtures({ repoRoot });
  assert.deepEqual(report.errors, []);
  assert.ok(["not-placed", "pending-review", "frozen"].includes(report.status));
});

// ------------------------------------------- expected text templates (DPH-1b)

const QUALIFICATION_TEMPLATE =
  '{"approval":"human-approved","decisionId":"{{decisionId:rev-P-01-a}}","proposalId":"{{proposalId:rev-P-01-a}}","revisionId":"{{revisionId:rev-P-01-a}}","token":"{{revisionToken:scene-P-01}}"}';

function qualificationEntry(value) {
  return firstPositive(value).expected.codexEntries.find(
    (entry) => entry.logicalId === "rev-P-01-a.qualification",
  );
}

test("template: placeholders are a closed list of kinds and are listed in order", () => {
  assert.deepEqual(Object.keys(PLACEHOLDER_KINDS).sort(), [
    "decisionId",
    "proposalId",
    "revisionId",
    "revisionToken",
    "runtimeId",
    "sourceToken",
  ]);
  assert.deepEqual(
    templatePlaceholders(QUALIFICATION_TEMPLATE).map(
      (row) => `${row.kind}:${row.logicalId}`,
    ),
    [
      "decisionId:rev-P-01-a",
      "proposalId:rev-P-01-a",
      "revisionId:rev-P-01-a",
      "revisionToken:scene-P-01",
    ],
  );
  assert.deepEqual(templateErrors(QUALIFICATION_TEMPLATE, "t"), []);
});

test("template: an unknown kind, a stray brace pair and a foreign Revision are fixture errors", () => {
  assert.ok(
    templateErrors('{"a":"{{secret:x}}"}', "t").some((e) =>
      e.includes("unknown kind"),
    ),
  );
  assert.ok(
    templateErrors('{"a":"{{revisionId:}}"}', "t").some((e) =>
      e.includes('"{{"'),
    ),
  );
  assert.ok(
    templateErrors('{"a":"{{ revisionId:x }}"}', "t").some((e) =>
      e.includes('"{{"'),
    ),
  );
  // Valid JSON never holds "{{", but a nested object ends with "}}".
  assert.deepEqual(templateErrors('{"a":{"b":1}}', "t"), []);
  assert.ok(
    errorsOf((f) => {
      qualificationEntry(f).text = QUALIFICATION_TEMPLATE.replace(
        "{{revisionId:rev-P-01-a}}",
        "{{revisionId:rev-P-02-a}}",
      );
    }).some((e) => e.includes("names a Revision the request does not use")),
  );
  assert.ok(
    errorsOf((f) => {
      qualificationEntry(f).text = '{"a":"{{secret:x}}"}';
    }).some((e) => e.includes("unknown kind")),
  );
  assert.ok(
    errorsOf((f) => {
      firstPositive(f).expected.forbidden.texts.push('{"b":"{{nope:x}}"}');
    }).some((e) => e.includes("forbidden.texts[")),
  );
  assert.deepEqual(
    errorsOf((f) => {
      qualificationEntry(f).text = QUALIFICATION_TEMPLATE;
    }),
    [],
  );
});

test("template: the estimator counts each placeholder at its maximum ASCII length", () => {
  const uuid = "0".repeat(36);
  const token = "t".repeat(128);
  const literal = `{"approval":"human-approved","decisionId":"${uuid}","proposalId":"${uuid}","revisionId":"${uuid}","token":"${token}"}`;
  assert.equal(
    estimateTemplateTokens(QUALIFICATION_TEMPLATE),
    estimateTokens(literal),
  );
  // Text without a placeholder is estimated as before; CJK keeps its weight.
  assert.equal(
    estimateTemplateTokens("鐘が鳴った"),
    estimateTokens("鐘が鳴った"),
  );
  assert.equal(
    estimateTemplateTokens("鐘{{revisionId:x}}"),
    estimateTokens(`鐘${uuid}`),
  );
  // A resolved value is never longer than the estimate (36 / 128). 128 covers
  // the longest product token (a Relation source token, 84 characters at
  // version 1), so it is derived from the product, not from a fixture.
  assert.equal(PLACEHOLDER_KINDS.revisionId.maxLength, 36);
  assert.equal(PLACEHOLDER_KINDS.revisionToken.maxLength, 128);
  assert.equal(PLACEHOLDER_KINDS.sourceToken.maxLength, 128);
  const relationToken = `v1@2026-10-18T07:05:22.123456789+00:00:relation:${uuid}`;
  assert.equal(relationToken.length, 84);
  assert.ok(relationToken.length <= PLACEHOLDER_KINDS.sourceToken.maxLength);
});

test("template: the budget check and the freeze table use the template estimate", () => {
  const value = fixture();
  const request = firstPositive(value);
  const entry = qualificationEntry(value);
  const literalTokens = estimateTokens(entry.text);
  entry.text = QUALIFICATION_TEMPLATE;
  const templateTokens = estimateTemplateTokens(QUALIFICATION_TEMPLATE);
  assert.ok(templateTokens > literalTokens);
  // A budget that holds the literal selection but not the template's maximum.
  const selected = () =>
    estimateTokens(request.expected.rawText) +
    request.expected.codexEntries.reduce(
      (sum, row) => sum + estimateTemplateTokens(row.text),
      0,
    );
  request.expected.contextBudgetTokens = selected() - 1;
  assert.ok(
    validateFinalRequestFixture(value).some((e) =>
      e.includes("exceeds contextBudgetTokens"),
    ),
  );
  // The freeze record's selectedTokens is the same template formula.
  const world = freezeWorld();
  const row = world.freeze.contextBudget.perRequest[0];
  const fresh = fixture();
  qualificationEntry(fresh).text = QUALIFICATION_TEMPLATE;
  const check = (selectedTokens) => {
    const copy = structuredClone(world.freeze);
    copy.contextBudget.perRequest[0] = {
      ...row,
      selectedTokens,
      marginTokens: row.contextBudgetTokens - selectedTokens,
    };
    return validateFreezeRecord(copy, {
      bytes: world.bytes,
      review: world.review,
      fixture: fresh,
    }).filter((e) => e.includes("selectedTokens"));
  };
  assert.ok(check(row.selectedTokens).length > 0);
  assert.deepEqual(
    check(row.selectedTokens - literalTokens + templateTokens),
    [],
  );
});

test("template: a quote must be literal text, not part of a placeholder", () => {
  assert.ok(
    errorsOf((f) => {
      const request = firstPositive(f);
      qualificationEntry(f).text = QUALIFICATION_TEMPLATE;
      request.expected.exactQuotes.push({
        logicalId: "rev-P-01-a.qualification",
        quote: "{{proposalId:rev-P-01-a}}",
      });
    }).some((e) => e.includes("literal substring")),
  );
  assert.ok(
    errorsOf((f) => {
      const request = firstPositive(f);
      qualificationEntry(f).text = QUALIFICATION_TEMPLATE;
      request.expected.exactQuotes.push({
        logicalId: "rev-P-01-a.qualification",
        quote: '}}","revisionId":"{{',
      });
    }).some((e) => e.includes("literal substring")),
  );
  assert.deepEqual(
    errorsOf((f) => {
      const request = firstPositive(f);
      qualificationEntry(f).text = QUALIFICATION_TEMPLATE;
      request.expected.exactQuotes.push({
        logicalId: "rev-P-01-a.qualification",
        quote: '"approval":"human-approved"',
      });
    }),
    [],
  );
});

test("template: resolveTemplate leaves an unresolved placeholder as written and reports it", () => {
  const values = new Map([["revisionId:rev-P-01-a", "rt:rev-P-01-a"]]);
  const result = resolveTemplate(QUALIFICATION_TEMPLATE, (kind, logicalId) =>
    values.get(`${kind}:${logicalId}`),
  );
  assert.deepEqual(result.unresolved, [
    "{{decisionId:rev-P-01-a}}",
    "{{proposalId:rev-P-01-a}}",
    "{{revisionToken:scene-P-01}}",
  ]);
  assert.ok(result.text.includes('"revisionId":"rt:rev-P-01-a"'));
  assert.ok(result.text.includes("{{decisionId:rev-P-01-a}}"));
  assert.deepEqual(
    resolveTemplate("plain", () => "x"),
    {
      text: "plain",
      unresolved: [],
    },
  );
});

test("template: an entry names only the Revisions its own request passes (a stage cannot use another stage's id)", () => {
  // P-10: stage 1 passes rev-P-10-a/b, stage 2 passes rev-P-10-c/d.
  const p10 = (value) => value.cases.find((c) => c.caseId === "P-10");
  const positive = (value) =>
    p10(value).variants.find((v) => v.kind === "positive");
  const stage1Entry = (value) =>
    positive(value).requests[0].expected.codexEntries.at(-1);
  const stage2Entry = (value) =>
    positive(value).requests[1].expected.codexEntries.at(-1);
  const names = (value) => positive(value).requests.map((r) => r.revisionIds);
  const [first, second] = names(fixture());
  assert.ok(first.length > 0 && second.length > 0);
  assert.ok(
    errorsOf((f) => {
      stage1Entry(f).text = `{"decisionId":"{{decisionId:${second[0]}}}"}`;
    }).some((e) => e.includes("names a Revision the request does not use")),
  );
  assert.ok(
    errorsOf((f) => {
      stage2Entry(f).text = `{"proposalId":"{{proposalId:${first[0]}}}"}`;
    }).some((e) => e.includes("names a Revision the request does not use")),
  );
  // Its own stage's Revision is fine, and a stage-2 forbidden text may name a
  // stage-1 Revision (it forbids the old value).
  assert.deepEqual(
    errorsOf((f) => {
      stage1Entry(f).text = `{"decisionId":"{{decisionId:${first[0]}}}"}`;
      positive(f).requests[1].expected.forbidden.texts.push(
        `{"proposalId":"{{proposalId:${first[0]}}}"}`,
      );
    }).filter((e) => e.includes("does not use")),
    [],
  );
});

test("template: a resolved value may hold a space (the legacy SQLite updated_at in a Source token)", () => {
  assert.ok(PLACEHOLDER_VALUE_PATTERN.test("v3@2026-10-18 07:05:22"));
  assert.ok(!PLACEHOLDER_VALUE_PATTERN.test("a\nb"));
  assert.ok(!PLACEHOLDER_VALUE_PATTERN.test('a"b'));
  assert.ok(!PLACEHOLDER_VALUE_PATTERN.test("a\\b"));
});

// ------------------------------------------------ fixture versions (DPH-S0)

const v1FreezeRecord = () => structuredClone(replacedRecords.freeze);

/** The real version-1 bytes, as the repository report reads them. */
async function v1Bytes() {
  const bytes = new Map();
  for (const file of [
    V1.fixturePath,
    V1.reviewPath,
    V1.readmePath,
    V1.parityVectorPath,
  ])
    bytes.set(file, await readFile(path.join(repoRoot, file)));
  return bytes;
}

test("versions: each version owns its paths; version 1 is superseded by the evidence version 2", () => {
  assert.equal(EVIDENCE_FIXTURE_VERSION, 2);
  assert.equal(V1.supersededBy, 2);
  assert.equal(V2.replaces, 1);
  assert.equal(fixtureVersionSpec(3), undefined);
  assert.equal(fixtureVersionSpec("constructor"), undefined);
  for (const key of ["fixturePath", "freezePath", "reviewPath", "readmePath"])
    assert.notEqual(V1[key], V2[key], key);
  assert.ok(V2.requiredImplementers.length > 0);
});

test("versions: a fixture read from one version's path must name that version", () => {
  assert.deepEqual(
    validateFinalRequestFixture(v2Fixture, { template, fixtureVersion: 2 }),
    [],
  );
  assert.ok(
    validateFinalRequestFixture(v2Fixture, {
      template,
      fixtureVersion: 1,
    }).some((e) => e.includes("fixture.fixtureVersion must be 1")),
  );
  assert.ok(
    validateFinalRequestFixture(baseWorld.fixture, {
      template,
      fixtureVersion: 2,
    }).some((e) => e.includes("fixture.fixtureVersion must be 2")),
  );
});

test("superseded version: the version-1 record stays a HOLD record and can never be frozen", async () => {
  const bytes = await v1Bytes();
  const fixtureV1 = replacedRecords.fixture;
  const review = JSON.parse(bytes.get(V1.reviewPath));
  const options = { bytes, review, fixture: fixtureV1, fixtureVersion: 1 };
  // As placed: valid (its scorer rows are history, not today's bytes).
  assert.deepEqual(
    validateFreezeRecordOfVersion(v1FreezeRecord(), options),
    [],
  );
  // Frozen, even with every other frozen condition claimed, is refused.
  const frozen = v1FreezeRecord();
  frozen.status = "frozen";
  frozen.reviewVerdict = APPROVING_VERDICT;
  frozen.nativeOutputObservedBeforeFreeze = false;
  delete frozen.nativeObservations;
  const frozenErrors = validateFreezeRecordOfVersion(frozen, options);
  assert.ok(
    frozenErrors.some((e) => e.includes("is superseded by version 2")),
    frozenErrors.join(" | "),
  );
  // Erasing the observation is refused too.
  const erased = v1FreezeRecord();
  erased.nativeOutputObservedBeforeFreeze = false;
  delete erased.nativeObservations;
  assert.ok(
    validateFreezeRecordOfVersion(erased, options).some((e) =>
      e.includes("must keep nativeOutputObservedBeforeFreeze true"),
    ),
  );
  // Its fixture, review, README and parity vector stay bound to today's bytes.
  for (const file of bytes.keys()) {
    const changed = new Map(bytes);
    changed.set(file, Buffer.from("changed history"));
    assert.ok(
      validateFreezeRecordOfVersion(v1FreezeRecord(), {
        ...options,
        bytes: changed,
      }).some((e) => e.includes(`sha256 for ${file} differs`)),
      file,
    );
  }
  // Its scorer rows are still checked for shape.
  const badRow = v1FreezeRecord();
  badRow.scorer.files[0].sha256 = "not-a-digest";
  assert.ok(
    validateFreezeRecordOfVersion(badRow, options).some((e) =>
      e.includes("freeze.scorer.files[0]"),
    ),
  );
});

test("versions: a record of one version cannot stand for another", () => {
  // The version-1 record read as the version-2 record.
  assert.ok(
    validateFreezeRecordOfVersion(v1FreezeRecord(), {
      fixtureVersion: 2,
      fixture: v2Fixture,
      replaced: replacedRecords,
    }).some((e) => e.includes("freeze.fixtureVersion must be 2")),
  );
  // A version-2 record that binds the version-1 fixture or review.
  for (const [key, file] of [
    ["fixture", V1.fixturePath],
    ["reviewRecord", V1.reviewPath],
    ["readme", V1.readmePath],
  ]) {
    const { freeze, bytes, review } = freezeWorld();
    freeze[key] = { path: file, sha256: "0".repeat(64) };
    assert.ok(
      validateFreezeRecord(freeze, { bytes, review }).some((e) =>
        e.includes(`freeze.${key}.path must be`),
      ),
      key,
    );
  }
  // A version-2 record that says version 1, read from the version-2 path.
  const { freeze, bytes, review } = freezeWorld();
  freeze.fixtureVersion = 1;
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review, fixtureVersion: 2 }).some(
      (e) => e.includes("freeze.fixtureVersion must be 2"),
    ),
  );
  // An unregistered version is refused.
  assert.ok(
    validateFreezeRecordOfVersion({ ...freeze, fixtureVersion: 7 }, {}).some(
      (e) => e.includes("registered version"),
    ),
  );
});

test("replacement: the record names and binds the version it replaces", () => {
  const { freeze, bytes, review } = freezeWorld();
  assert.deepEqual(validateFreezeRecord(freeze, { bytes, review }), []);
  for (const [mutate, expected] of [
    [(f) => delete f.supersedes, "freeze.supersedes must name"],
    [
      (f) => (f.supersedes.fixtureVersion = 2),
      "supersedes.fixtureVersion must be 1",
    ],
    [
      (f) => (f.supersedes.decision = "DR-DPH-1"),
      "supersedes.decision must be",
    ],
    [
      (f) => (f.supersedes.fixture.path = V2.fixturePath),
      "freeze.supersedes.fixture.path must be",
    ],
    [
      (f) => (f.supersedes.freezeRecord.sha256 = "0".repeat(64)),
      `sha256 for ${V1.freezePath} differs`,
    ],
  ]) {
    const world = freezeWorld();
    mutate(world.freeze);
    const errors = validateFreezeRecord(world.freeze, {
      bytes: world.bytes,
      review: world.review,
    });
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
  }
  // The replaced version's bytes must be present, and a changed version-1
  // fixture breaks the replacement's binding.
  const missing = freezeWorld();
  missing.bytes.delete(V1.fixturePath);
  assert.ok(
    validateFreezeRecord(missing.freeze, {
      bytes: missing.bytes,
      review: missing.review,
    }).some((e) =>
      e.includes(`freeze binds ${V1.fixturePath}, which is missing`),
    ),
  );
  const changed = freezeWorld();
  changed.bytes.set(V1.fixturePath, Buffer.from("rewritten history"));
  assert.ok(
    validateFreezeRecord(changed.freeze, {
      bytes: changed.bytes,
      review: changed.review,
    }).some((e) => e.includes(`sha256 for ${V1.fixturePath} differs`)),
  );
  // Without the replaced version's records the check fails closed.
  const errors = validateFreezeRecord(freeze, {
    bytes,
    review,
    replaced: undefined,
  });
  assert.ok(
    errors.some((e) => e.includes("of the replaced version 1 is required")),
  );
  assert.ok(
    validateFreezeRecord(freeze, { bytes, review, fixture: undefined }).some(
      (e) => e.includes("the fixture of version 2 is required"),
    ),
  );
});

test("replacement: no material of the replaced version may be reused", () => {
  const v1 = replacedRecords.fixture;
  const old = fixtureMaterials(v1);
  assert.ok(old.ids.has("p01-rev-voice"));
  assert.ok(old.ids.has("dph-ws-p01"));
  assert.ok(old.texts.has(v1.cases[0].userMessage));
  assert.deepEqual(replacedMaterialReuseErrors(v2Fixture, v1), []);
  const firstScene = v1.cases[0].setup.scenes[0];
  const firstEntity = v1.cases[0].setup.codexEntities[0];
  for (const [mutate, expected] of [
    [
      (f) =>
        (f.cases[0].variants[0].requests[0].revisionIds[0] = "p01-rev-voice"),
      "logical id p01-rev-voice",
    ],
    [
      (f) => (f.cases[1].isolation.workspaceId = "dph-ws-p01"),
      "logical id dph-ws-p01",
    ],
    [
      (f) => (f.cases[0].userMessage = v1.cases[0].userMessage),
      "reuses the material",
    ],
    [
      (f) => (f.cases[0].markers = [v1.cases[0].markers[0]]),
      "reuses the material",
    ],
    [(f) => (f.canaries[0].text = v1.canaries[0].text), "reuses the material"],
    [
      (f) => {
        const request = f.cases[0].variants[0].requests[0];
        request.expected.rawText = `${firstScene.body} 新しい一文。`;
      },
      "reuses the material",
    ],
    [
      (f) => {
        const request = f.cases[0].variants[0].requests[0];
        request.expected.exactQuotes[0].quote = firstEntity.summary;
      },
      "reuses the material",
    ],
  ]) {
    const value = structuredClone(v2Fixture);
    mutate(value);
    const errors = replacedMaterialReuseErrors(value, v1);
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
    // The freeze record of the replacement refuses it as well.
    const { freeze, bytes, review } = freezeWorld();
    assert.ok(
      validateFreezeRecord(freeze, { bytes, review, fixture: value }).some(
        (e) => e.includes(expected),
      ),
      expected,
    );
  }
});

test("replacement: the author separation holds across the versions", () => {
  const previous = replacedRecords.freeze.authorSeparation;
  const v1Author = previous.fixtureAuthor.agent;
  const v1Implementer = previous.harnessImplementers.at(-1);
  for (const [mutate, expected] of [
    [
      (s) => (s.fixtureAuthor.agent = v1Author),
      "fixture author must be neither the author nor an implementer of the replaced version 1",
    ],
    [
      (s) => (s.expectationReviewer.agent = v1Author),
      "expectation reviewer must be neither the author nor an implementer of the replaced version 1",
    ],
    [
      (s) => {
        // Dropping a version-1 implementer does not make them an eligible author.
        s.harnessImplementers = s.harnessImplementers.filter(
          (name) => name !== v1Implementer,
        );
        s.fixtureAuthor.agent = v1Implementer;
      },
      `must keep ${v1Implementer}`,
    ],
    [
      (s) => {
        s.harnessImplementers = s.harnessImplementers.filter(
          (name) => name !== v1Implementer,
        );
        s.fixtureAuthor.agent = v1Implementer;
      },
      "fixture author must be neither the author nor an implementer",
    ],
    [
      (s) => {
        s.harnessImplementers = s.harnessImplementers.filter(
          (name) => !V2.requiredImplementers.includes(name),
        );
      },
      `must list ${V2.requiredImplementers[0]}`,
    ],
    [
      (s) => (s.fixtureAuthor.agent = V2.requiredImplementers[0]),
      "the fixture author must not be a harness implementer",
    ],
  ]) {
    const { freeze, bytes, review } = freezeWorld();
    mutate(freeze.authorSeparation);
    const errors = validateFreezeRecord(freeze, { bytes, review });
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
  }
  // Without the replaced record the separation cannot be checked: an error.
  const { freeze, bytes, review } = freezeWorld();
  assert.ok(
    validateFreezeRecord(freeze, {
      bytes,
      review,
      replaced: { fixture: replacedRecords.fixture },
    }).some((e) => e.includes("is required to check the author separation")),
  );
});

test("frozen-snapshot: the superseded version is refused before git, and an unregistered version is an error", () => {
  let called = false;
  const execFile = () => {
    called = true;
    throw new Error("git must not run");
  };
  const v1 = verifyFrozenSnapshotOfVersion({
    repoRoot: "/repo",
    runCommit: "a".repeat(40),
    fixtureVersion: 1,
    execFile,
  });
  assert.ok(v1.errors.some((e) => e.includes("superseded by version 2")));
  assert.equal(v1.freezeCommit, undefined);
  const unknown = verifyFrozenSnapshotOfVersion({
    repoRoot: "/repo",
    runCommit: "a".repeat(40),
    execFile,
  });
  assert.ok(unknown.errors.some((e) => e.includes("is not registered")));
  assert.ok(
    deriveFreezeCommitOfVersion({
      repoRoot: "/repo",
      runCommit: "a".repeat(40),
      fixtureVersion: 9,
      execFile,
    }).error.includes("is not registered"),
  );
  assert.equal(called, false);
});

test("frozen-snapshot: version 2 is gated by its own record, and the version-1 history is bound at the freeze", async () => {
  // A frozen record written at the version-1 path does not gate version 2.
  {
    const dir = await mkdtemp(path.join(tmpdir(), "nir1-snapshot-mixup-"));
    try {
      git(dir, "init", "-q");
      const { freeze, bytes } = freezeWorld();
      for (const [file, content] of bytes)
        await writeRepoFile(dir, file, content);
      await writeRepoFile(dir, V1.freezePath, JSON.stringify(freeze));
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "a v2 record under the v1 path");
      const head = git(dir, "rev-parse", "HEAD");
      const result = verifyFrozenSnapshot({ repoRoot: dir, runCommit: head });
      assert.ok(
        result.errors.some((e) => e.includes(`holds ${V2.freezePath}`)),
        result.errors.join(" | "),
      );
      assert.ok(
        verifyFrozenSnapshotOfVersion({
          repoRoot: dir,
          runCommit: head,
          fixtureVersion: 1,
        }).errors.some((e) => e.includes("superseded")),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // Rewriting the version-1 fixture after the version-2 freeze is detected.
  const { dir } = await frozenRepo();
  try {
    await writeRepoFile(dir, V1.fixturePath, "rewritten history");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "rewrite v1");
    const result = verifyFrozenSnapshot({
      repoRoot: dir,
      runCommit: git(dir, "rev-parse", "HEAD"),
    });
    assert.ok(
      result.errors.some(
        (e) =>
          e.includes(V1.fixturePath) &&
          e.includes("differs from the frozen bytes"),
      ),
      result.errors.join(" | "),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen-snapshot: a frozen version-2 record that reuses version-1 material is refused at the freeze commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nir1-snapshot-reuse-"));
  try {
    git(dir, "init", "-q");
    const { freeze, bytes } = freezeWorld();
    const reused = structuredClone(v2Fixture);
    reused.cases[0].userMessage = replacedRecords.fixture.cases[0].userMessage;
    const reusedBytes = Buffer.from(JSON.stringify(reused));
    const review = reviewRecord(reusedBytes);
    const reviewBytes = Buffer.from(JSON.stringify(review));
    bytes.set(FIXTURE_PATH, reusedBytes);
    bytes.set(REVIEW_PATH, reviewBytes);
    freeze.fixture.sha256 = sha256(reusedBytes);
    freeze.reviewRecord.sha256 = sha256(reviewBytes);
    for (const [file, content] of bytes)
      await writeRepoFile(dir, file, content);
    await writeRepoFile(dir, FREEZE_PATH, JSON.stringify(freeze));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "freeze");
    const head = git(dir, "rev-parse", "HEAD");
    const result = verifyFrozenSnapshot({ repoRoot: dir, runCommit: head });
    assert.equal(result.freezeCommit, head);
    assert.ok(
      result.errors.some((e) => e.includes("reuses the material")),
      result.errors.join(" | "),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the repository report keeps checking the version-1 history while version 2 is not placed", async () => {
  const dir = await tempRoot();
  try {
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.deepEqual(report.errors, []);
    assert.equal(report.fixtureVersion, 2);
    assert.equal(report.status, "not-placed");
    const v1 = report.versions.find((entry) => entry.fixtureVersion === 1);
    assert.equal(v1.status, "pending-review");
    assert.equal(v1.supersededBy, 2);
    // A version-1 record turned frozen is invalid, and so is the whole report.
    const frozen = v1FreezeRecord();
    frozen.status = "frozen";
    await writeFile(path.join(dir, V1.freezePath), JSON.stringify(frozen));
    const refused = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(refused.status, "invalid");
    assert.ok(
      refused.errors.some((e) => e.startsWith("nir1-final-request v1 freeze:")),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  // The version-1 history may not be removed.
  const bare = await tempRoot({ withV1: false });
  try {
    const report = await validateNir1FinalRequestFixtures({ repoRoot: bare });
    assert.equal(report.status, "invalid");
    assert.ok(
      report.errors.some((e) => e.includes("stays placed as the HOLD history")),
    );
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});

test("the repository report refuses a version-2 fixture that names version 1", async () => {
  const dir = await tempRoot();
  try {
    await writeFile(
      path.join(dir, FIXTURE_PATH),
      JSON.stringify(baseWorld.fixture),
    );
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(report.status, "invalid");
    assert.ok(
      report.errors.some((e) =>
        e.includes(
          "nir1-final-request v2 fixture: fixture.fixtureVersion must be 2",
        ),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------- pinned version-1 history (review fix, P1/P2)

test("pinned history: the version-1 record and a replacement's supersedes cannot be rewritten together", () => {
  // The reviewer's probe: rename the version-1 author, drop an implementer,
  // and move the replacement's supersedes sha256 with the rewritten record.
  const rewritten = v1FreezeRecord();
  rewritten.authorSeparation.fixtureAuthor.agent = "someone else";
  rewritten.authorSeparation.harnessImplementers =
    rewritten.authorSeparation.harnessImplementers.filter(
      (name) => !name.startsWith("dph-4-builder"),
    );
  const rewrittenBytes = Buffer.from(JSON.stringify(rewritten, null, 2));
  const { freeze, bytes, review } = freezeWorld();
  bytes.set(V1.freezePath, rewrittenBytes);
  freeze.supersedes.freezeRecord.sha256 = sha256(rewrittenBytes);
  freeze.authorSeparation.fixtureAuthor.agent =
    replacedRecords.freeze.authorSeparation.fixtureAuthor.agent;
  freeze.authorSeparation.harnessImplementers =
    rewritten.authorSeparation.harnessImplementers.concat(
      V2.requiredImplementers,
    );
  const errors = validateFreezeRecord(freeze, {
    bytes,
    review,
    replaced: { fixture: replacedRecords.fixture, freeze: rewritten },
  });
  assert.ok(
    errors.some((e) =>
      e.includes("freeze.supersedes.freezeRecord.sha256 must be the pinned"),
    ),
    errors.join(" | "),
  );
  // The same for the fixture, and for the recorded commit of the record.
  const fixtureMoved = freezeWorld();
  fixtureMoved.freeze.supersedes.fixture.sha256 = "1".repeat(64);
  fixtureMoved.bytes.set(V1.fixturePath, Buffer.from("x"));
  assert.ok(
    validateFreezeRecord(fixtureMoved.freeze, {
      bytes: fixtureMoved.bytes,
      review: fixtureMoved.review,
    }).some((e) => e.includes("supersedes.fixture.sha256 must be the pinned")),
  );
  const commitMoved = freezeWorld();
  commitMoved.freeze.supersedes.freezeRecordCommit = "c".repeat(40);
  assert.ok(
    validateFreezeRecord(commitMoved.freeze, {
      bytes: commitMoved.bytes,
      review: commitMoved.review,
    }).some((e) => e.includes("supersedes.freezeRecordCommit must be")),
  );
});

test("pinned history: the version-1 record's own bindings stay the pinned values", async () => {
  const bytes = await v1Bytes();
  const review = JSON.parse(bytes.get(V1.reviewPath));
  const changedFixture = Buffer.from("rewritten v1 fixture");
  const rebound = v1FreezeRecord();
  rebound.fixture.sha256 = sha256(changedFixture);
  bytes.set(V1.fixturePath, changedFixture);
  const errors = validateFreezeRecordOfVersion(rebound, {
    bytes,
    review,
    fixtureVersion: 1,
  });
  assert.ok(
    errors.some((e) =>
      e.includes(
        "freeze.fixture.sha256 of the superseded version 1 must stay the pinned",
      ),
    ),
    errors.join(" | "),
  );
});

test("pinned history: rewriting the version-1 fixture, review and record consistently is refused by the report", async () => {
  const dir = await tempRoot();
  try {
    const fixtureV1 = structuredClone(replacedRecords.fixture);
    fixtureV1.cases[0].setup.scenes[0].body = "書き換えた本文。";
    const fixtureBytesV1 = Buffer.from(JSON.stringify(fixtureV1, null, 2));
    const reviewV1 = JSON.parse(
      await readFile(path.join(repoRoot, V1.reviewPath)),
    );
    reviewV1.fixtureSha256 = sha256(fixtureBytesV1);
    const reviewBytesV1 = Buffer.from(JSON.stringify(reviewV1, null, 2));
    const freezeV1 = v1FreezeRecord();
    freezeV1.fixture.sha256 = sha256(fixtureBytesV1);
    freezeV1.reviewRecord.sha256 = sha256(reviewBytesV1);
    await writeFile(path.join(dir, V1.fixturePath), fixtureBytesV1);
    await writeFile(path.join(dir, V1.reviewPath), reviewBytesV1);
    await writeFile(path.join(dir, V1.freezePath), JSON.stringify(freezeV1));
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(report.status, "invalid");
    for (const file of [V1.fixturePath, V1.reviewPath, V1.freezePath]) {
      assert.ok(
        report.errors.some(
          (e) =>
            e.includes(file) && e.includes("differs from its pinned sha256"),
        ),
        file,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frozen-snapshot: a fixture under the version-2 path that names version 1 is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nir1-snapshot-version-"));
  try {
    git(dir, "init", "-q");
    const { freeze, bytes } = freezeWorld();
    const named = Buffer.from(JSON.stringify(baseWorld.fixture));
    const review = reviewRecord(named);
    const reviewBytes = Buffer.from(JSON.stringify(review));
    bytes.set(FIXTURE_PATH, named);
    bytes.set(REVIEW_PATH, reviewBytes);
    freeze.fixture.sha256 = sha256(named);
    freeze.reviewRecord.sha256 = sha256(reviewBytes);
    for (const [file, content] of bytes)
      await writeRepoFile(dir, file, content);
    await writeRepoFile(dir, FREEZE_PATH, JSON.stringify(freeze));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "freeze");
    const head = git(dir, "rev-parse", "HEAD");
    const result = verifyFrozenSnapshot({ repoRoot: dir, runCommit: head });
    assert.ok(
      result.errors.some((e) => e.includes("names fixtureVersion 1, not 2")),
      result.errors.join(" | "),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the repository report checks a placed version-2 fixture for reused material before any freeze record", async () => {
  const dir = await tempRoot();
  try {
    const reused = structuredClone(v2Fixture);
    reused.cases[0].userMessage = replacedRecords.fixture.cases[0].userMessage;
    await writeFile(path.join(dir, FIXTURE_PATH), JSON.stringify(reused));
    const report = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.equal(report.status, "invalid");
    assert.ok(
      report.errors.some(
        (e) =>
          e.startsWith("nir1-final-request v2 fixture:") &&
          e.includes("reuses the material"),
      ),
      report.errors.join(" | "),
    );
    // Without reuse the placed fixture is pending review.
    await writeFile(path.join(dir, FIXTURE_PATH), JSON.stringify(v2Fixture));
    const clean = await validateNir1FinalRequestFixtures({ repoRoot: dir });
    assert.deepEqual(clean.errors, []);
    assert.equal(clean.status, "pending-review");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------- negative-anchor Scene and unknown Scope (DPH-S0c)

const NEG = "syn-p02-negative-anchor";

/**
 * The synthetic fixture with a P-02 setup whose reject variant prepares its
 * negative on its own negative-anchor Scene and invalidates it by turning that
 * Scene's Scope unknown (DR-DPH-99).
 */
function unknownScopeFixture(version = 2) {
  const value = structuredClone(v2Fixture);
  value.fixtureVersion = version;
  const testCase = value.cases.find((row) => row.caseId === "P-02");
  testCase.setup = {
    project: { logicalId: "syn-p02-project" },
    scenes: [
      {
        logicalId: "syn-p02-anchor",
        role: "anchor",
        title: "合成の起点",
        body: "合成の起点の本文。",
      },
      {
        logicalId: "syn-p02-query",
        role: "query",
        title: "合成の問い",
        body: "合成の問いの本文。",
      },
    ],
    codexEntities: [],
  };
  const reject = testCase.variants.find((row) => row.kind === "reject");
  const positive = testCase.variants.find((row) => row.kind === "positive");
  const bad = reject.ineligibleLogicalId;
  const positiveSteps = ["rev-P-02-a", "rev-P-02-b"].flatMap((revision) => [
    {
      stage: 1,
      op: "prepare",
      revision,
      entity: `${revision}-entity`,
      anchorScene: "syn-p02-anchor",
      proposalKey: `key:${revision}`,
    },
    { stage: 1, op: "approve", revision, decision: "approved" },
  ]);
  positive.setup = { steps: structuredClone(positiveSteps), chatSessions: [] };
  reject.setup = {
    scenes: [
      {
        logicalId: NEG,
        role: "negative-anchor",
        title: "合成の負例の場面",
        body: "合成の負例専用の本文。",
      },
    ],
    steps: [
      {
        stage: 1,
        op: "prepare-negative",
        revision: bad,
        entity: `${bad}-entity`,
        anchorScene: NEG,
        proposalKey: `key:${bad}`,
      },
      { stage: 1, op: "approve-negative", revision: bad, decision: "approved" },
      {
        stage: 1,
        op: "invalidate-negative",
        revision: bad,
        write: "scene-scope-unknown",
        scene: NEG,
        unresolvedReason: "合成の負例の Scope は未確定",
      },
      ...structuredClone(positiveSteps),
    ],
    chatSessions: [],
  };
  return { value, testCase, reject, positive };
}

const setupErrors = (value) =>
  validateFinalRequestFixture(value, {
    template,
    fixtureVersion: value.fixtureVersion,
  });

test("setup shapes: a reject variant may anchor its negative on its own Scene and turn its Scope unknown (version 2)", () => {
  assert.deepEqual(setupErrors(unknownScopeFixture().value), []);
  // The other writes stay allowed, on the case's anchor as before.
  const { value, reject } = unknownScopeFixture();
  delete reject.setup.scenes;
  reject.setup.steps[0].anchorScene = "syn-p02-anchor";
  Object.assign(reject.setup.steps[2], { write: "codex-update" });
  delete reject.setup.steps[2].scene;
  delete reject.setup.steps[2].unresolvedReason;
  assert.deepEqual(setupErrors(value), []);
});

test("setup shapes: version 1 may not use the negative-anchor Scene or the unknown write", () => {
  const { value } = unknownScopeFixture(1);
  const errors = setupErrors(value);
  assert.ok(
    errors.some((e) =>
      e.includes(
        ".scenes (a negative-anchor Scene) is not allowed in fixture version 1",
      ),
    ),
    errors.join(" | "),
  );
  assert.ok(
    errors.some((e) =>
      e.includes("scene-scope-unknown is not allowed in fixture version 1"),
    ),
    errors.join(" | "),
  );
});

test("setup shapes: malformed or misplaced negative-anchor Scenes and unknown writes are fixture errors", () => {
  for (const [mutate, expected] of [
    [
      ({ reject }) =>
        reject.setup.scenes.push({
          ...reject.setup.scenes[0],
          logicalId: "syn-extra",
        }),
      "at most one Scene",
    ],
    [
      ({ positive, reject }) =>
        (positive.setup.scenes = structuredClone(reject.setup.scenes)),
      "only a reject variant may declare",
    ],
    [({ reject }) => delete reject.setup.scenes[0].body, "must be { logicalId"],
    [
      ({ reject }) => (reject.setup.scenes[0].role = "anchor"),
      "must be { logicalId",
    ],
    [
      ({ reject }) => (reject.setup.scenes[0].extra = true),
      "must be { logicalId",
    ],
    [
      ({ reject }) => (reject.setup.scenes[0].logicalId = "syn-p02-query"),
      "is a Scene of the case",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].scene = "syn-p02-anchor"),
      "may not target the case's anchor Scene",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].scene = "syn-p02-query"),
      "may not target the case's query Scene",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].scene = "syn-elsewhere"),
      "must name the variant's negative-anchor Scene",
    ],
    [
      ({ reject }) => (reject.setup.steps[0].anchorScene = "syn-p02-anchor"),
      "must be the anchorScene of the prepare-negative step",
    ],
    [
      ({ reject }) => (reject.setup.steps[0].anchorScene = "syn-p02-anchor"),
      "is not the anchorScene of the variant's prepare-negative step",
    ],
    [
      ({ reject }) => (reject.setup.steps[0].anchorScene = "syn-undeclared"),
      "is neither the case's anchor nor a negative-anchor Scene",
    ],
    [
      ({ reject }) => delete reject.setup.steps[2].unresolvedReason,
      "unresolvedReason must be a trimmed non-empty string",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].unresolvedReason = " 前後に空白 "),
      "unresolvedReason must be a trimmed non-empty string",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].op = "binding-change"),
      "is an invalidate-negative write only",
    ],
    [
      ({ reject }) => (reject.setup.steps[2].write = "scene-delete"),
      "write must be one of",
    ],
    [
      ({ reject }) => (reject.setup.steps[3].anchorScene = NEG),
      "a positive Revision may not anchor the negative-anchor Scene",
    ],
  ]) {
    const world = unknownScopeFixture();
    mutate(world);
    const errors = setupErrors(world.value);
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join(" | ")}`,
    );
  }
});

test("setup shapes: the placed version-1 fixture is unchanged by the setup checks", async () => {
  const v1 = JSON.parse(
    await readFile(path.join(repoRoot, V1.fixturePath), "utf8"),
  );
  assert.deepEqual(
    validateFinalRequestFixture(v1, { template, fixtureVersion: 1 }),
    [],
  );
});

test("setup shapes: the negative-anchor Scene and the unknown reason are materials of the fixture", () => {
  const { value } = unknownScopeFixture();
  const materials = fixtureMaterials(value);
  assert.ok(materials.ids.has(NEG));
  assert.ok(materials.texts.has("合成の負例専用の本文。"));
  assert.ok(materials.texts.has("合成の負例の Scope は未確定"));
});
