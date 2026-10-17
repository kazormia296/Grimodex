import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  APPROVING_VERDICT,
  FIXTURE_PATH,
  FREEZE_PATH,
  FREEZE_SCHEMA_VERSION,
  PARITY_VECTOR_PATH,
  README_PATH,
  REVIEW_PATH,
  REVIEW_SCHEMA_VERSION,
  PLACEHOLDER_KINDS,
  SCORER_FILES,
  deriveFreezeCommit,
  estimateTemplateTokens,
  resolveTemplate,
  templateErrors,
  templatePlaceholders,
  isAncestorCommit,
  sha256,
  validateFinalRequestFixture,
  validateFreezeRecord,
  validateNir1FinalRequestFixtures,
  validateReviewRecord,
  verifyFreezeOrder,
  verifyFrozenSnapshot,
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
        f.fixtureVersion = 2;
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

const fixtureBytes = Buffer.from(JSON.stringify(baseWorld.fixture));

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
  const parityBytes = Buffer.from('{"parity":"vector"}');
  const bytes = new Map([
    [FIXTURE_PATH, fixtureBytes],
    [REVIEW_PATH, reviewBytes],
    [README_PATH, readmeBytes],
    [PARITY_VECTOR_PATH, parityBytes],
    ...scorerBytes,
  ]);
  const freeze = {
    schemaVersion: FREEZE_SCHEMA_VERSION,
    contractId: CONTRACT_ID,
    draftRef: DRAFT_REF,
    fixtureVersion: 1,
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
      harnessImplementers: ["impl-1", "impl-3", "impl-4"],
      nativeReceiptProvidedToAuthor: false,
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
        f.fixtureVersion = 2;
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
    const bytes = Buffer.from(JSON.stringify(baseWorld.fixture));
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

async function tempRoot() {
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
    const bytes = Buffer.from(JSON.stringify(baseWorld.fixture));
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
    }).some((e) => e.includes("names a Revision the variant does not use")),
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
  const token = "t".repeat(80);
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
  // A resolved value is never longer than the estimate (36 / 80).
  assert.equal(PLACEHOLDER_KINDS.revisionId.maxLength, 36);
  assert.equal(PLACEHOLDER_KINDS.revisionToken.maxLength, 80);
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
