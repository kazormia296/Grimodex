import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { validateExecutionStateAuthority } from "./validate-execution-state-authority.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function validateFailurePolicySchema(policy) {
  const schema = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "policies/narrative/schemas/narrative-failure-policy.schema.json",
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  return { valid: validate(policy), errors: validate.errors ?? [] };
}

function baseExecutionState(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "narrative-execution-state",
    entities: {
      run: {
        statuses: [
          "pending",
          "running",
          "completed",
          "failed",
          "cancelled",
          "superseded",
        ],
        terminalStatuses: ["completed", "failed", "cancelled", "superseded"],
        derivedView: {
          pending: { phase: "queued", outcome: null },
          running: { phase: "running", outcome: null },
          completed: { phase: "terminal", outcome: "succeeded" },
          failed: { phase: "terminal", outcome: "failed" },
          cancelled: { phase: "terminal", outcome: "cancelled" },
          superseded: { phase: "terminal", outcome: "superseded" },
        },
      },
      task: {
        statuses: ["queued", "running", "completed", "failed", "cancelled"],
        terminalStatuses: ["completed", "failed", "cancelled"],
        derivedView: {
          queued: { phase: "queued", outcome: null },
          running: { phase: "running", outcome: null },
          completed: { phase: "terminal", outcome: "succeeded" },
          failed: { phase: "terminal", outcome: "failed" },
          cancelled: { phase: "terminal", outcome: "cancelled" },
        },
      },
      attempt: {
        statuses: ["running", "completed", "failed"],
        terminalStatuses: ["completed", "failed"],
        derivedView: {
          running: { phase: "running", outcome: null },
          completed: { phase: "terminal", outcome: "succeeded" },
          failed: { phase: "terminal", outcome: "failed" },
        },
      },
    },
    runSupersedeCascade: {
      task: { fromStatuses: ["queued", "running"], toStatus: "cancelled" },
      attempt: {
        fromStatuses: ["running"],
        toStatus: "failed",
        failureCode: "NEX_RUN_SUPERSEDED",
        retryDisposition: "superseded",
      },
    },
    crossEntityInvariant: "each entity owns its own vocabulary",
    ...overrides,
  };
}

function baseFailurePolicy(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "narrative-failure-policy",
    failureCodePrefix: "NEX_",
    retryDispositions: ["retryable", "terminal", "superseded", "manual"],
    nextAttemptInvariant:
      "next_attempt_at is set if and only if retryDisposition is retryable",
    findingRoutingMatrix: c25bFindingRoutingMatrix(),
    policies: [
      {
        failureCode: "NEX_RUN_SUPERSEDED",
        retryDisposition: "superseded",
        maxAttempts: 0,
        backoffPolicy: "none",
        nextAttemptPolicy: "none",
        policyVersion: "v1",
      },
      {
        failureCode: "NEX_CURSOR_RESERVATION_CONFLICT",
        retryDisposition: "retryable",
        maxAttempts: 5,
        backoffPolicy: "exponential-jitter",
        nextAttemptPolicy: "requeue-after-lease-expiry",
        policyVersion: "v1",
      },
      ...c25bFailurePolicies(),
    ],
    ...overrides,
  };
}

function c25bFailurePolicies() {
  return [
    {
      failureCode: "NEX_MAINTENANCE_TRANSIENT",
      retryDisposition: "retryable",
      maxAttempts: 3,
      backoffPolicy: "exponential-bounded",
      nextAttemptPolicy: "requeue-same-sealed-system-work",
      policyVersion: "v1",
    },
    {
      failureCode: "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
      retryDisposition: "manual",
      maxAttempts: 0,
      backoffPolicy: "none",
      nextAttemptPolicy: "none",
      policyVersion: "v1",
    },
    {
      failureCode: "NEX_MAINTENANCE_INTERRUPTED",
      retryDisposition: "retryable",
      maxAttempts: 3,
      backoffPolicy: "exponential-bounded",
      nextAttemptPolicy: "requeue-new-run-same-sealed-system-work",
      policyVersion: "v1",
    },
  ];
}

function c25bFindingRoutingMatrix() {
  return [
    {
      failureCode: "NEX_MAINTENANCE_TRANSIENT",
      findingRoute: "none",
    },
    {
      failureCode: "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
      findingRoute: "maintenance-inbox",
    },
    {
      failureCode: "NEX_MAINTENANCE_INTERRUPTED",
      findingRoute: "none",
    },
  ];
}

function baseFindingContract(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "narrative-finding-contract",
    reasonCodes: ["source-missing", "evidence-overlap"],
    unknownReasonCodePolicy: "fail-closed",
    observationStorageClass: "rebuildable-derived-state",
    epochBinding: "required",
    freshnessSnapshotPolicy: "diagnostic-only",
    currentFreshnessLookup: "narrative-consumer-freshness",
    rules: [
      {
        ruleId: "narrative.consumer-freshness",
        version: 1,
        identityScope: "edge",
        observationFields: [
          "stableSubject",
          "edgeId",
          "reasonCode",
          "evidenceFreshness",
        ],
        materialBasisFields: [
          "stableSubject",
          "edgeId",
          "reasonCode",
          "evidenceFreshness",
        ],
      },
    ],
    negativeFixture: "editing an observation must not change current freshness",
    ...overrides,
  };
}

function terminalFindingRule(overrides = {}) {
  return {
    ruleId: "narrative.maintenance-contract-failure",
    version: 1,
    identityScope: "maintenance-work",
    observationStorageClass: "durable-derived-history",
    writerAuthority: "maintenance-run-finalization-transaction",
    observationFields: [
      "stableSubject",
      "failureCode",
      "reasonCode",
      "evidenceFreshness",
    ],
    materialBasisFields: [
      "stableSubject",
      "failureCode",
      "reasonCode",
      "evidenceFreshness",
    ],
    ...overrides,
  };
}

function baseAttentionContract(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "maintenance-attention-contract",
    storageClass: "durable-user-state",
    epochBinding: "none",
    backflowPolicy: "forbid",
    writerAuthority: "attention-typed-writer",
    concurrencyControl: "row-version-occ",
    requestIdentity: "request-id-plus-payload-digest",
    actorIdentity: "required",
    writerControls: ["expectedVersion is required on every set and clear"],
    applicationConditions: [
      "finding-key-match",
      "finding-identity-resolved",
      "material-basis-digest-match",
      "snooze-not-expired",
    ],
    negativeFixture: "attention rows are never mutated by run publish",
    ...overrides,
  };
}

function baseAuthorityMatrix(overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "narrative-semantic-core-authorities",
    authorities: [
      {
        concern: "maintenance-finding-observation",
        canonicalAuthority: "freshness-run-publish-transaction",
        compatibilityMirror: null,
        writePolicy: "evaluator-publish-only",
      },
      {
        concern: "maintenance-terminal-finding-observation",
        canonicalAuthority: "maintenance-run-finalization-transaction",
        compatibilityMirror: null,
        writePolicy: "maintenance-finalization-only",
      },
      {
        concern: "maintenance-attention",
        canonicalAuthority: "attention-typed-writer",
        compatibilityMirror: null,
        writePolicy: "typed-writer-only",
      },
    ],
    semanticIndexAllowedFields: [
      "generation",
      "builtAt",
      "sourceDigest",
      "dependencySetDigest",
      "dirtyCacheFlag",
    ],
    forbiddenFreshnessClaims: [
      "assertion-is-authoritative-fresh",
      "assertionFresh",
      "isAuthoritativeFresh",
      "semanticTruth",
    ],
    secondaryFreshnessAuthorityPolicy: "forbid",
    ...overrides,
  };
}

function writeFixtureRoot({
  executionState = baseExecutionState(),
  failurePolicy = baseFailurePolicy(),
  findingContract = baseFindingContract(),
  attentionContract = baseAttentionContract(),
  authorityMatrix = baseAuthorityMatrix(),
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "execution-state-authority-"));
  cpSync(
    path.join(REPO_ROOT, "policies/narrative/schemas"),
    path.join(root, "policies/narrative/schemas"),
    { recursive: true },
  );
  writeJson(
    root,
    "policies/narrative/narrative-execution-state.json",
    executionState,
  );
  writeJson(
    root,
    "policies/narrative/narrative-failure-policy.json",
    failurePolicy,
  );
  writeJson(
    root,
    "policies/narrative/narrative-finding-contract.json",
    findingContract,
  );
  writeJson(
    root,
    "policies/narrative/maintenance-attention-contract.json",
    attentionContract,
  );
  writeJson(
    root,
    "policies/narrative/semantic-core-authorities.json",
    authorityMatrix,
  );
  cpSync(
    path.join(REPO_ROOT, "docs/adr/005-narrative-semantic-core-boundary.md"),
    path.join(root, "docs/adr/005-narrative-semantic-core-boundary.md"),
  );
  cpSync(
    path.join(REPO_ROOT, "src/features/narrative-extraction/runtime/types.ts"),
    path.join(root, "src/features/narrative-extraction/runtime/types.ts"),
  );
  return root;
}

describe("validate-execution-state-authority", () => {
  it("accepts the bundled Gate C2-00 contracts", () => {
    const result = validateExecutionStateAuthority({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
  });

  it("accepts a minimal well-formed fixture", () => {
    const root = writeFixtureRoot({
      findingContract: baseFindingContract({
        rules: [...baseFindingContract().rules, terminalFindingRule()],
      }),
    });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("rejects a finding rule with an unsupported identity scope", () => {
    const findingContract = baseFindingContract();
    findingContract.rules[0].identityScope = "consumer";
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("narrative-finding-contract.schema.json rejects"),
      ),
    );
  });

  it("rejects a finding rule with a missing required field", () => {
    const findingContract = baseFindingContract();
    findingContract.rules[0].observationFields = [
      "stableSubject",
      "reasonCode",
      "evidenceFreshness",
    ];
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("narrative-finding-contract.schema.json rejects"),
      ),
    );
  });

  it("rejects duplicate finding ruleId/version pairs", () => {
    const findingContract = baseFindingContract();
    findingContract.rules.push({
      ...findingContract.rules[0],
      observationFields: [
        "evidenceFreshness",
        "reasonCode",
        "edgeId",
        "stableSubject",
      ],
    });
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "duplicate ruleId/version: narrative.consumer-freshness@1",
        ),
      ),
    );
  });

  it("accepts the terminal rule's durable diagnostic history override", () => {
    const findingContract = baseFindingContract({
      rules: [
        ...baseFindingContract().rules,
        terminalFindingRule(),
      ],
    });
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.deepEqual(result.errors, []);
  });

  it("rejects a maintenance rule without an explicit durable history override", () => {
    const findingContract = baseFindingContract({
      rules: [
        ...baseFindingContract().rules,
        terminalFindingRule({
          observationStorageClass: undefined,
          writerAuthority: undefined,
        }),
      ],
    });
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("maintenance-work rule must declare observationStorageClass"),
      ),
    );
  });

  it("requires exactly one canonical terminal finding rule", () => {
    const root = writeFixtureRoot({
      findingContract: baseFindingContract(),
    });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "narrative-finding-contract.json must contain exactly one canonical terminal rule",
        ),
      ),
    );
  });

  it("rejects a renamed or wrong-version terminal rule", () => {
    for (const rule of [
      terminalFindingRule({ ruleId: "narrative.maintenance-contract-failure-renamed" }),
      terminalFindingRule({ version: 2 }),
    ]) {
      const root = writeFixtureRoot({
        findingContract: baseFindingContract({
          rules: [...baseFindingContract().rules, rule],
        }),
      });
      const result = validateExecutionStateAuthority({ repoRoot: root });
      assert.ok(
        result.errors.some((error) =>
          error.includes(
            "narrative-finding-contract.json must contain exactly one canonical terminal rule",
          ),
        ),
        `expected canonical rule rejection for ${rule.ruleId}@${rule.version}`,
      );
    }
  });

  it("rejects duplicate or extraneous versions of the canonical terminal rule", () => {
    const findingContract = baseFindingContract({
      rules: [
        ...baseFindingContract().rules,
        terminalFindingRule(),
        terminalFindingRule({ version: 2 }),
      ],
    });
    const root = writeFixtureRoot({ findingContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "canonical terminal ruleId must not have another version",
        ),
      ),
    );

    findingContract.rules.push(terminalFindingRule());
    const duplicateRoot = writeFixtureRoot({ findingContract });
    const duplicateResult = validateExecutionStateAuthority({
      repoRoot: duplicateRoot,
    });
    assert.ok(
      duplicateResult.errors.some((error) =>
        error.includes(
          "narrative-finding-contract.json must contain exactly one canonical terminal rule",
        ),
      ),
    );
  });

  it("rejects attention application conditions that omit identity resolution", () => {
    const attentionContract = baseAttentionContract({
      applicationConditions: [
        "finding-key-match",
        "material-basis-digest-match",
        "snooze-not-expired",
      ],
    });
    const root = writeFixtureRoot({ attentionContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("maintenance-attention-contract.schema.json rejects"),
      ),
    );
  });

  it("rejects a derivedView that drops a declared status", () => {
    const executionState = baseExecutionState();
    delete executionState.entities.run.derivedView.superseded;
    const root = writeFixtureRoot({ executionState });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "entities.run.derivedView must declare exactly the same statuses",
        ),
      ),
    );
  });

  it("rejects a terminal status whose derivedView phase is not terminal", () => {
    const executionState = baseExecutionState();
    executionState.entities.run.derivedView.cancelled = {
      phase: "running",
      outcome: null,
    };
    const root = writeFixtureRoot({ executionState });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("derivedView.cancelled.phase disagrees"),
      ),
    );
  });

  it("rejects a supersede cascade that points at an unregistered failure code", () => {
    const executionState = baseExecutionState({
      runSupersedeCascade: {
        task: { fromStatuses: ["queued"], toStatus: "cancelled" },
        attempt: {
          fromStatuses: ["running"],
          toStatus: "failed",
          failureCode: "NEX_UNKNOWN_CODE",
          retryDisposition: "superseded",
        },
      },
    });
    const root = writeFixtureRoot({ executionState });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "runSupersedeCascade.attempt.failureCode is not registered",
        ),
      ),
    );
  });

  it("rejects a retryable failure policy that declares no next-attempt policy", () => {
    const failurePolicy = baseFailurePolicy();
    failurePolicy.policies.push({
      failureCode: "NEX_TEST_RETRYABLE",
      retryDisposition: "retryable",
      maxAttempts: 3,
      backoffPolicy: "immediate",
      nextAttemptPolicy: "none",
      policyVersion: "v1",
    });
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          'NEX_TEST_RETRYABLE is retryable but declares nextAttemptPolicy "none"',
        ),
      ),
    );
  });

  it("rejects a duplicate failure code", () => {
    const failurePolicy = baseFailurePolicy();
    failurePolicy.policies.push({ ...failurePolicy.policies[0] });
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("duplicate failureCode: NEX_RUN_SUPERSEDED"),
      ),
    );
  });

  it("requires the exact C2-5B maintenance failure registrations and Finding routes", () => {
    const canonical = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-failure-policy.json",
        ),
        "utf8",
      ),
    );
    const policies = new Map(
      canonical.policies.map((policy) => [policy.failureCode, policy]),
    );
    for (const expected of c25bFailurePolicies()) {
      assert.deepEqual(policies.get(expected.failureCode), expected);
    }
    assert.deepEqual(
      canonical.findingRoutingMatrix,
      c25bFindingRoutingMatrix(),
    );
    assert.equal(validateFailurePolicySchema(canonical).valid, true);
    const result = validateExecutionStateAuthority({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
  });

  it("rejects C2-5B failure policy and Finding routing drift", () => {
    const failurePolicy = baseFailurePolicy();
    const transient = failurePolicy.policies.find(
      (policy) => policy.failureCode === "NEX_MAINTENANCE_TRANSIENT",
    );
    transient.maxAttempts = 2;
    const interruptedRoute = failurePolicy.findingRoutingMatrix.find(
      (route) => route.failureCode === "NEX_MAINTENANCE_INTERRUPTED",
    );
    interruptedRoute.findingRoute = "maintenance-inbox";
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "NEX_MAINTENANCE_TRANSIENT maxAttempts must be exactly 3",
        ),
      ),
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "NEX_MAINTENANCE_INTERRUPTED Finding route must be exactly 'none'",
        ),
      ),
    );
  });

  it("rejects a cross-phase C2-5B code instead of matching retryability by substring", () => {
    const findingRoutingMatrix = c25bFindingRoutingMatrix();
    findingRoutingMatrix[0].failureCode =
      "NEX_MAINTENANCE_TRANSIENT_RETRYABLE";
    const root = writeFixtureRoot({
      failurePolicy: baseFailurePolicy({ findingRoutingMatrix }),
    });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "findingRoutingMatrix contains unknown failureCode NEX_MAINTENANCE_TRANSIENT_RETRYABLE",
        ),
      ),
    );
  });

  it("rejects deleting all C2-5B policies and the routing matrix in schema and authority validation", () => {
    const failurePolicy = baseFailurePolicy();
    const c25bCodes = new Set(c25bFailurePolicies().map((policy) => policy.failureCode));
    failurePolicy.policies = failurePolicy.policies.filter(
      (policy) => !c25bCodes.has(policy.failureCode),
    );
    delete failurePolicy.findingRoutingMatrix;
    assert.equal(validateFailurePolicySchema(failurePolicy).valid, false);
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    for (const failureCode of c25bCodes) {
      assert.ok(
        result.errors.some((error) =>
          error.includes(`C2-5B failure policy is missing the exact registration for ${failureCode}`),
        ),
        `missing policy was not rejected: ${failureCode}`,
      );
    }
    assert.ok(
      result.errors.some((error) =>
        error.includes("C2-5B failure policy must declare findingRoutingMatrix"),
      ),
    );
  });

  it("rejects deleting one C2-5B policy or its route", () => {
    const failurePolicy = baseFailurePolicy();
    failurePolicy.policies = failurePolicy.policies.filter(
      (policy) => policy.failureCode !== "NEX_MAINTENANCE_TRANSIENT",
    );
    failurePolicy.findingRoutingMatrix = failurePolicy.findingRoutingMatrix.filter(
      (route) => route.failureCode !== "NEX_MAINTENANCE_TRANSIENT",
    );
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "C2-5B failure policy is missing the exact registration for NEX_MAINTENANCE_TRANSIENT",
        ),
      ),
    );
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "C2-5B findingRoutingMatrix is missing the exact route for NEX_MAINTENANCE_TRANSIENT",
        ),
      ),
    );
  });

  it("rejects a reverse-ordered C2-5B Finding routing matrix", () => {
    const failurePolicy = baseFailurePolicy({
      findingRoutingMatrix: c25bFindingRoutingMatrix().reverse(),
    });
    const root = writeFixtureRoot({ failurePolicy });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "C2-5B findingRoutingMatrix must use the canonical order",
        ),
      ),
    );
  });

  it("rejects duplicate, extra, and wrong-route matrix entries", () => {
    const cases = [
      {
        label: "duplicate",
        mutate(matrix) {
          matrix.push({ ...matrix[0] });
        },
        expected: "contains duplicate failureCode",
      },
      {
        label: "extra",
        mutate(matrix) {
          matrix.push({
            failureCode: "NEX_CROSS_PHASE_RETRYABLE",
            findingRoute: "none",
          });
        },
        expected: "contains unknown failureCode NEX_CROSS_PHASE_RETRYABLE",
      },
      {
        label: "wrong route",
        mutate(matrix) {
          matrix[1].findingRoute = "none";
        },
        expected: "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION Finding route must be exactly 'maintenance-inbox'",
      },
    ];
    for (const testCase of cases) {
      const failurePolicy = baseFailurePolicy({
        findingRoutingMatrix: (() => {
          const matrix = c25bFindingRoutingMatrix();
          testCase.mutate(matrix);
          return matrix;
        })(),
      });
      const root = writeFixtureRoot({ failurePolicy });
      const result = validateExecutionStateAuthority({ repoRoot: root });
      assert.ok(
        result.errors.some((error) => error.includes(testCase.expected)),
        `${testCase.label} matrix drift was not rejected: ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("rejects an authority matrix missing the maintenance-attention concern", () => {
    const authorityMatrix = baseAuthorityMatrix();
    authorityMatrix.authorities = authorityMatrix.authorities.filter(
      (entry) => entry.concern !== "maintenance-attention",
    );
    const root = writeFixtureRoot({ authorityMatrix });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "semantic-core-authorities.json is missing the maintenance-attention concern",
        ),
      ),
    );
  });

  it("rejects a canonicalAuthority that disagrees with the attention contract writerAuthority", () => {
    const authorityMatrix = baseAuthorityMatrix();
    const attentionEntry = authorityMatrix.authorities.find(
      (entry) => entry.concern === "maintenance-attention",
    );
    attentionEntry.canonicalAuthority = "something-else";
    const root = writeFixtureRoot({ authorityMatrix });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(result.errors.some((error) => error.includes("disagrees with")));
  });

  it("rejects a backflowPolicy other than forbid on the attention contract", () => {
    const attentionContract = baseAttentionContract({
      backflowPolicy: "allow",
    });
    const root = writeFixtureRoot({ attentionContract });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(result.errors.length > 0);
  });

  it("rejects narrative-execution-state.json when it fails schema validation", () => {
    const root = writeFixtureRoot({
      executionState: {
        schemaVersion: 1,
        contract: "narrative-execution-state",
      },
    });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("narrative-execution-state.schema.json rejects"),
      ),
    );
  });

  it("rejects a run status contract that drops a status the runtime types still use", () => {
    const executionState = baseExecutionState();
    executionState.entities.run.statuses =
      executionState.entities.run.statuses.filter(
        (status) => status !== "cancelled",
      );
    delete executionState.entities.run.derivedView.cancelled;
    executionState.entities.run.terminalStatuses =
      executionState.entities.run.terminalStatuses.filter(
        (status) => status !== "cancelled",
      );
    const root = writeFixtureRoot({ executionState });
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "entities.run.statuses drops a status the existing NarrativeExtractionRunStatus still uses: cancelled",
        ),
      ),
    );
  });

  it("rejects when ADR 005's C2 start condition checklist has been altered", () => {
    const root = writeFixtureRoot();
    writeFileSync(
      path.join(root, "docs/adr/005-narrative-semantic-core-boundary.md"),
      "# amended without the checklist\n",
    );
    const result = validateExecutionStateAuthority({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("ADR 005 C2 start condition is missing"),
      ),
    );
  });
});
