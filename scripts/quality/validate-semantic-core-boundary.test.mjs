import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateArtifactAuthorityContract,
  validateDependencyRoleContract,
  validateInterpreterBoundary,
  validateScopeRelationContract,
  validateSemanticCoreBoundary,
} from "./validate-semantic-core-boundary.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function minimalFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "semantic-core-boundary-"));
  writeJson(root, "policies/narrative/mutation-authority-routes.json", {
    schemaVersion: 1,
    callerAuthorizationPolicy: "positive-allowlist-fail-closed",
    forbiddenCallersSemantics: "diagnostic-only",
    routes: [
      {
        id: "human-direct",
        requiredControls: ["typed-writer"],
        forbiddenCallers: ["background-maintenance"],
      },
      {
        id: "interactive-agent-command",
        requiredControls: ["typed-writer", "field-authority"],
        forbiddenCallers: ["background-maintenance"],
      },
      {
        id: "interpreter-projection",
        requiredControls: ["prepared-commit"],
        forbiddenCallers: ["background-maintenance"],
      },
      {
        id: "import-apply",
        requiredControls: ["typed-writer"],
        forbiddenCallers: [],
      },
      {
        id: "history-replay",
        requiredControls: ["journal-lineage"],
        forbiddenCallers: [],
      },
      {
        id: "restore-or-migration",
        requiredControls: ["semantic-epoch-event"],
        forbiddenCallers: [],
      },
      {
        id: "attention-typed-writer",
        requiredControls: ["typed-writer"],
        forbiddenCallers: ["background-maintenance"],
      },
    ],
  });
  writeJson(root, "policies/narrative/semantic-state-vocabulary.json", {
    schemaVersion: 1,
    reviewStates: ["unreviewed", "accepted", "rejected", "held", "superseded"],
    evidenceFreshness: [
      "fresh",
      "stale",
      "source-missing",
      "anchor-mismatch",
      "read-set-drift",
      "unknown",
    ],
    reconciliationSignals: ["needs-reconciliation"],
    buildActions: ["none", "rebuild-required"],
    componentCompatibility: ["compatible"],
    projectionApplicationStates: [
      "unapplied",
      "applied",
      "compensated",
      "undone",
      "stale",
      "not-applicable",
    ],
    contributionTargetStates: [
      "unchanged",
      "modified",
      "missing",
      "superseded",
      "undone",
      "not-applicable",
    ],
    maintenanceOwnershipStates: ["maintained", "user-owned", "detached"],
  });
  writeJson(root, "policies/narrative/semantic-core-authorities.json", {
    schemaVersion: 1,
    authorities: [
      {
        concern: "evidence-freshness",
        canonicalAuthority: "consumer-freshness",
        compatibilityMirror: "legacy-projection-freshness",
      },
    ],
    semanticIndexAllowedFields: [
      "generation",
      "builtAt",
      "sourceDigest",
      "dependencySetDigest",
      "dirtyCacheFlag",
    ],
  });
  writeJson(root, "policies/narrative/retrieval-disclosure.json", {
    schemaVersion: 1,
    phaseResolutionModes: ["reading", "story", "auto"],
    rejectionRules: [
      "future-phase",
      "future-story-time",
      "secret-before-reveal",
      "knowledge-holder-mismatch",
      "reader-knowledge-not-character",
      "worldline-mismatch",
      "timeline-mismatch",
      "narrative-layer-mismatch",
    ],
  });
  writeJson(root, "policies/narrative/change-feed-writers.json", {
    schemaVersion: 1,
    writerMatrix: [{ writer: "fixture.writer" }],
    semanticBoundary: {
      schemaVersion: 1,
      scanRoots: [
        "src/features/narrative-semantic-core",
        "src/features/narrative-extraction",
        "src/features/semantic-search",
        "src/application/narrative-extraction",
        "src-tauri/crates/grimodex-db/src/narrative_extraction",
        "src-tauri/crates/grimodex-semantic/src",
        "electron/main",
        "electron/preload",
      ],
      commandInventory: {
        schemaVersion: 1,
        sources: [
          {
            path: "electron/shared/fixture.ts",
            surface: "electron-ipc",
            extractor: "handler-keys",
          },
        ],
        mutationPrefixes: ["fixture_"],
        ignoredCommands: [],
      },
    },
    operations: [
      {
        id: "fixture.write",
        feedPolicy: "required",
        authorityRoute: "human-direct",
        controls: ["typed-writer"],
      },
    ],
  });
  mkdirSync(path.join(root, "src-tauri/crates/grimodex-core/src"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "src-tauri/crates/grimodex-core/src/lib.rs"),
    "pub const SCHEMA_VERSION: i32 = 23;\n",
  );
  mkdirSync(path.join(root, "electron/shared"), { recursive: true });
  writeFileSync(
    path.join(root, "electron/shared/fixture.ts"),
    "const handlers = {\n  fixture_write: {},\n};\n",
  );
  for (const relativeRoot of [
    "src/features/narrative-semantic-core",
    "src/features/narrative-extraction",
    "src/features/semantic-search",
    "src/application/narrative-extraction",
    "src-tauri/crates/grimodex-db/src/narrative_extraction",
    "src-tauri/crates/grimodex-semantic/src",
    "electron/main",
    "electron/preload",
  ]) {
    mkdirSync(path.join(root, relativeRoot), { recursive: true });
  }
  return root;
}

function validateInterpreterSourceFixture(relativeFilename, source, configureContract) {
  const root = minimalFixtureRoot();
  const contract = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "policies/narrative/narrative-artifact-authority.json",
      ),
      "utf8",
    ),
  );
  configureContract?.(contract);
  const interpreterRoot = "src/features/narrative-extraction/ir";
  for (const relativeRoot of contract.interpreterBoundary.interpreterRoots) {
    mkdirSync(path.join(root, relativeRoot), { recursive: true });
  }
  writeJson(root, contract.interpreterBoundary.fixtures[0], {});
  const target = path.join(root, interpreterRoot, relativeFilename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source);
  const errors = [];

  validateInterpreterBoundary(root, contract, errors);
  rmSync(root, { recursive: true, force: true });
  return errors;
}

function validateArtifactFixtureContract(fixture) {
  const root = mkdtempSync(path.join(tmpdir(), "artifact-authority-fixture-"));
  const contract = JSON.parse(
    readFileSync(
      path.join(
        REPO_ROOT,
        "policies/narrative/narrative-artifact-authority.json",
      ),
      "utf8",
    ),
  );
  contract.implementationStatus = {
    state: "declared",
    productionEntryPoints: [],
    scanRoots: [],
    productionMarkers: [],
  };
  writeJson(root, "policies/narrative/fixtures/artifact-authority.json", fixture);
  const errors = [];
  validateArtifactAuthorityContract(root, contract, errors);
  rmSync(root, { recursive: true, force: true });
  return errors;
}

describe("validate-semantic-core-boundary", () => {
  it("accepts the repository's ratified semantic contract", () => {
    const result = validateSemanticCoreBoundary({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
    assert.ok(result.operationCount > 0);
    assert.equal(result.schemaVersion, 31);
    assert.equal(result.checks.scopeRelationContract, true);
    assert.equal(result.checks.dependencyRoleContract, true);
    assert.equal(result.checks.artifactAuthorityContract, true);
    assert.equal(result.checks.interpreterBoundary, true);
  });

  it("keeps raw model response ephemeral while retaining a response digest", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const errors = [];

    validateArtifactAuthorityContract(REPO_ROOT, contract, errors);

    assert.deepEqual(errors, []);
    assert.equal(
      contract.artifacts.find((artifact) => artifact.id === "raw-model-response")
        ?.lifecycle,
      "ephemeral",
    );
    assert.equal(
      contract.artifacts.find((artifact) => artifact.id === "raw-model-response")
        ?.retention?.default,
      "not-retained",
    );
    assert.equal(
      contract.artifacts.find((artifact) => artifact.id === "response-digest")
        ?.retention?.default,
      "retained",
    );
  });

  it("rejects a policy that falsely claims durable raw response retention", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const rawResponse = contract.artifacts.find(
      (artifact) => artifact.id === "raw-model-response",
    );
    rawResponse.lifecycle = "durable";
    rawResponse.retention.default = "retained";
    const errors = [];

    validateArtifactAuthorityContract(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) => /raw-model-response.*not be durable/i.test(error)),
    );
    assert.ok(
      errors.some((error) => /raw-model-response.*not-retained/i.test(error)),
    );
  });

  it("evaluates every artifact source golden and rejects malformed or swapped dispositions", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/fixtures/artifact-authority.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(validateArtifactFixtureContract(fixture), []);

    const malformedAccepted = structuredClone(fixture);
    malformedAccepted.cases.find(
      (fixtureCase) => fixtureCase.id === "interpreter-malformed-source-rejected",
    ).expected = "accept";
    const malformedErrors = validateArtifactFixtureContract(malformedAccepted);
    assert.ok(
      malformedErrors.some((error) =>
        /interpreter-malformed-source-rejected.*expected accept.*got reject/i.test(
          error,
        ),
      ),
      `malformed source must not be accepted: ${JSON.stringify(malformedErrors)}`,
    );

    const swapped = structuredClone(fixture);
    swapped.cases.find(
      (fixtureCase) => fixtureCase.id === "interpreter-typed-writer-rejected",
    ).expected = "accept";
    swapped.cases.find(
      (fixtureCase) =>
        fixtureCase.id === "interpreter-type-only-vocabulary-allowed",
    ).expected = "reject";
    const swappedErrors = validateArtifactFixtureContract(swapped);
    assert.ok(
      swappedErrors.some((error) =>
        /interpreter-typed-writer-rejected.*expected accept.*got reject/i.test(
          error,
        ),
      ),
      `unsafe source disposition swaps must fail closed: ${JSON.stringify(swappedErrors)}`,
    );
    assert.ok(
      swappedErrors.some((error) =>
        /interpreter-type-only-vocabulary-allowed.*expected reject.*got accept/i.test(
          error,
        ),
      ),
      `safe source disposition swaps must fail closed: ${JSON.stringify(swappedErrors)}`,
    );
  });

  it("pins artifact claims and each source golden to its declared semantics", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/fixtures/artifact-authority.json",
        ),
        "utf8",
      ),
    );

    const durableClaim = structuredClone(fixture);
    durableClaim.cases.find(
      (fixtureCase) => fixtureCase.id === "raw-model-response-durable-rejected",
    ).claim.lifecycle = "ephemeral";
    const durableErrors = validateArtifactFixtureContract(durableClaim);
    assert.ok(
      durableErrors.some(
        (error) =>
          /raw-model-response-durable-rejected.*expected reject.*got accept/i.test(
            error,
          ),
      ),
      `durable claim mutation must be detected: ${JSON.stringify(durableErrors)}`,
    );

    const durableDisposition = structuredClone(fixture);
    const durableDispositionCase = durableDisposition.cases.find(
      (fixtureCase) => fixtureCase.id === "raw-model-response-durable-rejected",
    );
    durableDispositionCase.claim.lifecycle = "ephemeral";
    durableDispositionCase.expected = "accept";
    const durableDispositionErrors = validateArtifactFixtureContract(
      durableDisposition,
    );
    assert.ok(
      durableDispositionErrors.some(
        (error) =>
          /raw-model-response-durable-rejected.*ratified|raw-model-response-durable-rejected.*expected reject.*got accept/i.test(
            error,
          ),
      ),
      `fixture claim and disposition mutations must be pinned: ${JSON.stringify(durableDispositionErrors)}`,
    );

    const indexClaim = structuredClone(fixture);
    indexClaim.cases.find(
      (fixtureCase) => fixtureCase.id === "semantic-index-authority-rejected",
    ).claim.authoritative = false;
    const indexErrors = validateArtifactFixtureContract(indexClaim);
    assert.ok(
      indexErrors.some(
        (error) =>
          /semantic-index-authority-rejected.*expected reject.*got accept/i.test(
            error,
          ),
      ),
      `semantic-index authority mutation must be detected: ${JSON.stringify(indexErrors)}`,
    );

    const swappedSource = structuredClone(fixture);
    swappedSource.cases.find(
      (fixtureCase) => fixtureCase.id === "interpreter-sql-import-rejected",
    ).source = "typedWriter.commit({});";
    const sourceErrors = validateArtifactFixtureContract(swappedSource);
    assert.ok(
      sourceErrors.some(
        (error) =>
          /interpreter-sql-import-rejected.*declared rule.*sql-import/i.test(
            error,
          ),
      ),
      `source rule swaps must be detected: ${JSON.stringify(sourceErrors)}`,
    );

    const swappedSourceSemantics = structuredClone(fixture);
    const swappedSourceCase = swappedSourceSemantics.cases.find(
      (fixtureCase) => fixtureCase.id === "interpreter-sql-import-rejected",
    );
    swappedSourceCase.source = "typedWriter.commit({});";
    swappedSourceCase.rule = "typed-writer";
    const swappedSourceSemanticErrors = validateArtifactFixtureContract(
      swappedSourceSemantics,
    );
    assert.ok(
      swappedSourceSemanticErrors.some(
        (error) =>
          /interpreter-sql-import-rejected.*ratified|interpreter-sql-import-rejected.*sql-import/i.test(
            error,
          ),
      ),
      `source semantic and rule swaps must be pinned: ${JSON.stringify(swappedSourceSemanticErrors)}`,
    );

    const arbitrarySafeSource = structuredClone(fixture);
    arbitrarySafeSource.cases.find(
      (fixtureCase) =>
        fixtureCase.id === "interpreter-type-only-vocabulary-allowed",
    ).source = "const safe = true;";
    const safeSourceErrors = validateArtifactFixtureContract(arbitrarySafeSource);
    assert.ok(
      safeSourceErrors.some(
        (error) =>
          /interpreter-type-only-vocabulary-allowed.*declared rule.*type-only-domain-vocabulary/i.test(
            error,
          ),
      ),
      `positive source semantics must be pinned: ${JSON.stringify(safeSourceErrors)}`,
    );

    const duplicateCase = structuredClone(fixture);
    duplicateCase.cases.push(
      structuredClone(
        duplicateCase.cases.find(
          (fixtureCase) => fixtureCase.id === "interpreter-sql-import-rejected",
        ),
      ),
    );
    const duplicateErrors = validateArtifactFixtureContract(duplicateCase);
    assert.ok(
      duplicateErrors.some((error) => /duplicate.*interpreter-sql-import-rejected/i.test(error)),
      `duplicate fixture IDs must be rejected: ${JSON.stringify(duplicateErrors)}`,
    );
  });

  it("fails closed for forbidden Interpreter dependencies", () => {
    const root = minimalFixtureRoot();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const interpreterRoot = "src/features/narrative-extraction/ir";
    contract.interpreterBoundary.interpreterRoots = [interpreterRoot];
    mkdirSync(path.join(root, interpreterRoot), { recursive: true });
    writeFileSync(
      path.join(root, interpreterRoot, "bad.ts"),
      [
        'import { sql } from "drizzle-orm";',
        'import { PreparedCommit } from "@/application/narrative-extraction/preparedCommit";',
        'import { agentWriter } from "@/features/agent-writes";',
        'import { mcpSql } from "@/mcp/sql";',
        'const db = useDb();',
        'db.execute("UPDATE narrative_proposal_revisions SET payload_json = ?");',
        'typedWriter.commit({});',
        'mcpSql.query("SELECT 1");',
      ].join("\n"),
    );
    const errors = [];

    validateInterpreterBoundary(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(errors.some((error) => /sql-import/i.test(error)));
    assert.ok(errors.some((error) => /prepared-commit/i.test(error)));
    assert.ok(errors.some((error) => /agent-writer/i.test(error)));
    assert.ok(errors.some((error) => /db-mutation/i.test(error)));
    assert.ok(errors.some((error) => /typed-writer/i.test(error)));
    assert.ok(errors.some((error) => /generic-mcp-sql/i.test(error)));
  });

  it("scans ESM dynamic imports in production .mts and .cts sources", () => {
    const root = minimalFixtureRoot();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const interpreterRoot = "src/features/narrative-extraction/ir";
    contract.interpreterBoundary.interpreterRoots = [interpreterRoot];
    mkdirSync(path.join(root, interpreterRoot), { recursive: true });
    mkdirSync(path.join(root, "policies/narrative/fixtures"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "policies/narrative/fixtures/artifact-authority.json"),
      "{}\n",
    );
    writeFileSync(
      path.join(root, interpreterRoot, "dynamic-agent.mts"),
      'const writerModule = await import("@/features/agent-writes/codex");\n',
    );
    writeFileSync(
      path.join(root, interpreterRoot, "dynamic-db.cts"),
      [
        'const drizzleModule = await import("drizzle-orm");',
        'const typedWriterModule = await import("@/application/narrative-extraction/typed-writer");',
        "typedWriter.commit({});",
      ].join("\n"),
    );
    const errors = [];

    validateInterpreterBoundary(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(
      errors.some((error) => /agent-writer.*dynamic-agent\.mts/i.test(error)),
      `dynamic Agent Writer imports must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /sql-import.*dynamic-db\.cts/i.test(error)),
      `dynamic Drizzle imports must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /typed-writer.*dynamic-db\.cts/i.test(error)),
      `typed-writer imports/calls in .cts must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects optional-chained database mutation calls", () => {
    const root = minimalFixtureRoot();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const interpreterRoot = "src/features/narrative-extraction/ir";
    contract.interpreterBoundary.interpreterRoots = [interpreterRoot];
    mkdirSync(path.join(root, interpreterRoot), { recursive: true });
    mkdirSync(path.join(root, "policies/narrative/fixtures"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "policies/narrative/fixtures/artifact-authority.json"),
      "{}\n",
    );
    writeFileSync(
      path.join(root, interpreterRoot, "optional-db.ts"),
      [
        'database?.execute("UPDATE narrative_proposal_revisions SET payload_json = ?");',
        'database.execute?.("UPDATE narrative_proposal_revisions SET payload_json = ?");',
      ].join("\n"),
    );
    const errors = [];

    validateInterpreterBoundary(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(
      errors.some((error) => /db-mutation.*optional-db\.ts/i.test(error)),
      `optional-chained database mutation calls must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects the exact aliased nonliteral import and computed mutation bypass", () => {
    const errors = validateInterpreterSourceFixture(
      "alias-db.mts",
      [
        'const source = "@/db/client";',
        "const { database: storage } = await import(source);",
        'storage["execute"]("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*alias-db\.mts/i.test(error)),
      `nonliteral dynamic imports must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /db-mutation.*alias-db\.mts/i.test(error)),
      `computed database mutations must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a nonliteral dynamic import independently of mutations", () => {
    const errors = validateInterpreterSourceFixture(
      "nonliteral-import.mts",
      [
        'const source = "@/db/client";',
        "await import(source);",
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*nonliteral-import\.mts/i.test(error)),
      `nonliteral dynamic imports must be rejected independently: ${JSON.stringify(errors)}`,
    );
    assert.equal(
      errors.some((error) => /db-mutation.*nonliteral-import\.mts/i.test(error)),
      false,
      `a nonliteral import alone must not fabricate a DB mutation finding: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a computed mutation independently of imports", () => {
    const errors = validateInterpreterSourceFixture(
      "computed-mutation.mts",
      'const storage = getStorage();\nstorage["execute"]("DELETE FROM narrative_proposal_revisions");\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*computed-mutation\.mts/i.test(error)),
      `computed database mutations must be rejected independently: ${JSON.stringify(errors)}`,
    );
    assert.equal(
      errors.some((error) => /non-literal-dynamic-import.*computed-mutation\.mts/i.test(error)),
      false,
      `a computed mutation alone must not fabricate a dynamic import finding: ${JSON.stringify(errors)}`,
    );
  });

  it("allows literal dynamic imports and benign computed calls", () => {
    const errors = validateInterpreterSourceFixture(
      "benign-computed.mts",
      [
        'await import("./literal-module");',
        "await import(`./literal-template-module`);",
        'const registry = { lookup: () => true };',
        'registry["lookup"]();',
        'const method = "lookup";',
        "registry[method]();",
      ].join("\n"),
    );

    assert.deepEqual(errors, []);
  });

  it("rejects a const string identifier used as a computed database method", () => {
    const errors = validateInterpreterSourceFixture(
      "const-method-mutation.mts",
      [
        'const method = "execute";',
        'database[method]("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /db-mutation.*const-method-mutation\.mts/i.test(error)),
      `const computed database methods must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects destructured aliases of sensitive database methods", () => {
    const errors = validateInterpreterSourceFixture(
      "destructured-method-alias.mts",
      [
        "const { execute: mutate } = database;",
        'mutate("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /db-mutation.*destructured-method-alias\.mts/i.test(error)),
      `destructured sensitive database methods must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects sensitive computed BindingElement properties while allowing benign lookup destructuring", () => {
    const sensitiveCases = [
      {
        name: "direct literal",
        source: [
          'const { ["execute"]: mutate } = database;',
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "const identifier exact repro",
        source: [
          'const method = "execute";',
          "const { [method]: mutate } = database;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "concatenated string",
        source: [
          'const { ["exec" + "ute"]: mutate } = database;',
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "template expression",
        source: [
          'const { [`exec${"ute"}`]: mutate } = database;',
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `computed-binding-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} computed sensitive bindings must be rejected: ${JSON.stringify(errors)}`,
      );
    }

    const benignErrors = validateInterpreterSourceFixture(
      "benign-computed-binding.mts",
      [
        'const registry = { lookup: () => true };',
        'const method = "lookup";',
        "const { [method]: lookup } = registry;",
        "lookup();",
      ].join("\n"),
    );

    assert.deepEqual(benignErrors, []);
  });

  it("rejects unresolved computed BindingElement properties fail-closed", () => {
    const unresolvedCases = [
      {
        name: "reassigned let identifier",
        source: [
          'let method = "lookup";',
          'method = "execute";',
          "const { [method]: mutate } = database;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "opaque call identifier",
        source: [
          "let method = getMethod();",
          "const { [method]: mutate } = database;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "conditional identifier",
        source: [
          'const method = flag ? "execute" : "lookup";',
          "const { [method]: mutate } = database;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "direct call expression key",
        source: [
          "const { [getMethod()]: mutate } = database;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "parameter key",
        source: [
          "function read(method) {",
          "  const { [method]: mutate } = database;",
          '  mutate("DELETE FROM narrative_proposal_revisions");',
          "}",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of unresolvedCases.entries()) {
      const filename = `unresolved-computed-binding-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} computed bindings must fail closed: ${JSON.stringify(errors)}`,
      );
    }

    const benignControls = [
      {
        name: "known static benign computed key",
        source: [
          'const registry = { lookup: () => true };',
          'const method = "lookup";',
          "const { [method]: lookup } = registry;",
          "lookup();",
        ].join("\n"),
      },
      {
        name: "literal benign computed key",
        source: [
          'const registry = { lookup: () => true };',
          'const { ["lookup"]: lookup } = registry;',
          "lookup();",
        ].join("\n"),
      },
      {
        name: "noncomputed benign destructuring",
        source: [
          'const registry = { lookup: () => true };',
          "const { lookup } = registry;",
          "lookup();",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of benignControls.entries()) {
      const filename = `benign-binding-control-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.deepEqual(
        errors,
        [],
        `${testCase.name} must remain allowed: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("rejects unresolved computed values that flow through invocation aliases", () => {
    const sensitiveCases = [
      {
        name: "exact conditional key alias",
        source: [
          'const key = flag ? "execute" : "query";',
          "const mutate = database[key];",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "reassigned key alias",
        source: [
          'let key = "lookup";',
          'key = getMethod();',
          "const mutate = database[key];",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "opaque dynamic key alias",
        source: [
          "const mutate = database[getMethod()];",
          'mutate?.("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "parenthesized and asserted alias",
        source: [
          'const mutate = ((database[getMethod()] as unknown)!) as (() => void);',
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "satisfies and await wrappers",
        source: [
          'const mutate = (await database[getMethod()]) satisfies (() => void);',
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "comma conditional and logical wrappers",
        source: [
          'const comma = (0, database[getMethod()]);',
          'const conditional = flag ? database[getMethod()] : noop;',
          'const logical = flag && database[getMethod()];',
          "comma();",
          "conditional?.();",
          "logical();",
        ].join("\n"),
      },
      {
        name: "assignment alias",
        source: [
          "let mutate;",
          "mutate = database[getMethod()];",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "indirect call apply and bind aliases",
        source: [
          "const mutate = database[getMethod()];",
          'mutate.call(database, "DELETE FROM narrative_proposal_revisions");',
          'mutate.apply(database, ["DELETE FROM narrative_proposal_revisions"]);',
          'mutate.bind(database)("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "computed indirect method aliases and bound result",
        source: [
          "const mutate = database[getMethod()];",
          'const call = mutate["call"];',
          'const apply = mutate["apply"];',
          'const bind = mutate["bind"];',
          "const bound = bind(database);",
          'call(database, "DELETE FROM narrative_proposal_revisions");',
          'apply(database, ["DELETE FROM narrative_proposal_revisions"]);',
          'bound("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array extraction",
        source: [
          "const aliases = [database[getMethod()]];",
          "const mutate = aliases[0];",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array destructuring and nested defaults",
        source: [
          "const aliases = [[database[getMethod()]]];",
          "const [[mutate = noop]] = aliases;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object member extraction",
        source: [
          "const aliases = { mutate: database[getMethod()] };",
          "const mutate = aliases.mutate;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "destructure default and nested extraction",
        source: [
          "const aliases = { nested: { mutate: database[getMethod()] } };",
          "const { nested: { mutate = noop } = {} } = aliases;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "destructure rest extraction",
        source: [
          "const aliases = { mutate: database[getMethod()], keep: noop };",
          "const { missing, ...rest } = aliases;",
          "const mutate = rest.mutate;",
          'mutate("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "new tagged and Reflect invocation sinks",
        source: [
          "const mutate = database[getMethod()];",
          "new mutate();",
          "mutate`DELETE FROM narrative_proposal_revisions`;",
          "Reflect.apply(mutate, database, []);",
          "Reflect.construct(mutate, []);",
        ].join("\n"),
      },
      {
        name: "closure invocation of a tainted local",
        source: [
          "function run() {",
          "  const mutate = database[getMethod()];",
          '  return () => mutate("DELETE FROM narrative_proposal_revisions");',
          "}",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `invocation-taint-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject invocation-oriented computed aliases: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("preserves benign callable aliases, lexical shadowing, and read-only computed accesses", () => {
    const controls = [
      {
        name: "static benign lookup alias",
        source: [
          'const registry = { lookup: () => true };',
          'const lookup = registry["lookup"];',
          "lookup();",
        ].join("\n"),
      },
      {
        name: "lexically shadowed callable alias",
        source: [
          "const mutate = database[getMethod()];",
          "{",
          "  const mutate = () => true;",
          "  mutate();",
          "}",
        ].join("\n"),
      },
      {
        name: "observation rows read only",
        source: [
          "const observation = observationRows[index];",
          "const recordValue = record[key];",
          "const entryValue = entry[field];",
          "const axisValue = value[axis];",
          "const beforeValue = before[key];",
          "const oracleValue = orderOracles?.[axis];",
          "console.log(observation, recordValue, entryValue, axisValue, beforeValue, oracleValue);",
        ].join("\n"),
      },
      {
        name: "dynamic production receivers with benign member calls",
        source: [
          "REQUIRED_CONTROLS[route].filter(Boolean);",
          "AXIS_VALUES[axis].includes(value);",
          "record[key].trim();",
          "Reflect.get(record, key);",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of controls.entries()) {
      const filename = `invocation-taint-control-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.deepEqual(
        errors,
        [],
        `${testCase.name} must remain allowed: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("closes ambiguous bindings, spread offsets, and nested member assignment aliases", () => {
    const sensitiveCases = [
      {
        name: "ambiguous duplicate var binding",
        source: [
          "var fn;",
          "var fn = database[key];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array spread index offset",
        source: [
          "const safe = () => true;",
          "const xs = [safe, database[key]];",
          "const ys = [0, ...xs];",
          "const fn = ys[2];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "nested member assignment",
        source: [
          "const outer = { box: {} };",
          "outer.box.fn = database[key];",
          "const fn = outer.box.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object container alias assignment",
        source: [
          "const outer = { box: {} };",
          "const box = outer.box;",
          "box.fn = database[key];",
          "const fn = outer.box.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array container alias assignment",
        source: [
          "const safe = () => true;",
          "const xs = [safe];",
          "const ys = xs;",
          "ys[0] = database[key];",
          "const fn = xs[0];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "computed member assignment",
        source: [
          "const obj = {};",
          "obj[key] = database[key];",
          "const fn = obj.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array hole spread position",
        source: [
          "const xs = [safe, ,];",
          "const ys = [...xs, database[key]];",
          "const fn = ys[2];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "string spread position",
        source: [
          'const ys = [..."ab", database[key]];',
          "const fn = ys[2];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "multiple unknown spread positions",
        source: [
          "const first = database[key];",
          "const second = database[key];",
          "const ys = [...first, ...second, database[key]];",
          "const fn = ys[0];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object spread extraction",
        source: [
          "const aliases = { fn: database[key] };",
          "const copy = { safe: () => true, ...aliases };",
          "const fn = copy.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "nested object spread identity",
        source: [
          "const source = { inner: {} };",
          "const copy = { ...source };",
          "copy.inner.fn = database[key];",
          "const fn = source.inner.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "nested array member assignment",
        source: [
          "const outer = { boxes: [{}] };",
          "outer.boxes[0].fn = database[key];",
          "const fn = outer.boxes[0].fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "assignment expression result",
        source: [
          "let tmp;",
          "const fn = (tmp = database[key]);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "logical assignment results",
        source: [
          "const safe = () => true;",
          "let fn = safe;",
          "fn ||= database[key];",
          "fn &&= database[key];",
          "fn ??= database[key];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array destructuring assignment default",
        source: [
          "const safe = () => true;",
          "let fn;",
          "[fn = safe] = [database[key]];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object shorthand destructuring assignment",
        source: [
          "let fn;",
          "({ fn } = { fn: database[key] });",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.apply alias",
        source: [
          "const fn = database[key];",
          "const invoke = Reflect.apply;",
          "invoke(fn, null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.construct alias",
        source: [
          "const fn = database[key];",
          "const construct = Reflect.construct;",
          "construct(fn, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.get result",
        source: [
          "const fn = Reflect.get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "computed Reflect capability aliases",
        source: [
          "const fn = database[key];",
          'const invoke = Reflect["apply"];',
          'const construct = Reflect["construct"];',
          "invoke(fn, null, []);",
          "construct(fn, []);",
        ].join("\n"),
      },
      {
        name: "Reflect object and destructured aliases",
        source: [
          "const R = Reflect;",
          "const { apply } = R;",
          "const fn = database[key];",
          "apply(fn, null, []);",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `invocation-taint-followup-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject the computed invocation alias: ${JSON.stringify(errors)}`,
      );
    }

    const benignErrors = validateInterpreterSourceFixture(
      "invocation-taint-followup-benign.mts",
      [
        "const v = record[key];",
        "v.trim();",
        "const safe = () => true;",
        "Reflect.apply(safe, null, []);",
        "Reflect.get(record, key);",
        "const Reflect = { apply: () => true, get: () => true };",
        "const invoke = Reflect.apply;",
        "invoke(safe, null, []);",
        "const cleanObject = {};",
        "cleanObject[key] = safe;",
        "const cleanFn = cleanObject.fn;",
        "cleanFn();",
        "const safeXs = [safe, ,];",
        "const safeYs = [...safeXs, safe];",
        "const safeFn = safeYs[2];",
        "safeFn();",
        "let assigned;",
        "[assigned = safe] = [];",
        "assigned();",
        "let safeTmp;",
        "const safeAlias = (safeTmp = safe);",
        "safeAlias();",
        "let safeAssigned;",
        "({ safeAssigned = safe } = {});",
        "safeAssigned();",
        "const sourceObject = { safe };",
        "const copyObject = { ...sourceObject };",
        "copyObject.fn = database[key];",
        "sourceObject.safe();",
        "const sourceArray = [safe];",
        "const copyArray = [...sourceArray];",
        "copyArray[0] = database[key];",
        "const sourceArrayFn = sourceArray[0];",
        "sourceArrayFn();",
      ].join("\n"),
    );
    assert.deepEqual(benignErrors, []);
  });

  it("preserves taint through unknown computed nested receivers", () => {
    const sensitiveCases = [
      {
        name: "object unknown computed receiver",
        source: [
          "const outer = {};",
          "outer[boxKey].fn = database[key];",
          "const fn = outer[boxKey].fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array unknown computed receiver",
        source: [
          "const outer = [];",
          "outer[index].fn = database[key];",
          "const fn = outer[index].fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `invocation-taint-unknown-receiver-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject taint through the computed receiver: ${JSON.stringify(errors)}`,
      );
    }

    const benignErrors = validateInterpreterSourceFixture(
      "invocation-taint-unknown-receiver-benign.mts",
      [
        "const safe = () => true;",
        "const outer = {};",
        "outer[boxKey] = { fn: safe };",
        "const fn = outer[otherKey].fn;",
        "fn();",
        "const recordValue = record[key];",
        "recordValue.trim();",
      ].join("\n"),
    );
    assert.deepEqual(benignErrors, []);
  });

  it("closes conditional containers, indexed writes, undefined defaults, and Reflect indirection", () => {
    const sensitiveCases = [
      {
        name: "conditional object container alias",
        source: [
          "const left = { box: {} };",
          "const right = { box: {} };",
          "const box = flag ? left.box : right.box;",
          "box.fn = database[key];",
          "const fn = left.box.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "conditional object alias reaches right branch",
        source: [
          "const left = { box: {} };",
          "const right = { box: {} };",
          "const box = flag ? left.box : right.box;",
          "box.fn = database[key];",
          "const fn = right.box.fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "conditional array container alias",
        source: [
          "const left = [{}];",
          "const right = [{}];",
          "const box = flag ? left[0] : right[0];",
          "box.fn = database[key];",
          "const fn = left[0].fn;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "indexed numeric write length",
        source: [
          "const safe = () => true;",
          "const xs = [];",
          "xs[2] = safe;",
          "const ys = [...xs, database[key]];",
          "const fn = ys[3];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "indexed numeric string write length",
        source: [
          "const safe = () => true;",
          "const xs = [];",
          'xs["2"] = safe;',
          "const ys = [...xs, database[key]];",
          "const fn = ys[3];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "indexed write with later spread",
        source: [
          "const safe = () => true;",
          "const xs = [];",
          "const tail = [safe];",
          "xs[2] = safe;",
          "const ys = [...xs, ...tail, database[key]];",
          "const fn = ys[4];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "array undefined default",
        source: [
          "const [fn = database[key]] = [undefined];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object undefined default",
        source: [
          "const { fn = database[key] } = { fn: undefined };",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "object void default",
        source: [
          "const { fn = database[key] } = { fn: void 0 };",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "nested undefined default",
        source: [
          "const { outer: { fn = database[key] } = {} } = { outer: { fn: undefined } };",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "conditional undefined default",
        source: [
          "const safe = () => true;",
          "const [fn = database[key]] = [flag ? undefined : safe];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "possibly missing object default",
        source: [
          "const safe = () => true;",
          "const source = flag ? { fn: safe } : {};",
          "const { fn = database[key] } = source;",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.apply call indirection",
        source: [
          "const fn = database[key];",
          "Reflect.apply.call(Reflect, fn, null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply bound indirection",
        source: [
          "const fn = database[key];",
          "const invoke = Reflect.apply.bind(Reflect);",
          "invoke(fn, null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.construct call indirection",
        source: [
          "const fn = database[key];",
          "Reflect.construct.call(Reflect, fn, []);",
        ].join("\n"),
      },
      {
        name: "globalThis Reflect capability",
        source: [
          "const fn = database[key];",
          "globalThis.Reflect.apply(fn, null, []);",
        ].join("\n"),
      },
      {
        name: "destructured Reflect capability",
        source: [
          "const fn = database[key];",
          "const { apply } = Reflect;",
          "apply(fn, null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.get call result",
        source: [
          "const fn = Reflect.get.call(Reflect, database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.get bound result",
        source: [
          "const get = Reflect.get.bind(Reflect);",
          "const fn = get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis Reflect.get bound result",
        source: [
          "const get = globalThis.Reflect.get.bind(globalThis.Reflect);",
          "const fn = get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.apply partially bound target",
        source: [
          "const invoke = Reflect.apply.bind(null, database[key]);",
          "invoke(null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.construct partially bound target",
        source: [
          "const construct = Reflect.construct.bind(null, database[key]);",
          "construct([]);",
        ].join("\n"),
      },
      {
        name: "Reflect.get partially bound receiver and key",
        source: [
          "const get = Reflect.get.bind(null, database, key);",
          "const fn = get();",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.get partially bound receiver",
        source: [
          "const get = Reflect.get.bind(null, database);",
          "const fn = get(key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis computed Reflect partially bound target",
        source: [
          "const invoke = globalThis.Reflect['apply'].bind(null, database[key]);",
          "invoke(null, []);",
        ].join("\n"),
      },
      {
        name: "ambiguous direct and bound Reflect.apply",
        source: [
          "const safe = () => true;",
          "const bound = Reflect.apply.bind(null, database[key]);",
          "const invoke = flag ? bound : Reflect.apply;",
          "invoke(safe, [], []);",
        ].join("\n"),
      },
      {
        name: "ambiguous direct and bound Reflect.construct",
        source: [
          "const safe = () => true;",
          "const bound = Reflect.construct.bind(null, database[key]);",
          "const invoke = flag ? bound : Reflect.construct;",
          "invoke(safe, []);",
        ].join("\n"),
      },
      {
        name: "ambiguous direct and bound Reflect.get",
        source: [
          "const safe = () => true;",
          "const bound = Reflect.get.bind(null, database, key);",
          "const get = flag ? bound : Reflect.get;",
          "const fn = get({ fn: safe }, 'fn');",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "ambiguous direct and indirect Reflect.call",
        source: [
          "const safe = () => true;",
          "const indirect = Reflect.apply.call;",
          "const invoke = flag ? indirect : Reflect.apply;",
          "invoke(Reflect, database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "ambiguous direct and indirect Reflect.apply",
        source: [
          "const safe = () => true;",
          "const indirect = Reflect.apply.apply;",
          "const invoke = flag ? indirect : Reflect.apply;",
          "invoke(Reflect, [database[key], null, []]);",
        ].join("\n"),
      },
      {
        name: "ambiguous capability container alias",
        source: [
          "const safe = () => true;",
          "const direct = Reflect.apply;",
          "const bound = Reflect.apply.bind(null, database[key]);",
          "const invoke = flag ? direct : bound;",
          "invoke(safe, null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis root alias",
        source: [
          "const root = globalThis;",
          "root.Reflect.apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis Reflect destructuring",
        source: [
          "const { Reflect: R } = globalThis;",
          "R.apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis computed Reflect alias chain",
        source: [
          "const root = globalThis;",
          "const R = root['Reflect'];",
          "const apply = R['apply'];",
          "apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis construct and get aliases",
        source: [
          "const root = globalThis;",
          "root.Reflect.construct(database[key], []);",
          "const fn = root.Reflect.get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis undefined default",
        source: [
          "const [fn = database[key]] = [globalThis.undefined];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis undefined alias default",
        source: [
          "const root = globalThis;",
          "const [fn = database[key]] = [root['undefined']];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis direct self alias",
        source: [
          "const root = globalThis.globalThis;",
          "root.Reflect.apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis computed self alias",
        source: [
          "const root = globalThis['globalThis'];",
          "root.Reflect.apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis repeated self alias",
        source: [
          "const root = globalThis.globalThis.globalThis;",
          "root.Reflect.construct(database[key], []);",
        ].join("\n"),
      },
      {
        name: "globalThis repeated computed self alias",
        source: [
          "const root = globalThis['globalThis']['globalThis'];",
          "const fn = root.Reflect.get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis self get alias",
        source: [
          "const root = globalThis.globalThis;",
          "const fn = root.Reflect.get(database, key);",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "Reflect.get globalThis self alias",
        source: [
          "const root = Reflect.get(globalThis, 'globalThis');",
          "root.Reflect.apply(database[key], null, []);",
        ].join("\n"),
      },
      {
        name: "globalThis self undefined default",
        source: [
          "const root = globalThis.globalThis;",
          "const [fn = database[key]] = [root.undefined];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis nested self undefined default",
        source: [
          "const [fn = database[key]] = [globalThis.globalThis.undefined];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
      {
        name: "globalThis computed self undefined default",
        source: [
          "const root = globalThis['globalThis'];",
          "const [fn = database[key]] = [root['undefined']];",
          'fn("DELETE FROM narrative_proposal_revisions");',
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `invocation-taint-round3-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);

      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject the local/shallow bypass: ${JSON.stringify(errors)}`,
      );
    }

    const benignErrors = validateInterpreterSourceFixture(
      "invocation-taint-round3-benign.mts",
      [
        "const safe = () => true;",
        "const left = { box: { fn: safe } };",
        "const right = { box: { fn: safe } };",
        "const box = flag ? left.box : right.box;",
        "box.fn = safe;",
        "left.box.fn();",
        "const spreadCopy = { ...(flag ? left : right) };",
        "spreadCopy.fn = database[key];",
        "left.box.fn();",
        "right.box.fn();",
        "const safeXs = [];",
        "safeXs[2] = safe;",
        "const safeYs = [...safeXs, safe];",
        "const safeFn = safeYs[3];",
        "safeFn();",
        "const nonnumericXs = [];",
        "nonnumericXs.foo = database[key];",
        "const nonnumericYs = [...nonnumericXs, safe];",
        "const nonnumericFn = nonnumericYs[0];",
        "nonnumericFn();",
        "const [definedArray = database[key]] = [safe];",
        "definedArray();",
        "const [nullArray = database[key]] = [null];",
        "nullArray();",
        "const completeSource = flag ? { fn: safe } : { fn: safe };",
        "const { fn: completeFn = database[key] } = completeSource;",
        "completeFn();",
        "const { definedObject = database[key] } = { definedObject: safe };",
        "definedObject();",
        "const { nullObject = database[key] } = { nullObject: null };",
        "nullObject();",
        "Reflect.apply(safe, null, []);",
        "globalThis.Reflect.apply(safe, null, []);",
        "const globalGet = globalThis.Reflect.get.bind(globalThis.Reflect);",
        "const globalSafe = globalGet({ fn: safe }, 'fn');",
        "globalSafe();",
        "const Reflect = { apply: () => true, construct: () => true };",
        "Reflect.apply.call(Reflect, safe, null, []);",
        "Reflect.apply.bind(Reflect)(safe, null, []);",
        "Reflect.construct.call(Reflect, safe, []);",
        "const globalThis = { Reflect: { apply: () => true, construct: () => true, get: () => safe }, undefined: safe, globalThis: { Reflect: { apply: () => true, construct: () => true, get: () => safe }, undefined: safe } };",
        "globalThis.Reflect.apply(safe, null, []);",
        "const shadowGet = globalThis.Reflect.get?.bind(globalThis.Reflect);",
        "shadowGet?.({}, 'fn');",
        "const shadowRoot = globalThis;",
        "shadowRoot.Reflect.apply(safe, null, []);",
        "const [shadowUndefined = database[key]] = [shadowRoot.undefined];",
        "shadowUndefined();",
        "const shadowSelf = globalThis.globalThis;",
        "shadowSelf.Reflect.apply(safe, null, []);",
        "const shadowComputedSelf = globalThis['globalThis'];",
        "const [shadowSelfUndefined = database[key]] = [shadowComputedSelf['undefined']];",
        "shadowSelfUndefined();",
        "const shadowReflectSelf = Reflect.get(globalThis, 'globalThis');",
        "shadowReflectSelf.Reflect.apply(safe, null, []);",
        "const [shadowNestedUndefined = database[key]] = [globalThis.globalThis.undefined];",
        "shadowNestedUndefined();",
        "const partialApply = Reflect.apply.bind(null, safe);",
        "partialApply(null, []);",
        "const partialConstruct = Reflect.construct.bind(null, safe);",
        "partialConstruct([]);",
        "const partialGet = Reflect.get.bind(null, { fn: safe }, 'fn');",
        "const partialSafe = partialGet();",
        "partialSafe();",
        "const unboundApply = Reflect.apply.bind(null);",
        "unboundApply(safe, null, []);",
        "const unboundConstruct = Reflect.construct.bind(null);",
        "unboundConstruct(safe, []);",
        "const unboundGet = Reflect.get.bind(null);",
        "const unboundSafe = unboundGet({ fn: safe }, 'fn');",
        "unboundSafe();",
        "const shadowedPartial = Reflect.apply.bind(null, database[key]);",
        "shadowedPartial(null, []);",
      ].join("\n"),
    );
    assert.deepEqual(benignErrors, []);
  });

  it("rejects indirect call invocations of sensitive database methods", () => {
    const errors = validateInterpreterSourceFixture(
      "indirect-method-call.mts",
      'database.execute.call(database, "DELETE FROM narrative_proposal_revisions");\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*indirect-method-call\.mts/i.test(error)),
      `indirect call database methods must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects indirect apply invocations of sensitive database methods", () => {
    const errors = validateInterpreterSourceFixture(
      "indirect-method-apply.mts",
      'database.execute.apply(database, ["DELETE FROM narrative_proposal_revisions"]);\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*indirect-method-apply\.mts/i.test(error)),
      `indirect apply database methods must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects indirect bind invocations of sensitive database methods", () => {
    const errors = validateInterpreterSourceFixture(
      "indirect-method-bind.mts",
      'database.execute.bind(database)("DELETE FROM narrative_proposal_revisions");\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*indirect-method-bind\.mts/i.test(error)),
      `indirect bind database methods must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("classifies re-exported database modules with the ratified dependency rule", () => {
    const errors = validateInterpreterSourceFixture(
      "reexported-database-module.mts",
      'export { database as storage } from /* comment */ "@/db/client";\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*reexported-database-module\.mts/i.test(error)),
      `re-exported database modules must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects concatenated dynamic loader specifiers", () => {
    const errors = validateInterpreterSourceFixture(
      "concatenated-import.mts",
      [
        'const suffix = "client";',
        'await import("@/db/" + suffix);',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*concatenated-import\.mts/i.test(error)),
      `concatenated dynamic imports must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects interpolated template dynamic loader specifiers", () => {
    const errors = validateInterpreterSourceFixture(
      "interpolated-import.mts",
      [
        'const suffix = "client";',
        "await import(`@/db/${suffix}`);",
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*interpolated-import\.mts/i.test(error)),
      `interpolated template imports must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects computed mutations on call and parenthesized receivers", () => {
    const errors = validateInterpreterSourceFixture(
      "computed-receivers.mts",
      [
        'getStorage()["execute"]("DELETE FROM narrative_proposal_revisions");',
        '(storage)["execute"]("DELETE FROM narrative_proposal_revisions");',
        'storageArray[0]["execute"]("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /db-mutation.*computed-receivers\.mts/i.test(error)),
      `computed mutations on arbitrary receivers must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects sensitive computed calls split by comments and newlines", () => {
    const errors = validateInterpreterSourceFixture(
      "comment-computed-receiver.mts",
      [
        'const storage = getStorage();',
        'storage /* alias */',
        '  ["execute"]?.(',
        '    "DELETE FROM narrative_proposal_revisions",',
        '  );',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /db-mutation.*comment-computed-receiver\.mts/i.test(error)),
      `computed mutation calls split by comments/newlines must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects AST side-effect database imports", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-side-effect-import.mts",
      'import "@/db/client";\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*ast-side-effect-import\.mts/i.test(error)),
      `side-effect database imports must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects AST commented nonliteral dynamic imports", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-commented-dynamic-import.mts",
      [
        'const source = "@/db/client";',
        "await import /* comment */ (source);",
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*ast-commented-dynamic-import\.mts/i.test(error)),
      `commented nonliteral dynamic imports must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects AST concatenated computed mutation properties", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-concatenated-computed-mutation.mts",
      'storage["exec" + "ute"]("DELETE FROM narrative_proposal_revisions");\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*ast-concatenated-computed-mutation\.mts/i.test(error)),
      `concatenated computed database mutations must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects AST template computed mutation properties", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-template-computed-mutation.mts",
      'storage[`exec${"ute"}`]("DELETE FROM narrative_proposal_revisions");\n',
    );

    assert.ok(
      errors.some((error) => /db-mutation.*ast-template-computed-mutation\.mts/i.test(error)),
      `template computed database mutations must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects sensitive property calls on arbitrary receivers", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-property-receivers.mts",
      [
        'storage.execute("DELETE FROM narrative_proposal_revisions");',
        'storage?.execute?.("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /db-mutation.*ast-property-receivers\.mts/i.test(error)),
      `property database mutations on arbitrary receivers must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("keeps AST deny semantics when policy regexes are disabled", () => {
    const errors = validateInterpreterSourceFixture(
      "ast-policy-disabled.mts",
      [
        'import "@/db/client";',
        'const source = "@/db/client";',
        "await import /* comment */ (source);",
        'storage["exec" + "ute"]("DELETE FROM narrative_proposal_revisions");',
      ].join("\n"),
      (contract) => {
        for (const rule of contract.interpreterBoundary.forbiddenDependencies) {
          rule.patterns = ["(?!)"];
        }
      },
    );

    assert.ok(
      errors.some((error) => /db-mutation.*ast-policy-disabled\.mts/i.test(error)),
      `AST computed-property semantics must not be policy-disabled: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /non-literal-dynamic-import.*ast-policy-disabled\.mts/i.test(error)),
      `AST dynamic-import semantics must not be policy-disabled: ${JSON.stringify(errors)}`,
    );
  });

  it("fails closed when an Interpreter source has AST parse diagnostics", () => {
    const errors = validateInterpreterSourceFixture(
      "malformed-interpreter.mts",
      "const broken = ;\n",
    );

    assert.ok(
      errors.some((error) => /AST parse diagnostics.*malformed-interpreter\.mts/i.test(error)),
      `malformed production sources must fail closed: ${JSON.stringify(errors)}`,
    );
  });

  it("detects an unauthorized local Freshness authority in code", () => {
    const root = minimalFixtureRoot();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    const interpreterRoot = "src/features/narrative-extraction/ir";
    contract.interpreterBoundary.interpreterRoots = [interpreterRoot];
    mkdirSync(path.join(root, interpreterRoot), { recursive: true });
    writeFileSync(
      path.join(root, interpreterRoot, "second-authority.ts"),
      [
        'export const localFreshnessStore = new Map();',
        'export const freshnessCache = new Map();',
        'export const featureFreshnessReadModel = { isFresh: true };',
        'export const freshnessAuthority = "local";',
      ].join("\n"),
    );
    const errors = [];

    validateInterpreterBoundary(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(
      errors.some((error) => /unauthorized freshness authority/i.test(error)),
    );
    assert.ok(errors.some((error) => /second-authority\.ts/i.test(error)));
  });

  it("normalizes escaped identifiers for writer and Freshness authority scans", () => {
    const errors = validateInterpreterSourceFixture(
      "escaped-authority-identifiers.ts",
      [
        "const localFreshness\\u0053tore = new Map();",
        "const typed\\u0057riter = { commit() {} };",
        "typed\\u0057riter.commit({});",
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /freshness-store.*escaped-authority-identifiers\.ts/i.test(error)),
      `escaped Freshness identifiers must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /typed-writer.*escaped-authority-identifiers\.ts/i.test(error)),
      `escaped writer identifiers must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("does not scan escaped authority vocabulary inside strings, comments, or safe shadowing controls", () => {
    const errors = validateInterpreterSourceFixture(
      "escaped-authority-controls.ts",
      [
        "const label = 'localFreshness\\u0053tore';",
        "// typed\\u0057riter.commit({});",
        "function shadowed(value) { const local = value; return local; }",
        "shadowed('safe');",
      ].join("\n"),
    );

    assert.deepEqual(errors, [], `controls must remain allowed: ${JSON.stringify(errors)}`);
  });

  it("normalizes escaped static computed authority keys in executable positions", () => {
    const errors = validateInterpreterSourceFixture(
      "escaped-computed-authority-keys.ts",
      [
        'const registry = { ["typed\\u0057riter"]: true };',
        'registry["typed\\u0057riter"] = true;',
        'const state = { ["localFreshness\\u0053tore"]: new Map() };',
        'const safe = { ["safeKey"]: true };',
        'safe["safeKey"];',
        'const label = "typed\\u0057riter";',
        '// registry["localFreshness\\u0053tore"]',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /typed-writer.*escaped-computed-authority-keys\.ts/i.test(error)),
      `escaped computed writer keys must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /freshness-store.*escaped-computed-authority-keys\.ts/i.test(error)),
      `escaped computed Freshness keys must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("normalizes quoted static authority keys in executable positions", () => {
    const errors = validateInterpreterSourceFixture(
      "quoted-static-authority-keys.ts",
      [
        'export const state = { "localFreshness\\u0053tore": new Map() };',
        'export const services = { "typed\\u0057riter": { commit() {} } };',
        'export const methods = { "typed\\u0057riter"() {} };',
        'class Helper { "localFreshness\\u0053tore" = new Map(); "typed\\u0057riter"() {} }',
        'const safe = { "safeKey": true };',
        'const label = "typed\\u0057riter";',
        '// const ignored = { "localFreshness\\u0053tore": new Map() };',
      ].join("\n"),
    );

    assert.ok(
      errors.some((error) => /freshness-store.*quoted-static-authority-keys\.ts/i.test(error)),
      `quoted Freshness keys must be rejected: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /typed-writer.*quoted-static-authority-keys\.ts/i.test(error)),
      `quoted writer keys must be rejected: ${JSON.stringify(errors)}`,
    );
  });

  it("tracks tainted arguments into invoked local function parameters", () => {
    const sensitiveCases = [
      {
        name: "function declaration",
        source: [
          "function invoke(fn) { fn(); }",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "destructured rest after fixed parameter",
        source: [
          "function invoke(label, ...[fn]) { fn(); }",
          'invoke("safe", database[key]);',
        ].join("\n"),
      },
      {
        name: "function expression",
        source: [
          "const invoke = function (fn) { fn(); };",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "arrow function",
        source: [
          "const invoke = (fn) => fn();",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "local declaration chain",
        source: [
          "function leaf(fn) { fn(); }",
          "function invoke(fn) { leaf(fn); }",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "Function.prototype call",
        source: [
          "function invoke(fn) { fn(); }",
          "invoke.call(null, database[key]);",
        ].join("\n"),
      },
      {
        name: "Function.prototype apply",
        source: [
          "function invoke(fn) { fn(); }",
          "invoke.apply(null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Function.prototype bind alias",
        source: [
          "function invoke(fn) { fn(); }",
          "const alias = invoke.bind(null);",
          "alias(database[key]);",
        ].join("\n"),
      },
      {
        name: "class static method",
        source: [
          "class Helper { static invoke(fn) { fn(); } }",
          "Helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class instance method",
        source: [
          "class Helper { invoke(fn) { fn(); } }",
          "const helper = new Helper();",
          "helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "object method receiver forwarding",
        source: [
          "const api = { invoke(fn) { this.consume(fn); }, consume(fn) { fn(); } };",
          "api.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class static receiver forwarding",
        source: [
          "class Helper { static invoke(fn) { this.consume(fn); } static consume(fn) { fn(); } }",
          "Helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply local function",
        source: [
          "function invoke(fn) { fn(); }",
          "Reflect.apply(invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply alias local function",
        source: [
          "function invoke(fn) { fn(); }",
          "const apply = Reflect.apply;",
          "apply(invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.construct local class",
        source: [
          "class Helper { constructor(fn) { fn(); } }",
          "Reflect.construct(Helper, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "object assignment destructuring",
        source: [
          "function invoke(arg) { let fn; ({ fn } = arg); fn(); }",
          "invoke({ fn: database[key] });",
        ].join("\n"),
      },
      {
        name: "renamed nested assignment destructuring",
        source: [
          "function invoke(arg) { let local; ({ nested: { fn: local } } = arg); local(); }",
          "invoke({ nested: { fn: database[key] } });",
        ].join("\n"),
      },
      {
        name: "array assignment destructuring",
        source: [
          "function invoke(arg) { let fn; [fn] = arg; fn(); }",
          "invoke([database[key]]);",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `local-call-capability-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject a tainted invoked parameter: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("keeps safe callbacks, non-invoked parameters, shadowing, and recursive cycles bounded", () => {
    const errors = validateInterpreterSourceFixture(
      "local-call-capability-controls.mts",
      [
        "const safe = () => true;",
        "function invoke(fn) { fn(); }",
        "invoke(safe);",
        "function observe(fn) { return fn; }",
        "observe(database[key]);",
        "function shadowed(fn) {",
        "  { const fn = () => true; fn(); }",
        "}",
        "shadowed(database[key]);",
        "function recursive(fn) { recursive(fn); }",
        "recursive(database[key]);",
        "function mutualA(fn) { mutualB(fn); }",
        "function mutualB(fn) { mutualA(fn); }",
        "mutualA(database[key]);",
      ].join("\n"),
    );

    assert.deepEqual(
      errors,
      [],
      `safe and bounded local calls must remain allowed: ${JSON.stringify(errors)}`,
    );
  });

  it("tracks local callable aliases, object methods, destructured capabilities, and returns", () => {
    const sensitiveCases = [
      {
        name: "local function alias",
        source: [
          "function invoke(fn) { fn(); }",
          "const alias = invoke;",
          "alias(database[key]);",
        ].join("\n"),
      },
      {
        name: "object method",
        source: [
          "const api = { invoke(fn) { fn(); } };",
          "api.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "destructured object method",
        source: [
          "const api = { invoke: (fn) => fn() };",
          "const { invoke } = api;",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "object destructured parameter",
        source: [
          "function invoke({ fn }) { fn(); }",
          "invoke({ fn: database[key] });",
        ].join("\n"),
      },
      {
        name: "array destructured parameter",
        source: [
          "function invoke([fn]) { fn(); }",
          "invoke([database[key]]);",
        ].join("\n"),
      },
      {
        name: "destructured parameter default",
        source: [
          "function invoke({ fn = database[key] } = {}) { fn(); }",
          "invoke({});",
        ].join("\n"),
      },
      {
        name: "returned capability",
        source: [
          "function identity(fn) { return fn; }",
          "identity(database[key])();",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `local-call-capability-extension-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject a tainted capability flow: ${JSON.stringify(errors)}`,
      );
    }
  });

  it("keeps local callable extensions safe under callbacks, shadowing, and cycles", () => {
    const errors = validateInterpreterSourceFixture(
      "local-call-capability-extension-controls.mts",
      [
        "const safe = () => true;",
        "function invoke(fn) { fn(); }",
        "const alias = invoke;",
        "alias(safe);",
        "const api = { invoke(fn) { fn(); } };",
        "api.invoke(safe);",
        "function observe({ fn }) { return fn; }",
        "observe({ fn: safe });",
        "function shadow(fn) {",
        "  { const fn = () => true; fn(); }",
        "}",
        "shadow(database[key]);",
        "function recursive(fn) { return recursive(fn); }",
        "recursive(database[key]);",
        "function passthrough(fn) { return fn; }",
        "passthrough(database[key]);",
        "function observeRest(label, ...[fn]) { return fn; }",
        'observeRest("safe", database[key]);',
        "invoke.call(null, () => true);",
        "invoke.apply(null, [() => true]);",
        "const safeAlias = invoke.bind(null);",
        "safeAlias(() => true);",
        "function invokeRest(label, ...[fn]) { fn(); }",
        'invokeRest("safe", () => true);',
        "function assignSafe(arg) { let fn; ({ fn } = arg); fn(); }",
        "assignSafe({ fn: () => true });",
        "const safeApi = { invoke(fn) { this.consume(fn); }, consume(fn) { fn(); } };",
        "safeApi.invoke(() => true);",
        "Reflect.apply(invoke, null, [() => true]);",
        "const safeApply = Reflect.apply;",
        "safeApply(invoke, null, [() => true]);",
        "class SafeHelper { constructor(fn) { fn(); } }",
        "Reflect.construct(SafeHelper, [() => true]);",
      ].join("\n"),
    );

    assert.deepEqual(
      errors,
      [],
      `safe local callable extensions must remain allowed: ${JSON.stringify(errors)}`,
    );
  });

  it("tracks class fields, getter-returned callables, and Reflect call composition", () => {
    const sensitiveCases = [
      {
        name: "instance arrow field",
        source: [
          "class Helper { invoke = (fn) => fn(); }",
          "new Helper().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "static arrow field",
        source: [
          "class Helper { static invoke = (fn) => fn(); }",
          "Helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "instance function field",
        source: [
          "class Helper { invoke = function (fn) { fn(); }; }",
          "new Helper().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "static function field",
        source: [
          "class Helper { static invoke = function (fn) { fn(); }; }",
          "Helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "object getter returning callable",
        source: [
          "const api = { get invoke() { return (fn) => fn(); } };",
          "api.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class getter returning callable",
        source: [
          "class Helper { get invoke() { return (fn) => fn(); } }",
          "new Helper().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class static getter returning callable",
        source: [
          "class Helper { static get invoke() { return (fn) => fn(); } }",
          "Helper.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply local function",
        source: [
          "function invoke(fn) { fn(); }",
          "Reflect.apply(invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply alias",
        source: [
          "function invoke(fn) { fn(); }",
          "const apply = Reflect.apply;",
          "apply(invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.construct local class",
        source: [
          "class Helper { constructor(fn) { fn(); } }",
          "Reflect.construct(Helper, [database[key]]);",
        ].join("\n"),
      },
    ];

    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `local-call-composition-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject a tainted callable flow: ${JSON.stringify(errors)}`,
      );
    }

    const safeErrors = validateInterpreterSourceFixture(
      "local-call-composition-controls.mts",
      [
        "function invoke(fn) { fn(); }",
        "invoke.call(null, () => true);",
        "invoke.apply(null, [() => true]);",
        "const safeApply = Reflect.apply;",
        "safeApply(invoke, null, [() => true]);",
        "class SafeHelper { constructor(fn) { fn(); } }",
        "Reflect.construct(SafeHelper, [() => true]);",
        "const safeApi = { get invoke() { return (fn) => fn(); } };",
        "safeApi.invoke(() => true);",
      ].join("\n"),
    );
    assert.deepEqual(
      safeErrors,
      [],
      `safe callable composition must remain allowed: ${JSON.stringify(safeErrors)}`,
    );
  });

  it("tracks direct constructor calls and order-independent callable alternatives", () => {
    const constructorCases = [
      {
        name: "direct constructor",
        source: [
          "class Unsafe { constructor(fn) { fn(); } }",
          "new Unsafe(database[key]);",
        ].join("\n"),
      },
      {
        name: "constructor default",
        source: [
          "class Unsafe { constructor(fn = database[key]) { fn(); } }",
          "new Unsafe();",
        ].join("\n"),
      },
      {
        name: "constructor rest destructuring",
        source: [
          "class Unsafe { constructor(label, ...[fn]) { fn(); } }",
          'new Unsafe("safe", database[key]);',
        ].join("\n"),
      },
      {
        name: "constructor object destructuring",
        source: [
          "class Unsafe { constructor({ fn }) { fn(); } }",
          "new Unsafe({ fn: database[key] });",
        ].join("\n"),
      },
      {
        name: "constructor this forwarding",
        source: [
          "class Unsafe { consume(fn) { fn(); } constructor(fn) { this.consume(fn); } }",
          "new Unsafe(database[key]);",
        ].join("\n"),
      },
    ];
    for (const [index, testCase] of constructorCases.entries()) {
      const filename = `local-constructor-flow-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject a tainted constructor flow: ${JSON.stringify(errors)}`,
      );
    }

    const conditionalSources = [
      [
        "class Safe { constructor(fn) {} }",
        "class Unsafe { constructor(fn) { fn(); } }",
        "const H = flag ? Safe : Unsafe;",
        "Reflect.construct(H, [database[key]]);",
      ].join("\n"),
      [
        "class Safe { constructor(fn) {} }",
        "class Unsafe { constructor(fn) { fn(); } }",
        "const H = flag ? Unsafe : Safe;",
        "Reflect.construct(H, [database[key]]);",
      ].join("\n"),
      [
        "const safeGetter = { get invoke() { return (fn) => true; } };",
        "const unsafeGetter = { get invoke() { return (fn) => fn(); } };",
        "const api = flag ? safeGetter : unsafeGetter;",
        "api.invoke(database[key]);",
      ].join("\n"),
      [
        "const safeGetter = { get invoke() { return (fn) => true; } };",
        "const unsafeGetter = { get invoke() { return (fn) => fn(); } };",
        "const api = flag ? unsafeGetter : safeGetter;",
        "api.invoke(database[key]);",
      ].join("\n"),
    ];
    for (const [index, source] of conditionalSources.entries()) {
      const filename = `local-alternative-order-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `conditional alternative ${index} must reject a tainted callable flow: ${JSON.stringify(errors)}`,
      );
    }

    const safeErrors = validateInterpreterSourceFixture(
      "local-constructor-flow-controls.mts",
      [
        "class Safe { constructor(fn) { fn(); } }",
        "new Safe(() => true);",
        "class SafeDefault { constructor(fn = () => true) { fn(); } }",
        "new SafeDefault();",
        "class SafeRest { constructor(label, ...[fn]) { fn(); } }",
        'new SafeRest("safe", () => true);',
        "class SafeDestructure { constructor({ fn }) { fn(); } }",
        "new SafeDestructure({ fn: () => true });",
        "class SafeThis { consume(fn) { fn(); } constructor(fn) { this.consume(fn); } }",
        "new SafeThis(() => true);",
      ].join("\n"),
    );
    assert.deepEqual(
      safeErrors,
      [],
      `safe constructor flows must remain allowed: ${JSON.stringify(safeErrors)}`,
    );
  });

  it("composes bound wrappers, inherited receivers, and bounded local depth", () => {
    const sensitiveCases = [
      {
        name: "nested bind",
        source: [
          "function invoke(fn) { fn(); }",
          "invoke.bind(null, database[key]).bind(null)();",
        ].join("\n"),
      },
      {
        name: "bound call",
        source: [
          "function invoke(fn) { fn(); }",
          "const bound = invoke.bind(null, database[key]);",
          "bound.call(null);",
        ].join("\n"),
      },
      {
        name: "bound Function.call wrapper",
        source: [
          "function consume(label, fn) { fn(); }",
          "const bound = consume.call.bind(consume, null);",
          "bound(database[key]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply.call",
        source: [
          "function invoke(fn) { fn(); }",
          "Reflect.apply.call(null, invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply.apply",
        source: [
          "function invoke(fn) { fn(); }",
          "Reflect.apply.apply(null, [invoke, null, [database[key]]]);",
        ].join("\n"),
      },
      {
        name: "bound Reflect.apply wrapper",
        source: [
          "function invoke(fn) { fn(); }",
          "const apply = Reflect.apply.bind(null);",
          "apply.call(null, invoke, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "getter bound this",
        source: [
          "const api = { consume(fn) { fn(); }, get invoke() { return this.consume.bind(this); } };",
          "api.invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class field bound receiver",
        source: [
          "class Helper { consume(fn) { fn(); } invoke = this.consume.bind(this); }",
          "new Helper().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "class field receiver alias",
        source: [
          "class Helper { consume(fn) { fn(); } invoke = this.consume; }",
          "new Helper().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "inherited method",
        source: [
          "class Base { invoke(fn) { fn(); } }",
          "class Derived extends Base {}",
          "new Derived().invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "six-level wrapper",
        source: [
          "function one(fn) { two(fn); }",
          "function two(fn) { three(fn); }",
          "function three(fn) { four(fn); }",
          "function four(fn) { five(fn); }",
          "function five(fn) { six(fn); }",
          "function six(fn) { fn(); }",
          "one(database[key]);",
        ].join("\n"),
      },
    ];
    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `local-wrapper-composition-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      assert.ok(
        errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error)),
        `${testCase.name} must reject a tainted callable flow: ${JSON.stringify(errors)}`,
      );
    }

    const safeErrors = validateInterpreterSourceFixture(
      "local-wrapper-composition-controls.mts",
      [
        "function invoke(fn) { fn(); }",
        "invoke.bind(null, () => true).bind(null)();",
        "const safeBound = invoke.bind(null, () => true);",
        "safeBound.call(null);",
        "Reflect.apply.call(null, invoke, null, [() => true]);",
        "Reflect.apply.apply(null, [invoke, null, [() => true]]);",
        "function consume(label, fn) { fn(); }",
        "const safeCall = consume.call.bind(consume, null);",
        "safeCall(() => true);",
        "const safeApplyBound = Reflect.apply.bind(null);",
        "safeApplyBound.call(null, invoke, null, [() => true]);",
        "const safeApi = { consume(fn) { fn(); }, get invoke() { return this.consume.bind(this); } };",
        "safeApi.invoke(() => true);",
        "class SafeAlias { consume(fn) { fn(); } invoke = this.consume; }",
        "new SafeAlias().invoke(() => true);",
        "class SafeBase { invoke(fn) { fn(); } }",
        "class SafeDerived extends SafeBase {}",
        "new SafeDerived().invoke(() => true);",
      ].join("\n"),
    );
    assert.deepEqual(
      safeErrors,
      [],
      `safe wrapper composition must remain allowed: ${JSON.stringify(safeErrors)}`,
    );
  });

  it("preserves bounded call/apply and Reflect bind composition", () => {
    const sensitiveCases = [
      {
        name: "Function.call bound around a local callable",
        source: [
          "function consume(fn) { fn(); }",
          "const invoke = consume.call.bind(consume, null);",
          "invoke(database[key]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply bound target through call",
        source: [
          "function consume(fn) { fn(); }",
          "const invoke = Reflect.apply.bind(null, consume);",
          "invoke.call(null, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply bound target through apply",
        source: [
          "function consume(fn) { fn(); }",
          "const invoke = Reflect.apply.bind(null, consume);",
          "invoke.apply(null, [null, [database[key]]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply fully bound arguments through apply",
        source: [
          "function consume(fn) { fn(); }",
          "const invoke = Reflect.apply.bind(null, consume, null, [database[key]]);",
          "invoke.apply(null, []);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply call bind composition",
        source: [
          "function consume(fn) { fn(); }",
          "Reflect.apply.call.bind(Reflect.apply, Reflect)(consume, null, [database[key]]);",
        ].join("\n"),
      },
      {
        name: "Reflect.apply fully bound target call",
        source: [
          "function consume(fn) { fn(); }",
          "Reflect.apply.bind(null, consume, null, [database[key]]).call(null);",
        ].join("\n"),
      },
    ];

    const failures = [];
    for (const [index, testCase] of sensitiveCases.entries()) {
      const filename = `local-wrapper-reflect-composition-${index}.mts`;
      const errors = validateInterpreterSourceFixture(filename, testCase.source);
      if (!errors.some((error) => new RegExp(`db-mutation.*${filename}`, "i").test(error))) {
        failures.push(`${testCase.name}: ${JSON.stringify(errors)}`);
      }
    }
    assert.deepEqual(failures, [], `bounded wrapper cases must reject: ${JSON.stringify(failures)}`);

    const safeErrors = validateInterpreterSourceFixture(
      "local-wrapper-reflect-composition-controls.mts",
      [
        "function consume(fn) { fn(); }",
        "const invoke = consume.call.bind(consume, null);",
        "invoke(() => true);",
        "const apply = Reflect.apply.bind(null, consume);",
        "apply.call(null, null, [() => true]);",
        "apply.apply(null, [null, [() => true]]);",
        "const fullyBoundApply = Reflect.apply.bind(null, consume, null, [() => true]);",
        "fullyBoundApply.apply(null, []);",
        "Reflect.apply.call.bind(Reflect.apply, Reflect)(consume, null, [() => true]);",
        "Reflect.apply.bind(null, consume, null, [() => true]).call(null);",
      ].join("\n"),
    );
    assert.deepEqual(
      safeErrors,
      [],
      `safe bounded wrapper composition must remain allowed: ${JSON.stringify(safeErrors)}`,
    );
  });

  it("rejects an Interpreter boundary with no roots or no deny rules", () => {
    const root = minimalFixtureRoot();
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    contract.interpreterBoundary.interpreterRoots = [];
    contract.interpreterBoundary.forbiddenDependencies = [];
    contract.interpreterBoundary.forbiddenFreshnessAuthorityPatterns = [];
    const errors = [];

    validateInterpreterBoundary(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(errors.some((error) => /must declare interpreterRoots/i.test(error)));
    assert.ok(
      errors.some((error) => /must declare forbidden dependencies/i.test(error)),
    );
    assert.ok(
      errors.some((error) => /must declare freshness authority patterns/i.test(error)),
    );
  });

  it("does not let the Interpreter policy shrink roots or replace deny semantics", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    contract.interpreterBoundary.interpreterRoots = contract.interpreterBoundary.interpreterRoots.filter(
      (root) => root !== "src/features/narrative-extraction/reconciler",
    );
    contract.interpreterBoundary.forbiddenDependencies.find(
      (rule) => rule.id === "sql-import",
    ).patterns = ["(?!)"];
    contract.interpreterBoundary.forbiddenDependencies.find(
      (rule) => rule.id === "non-literal-dynamic-import",
    ).patterns = ["(?!)"];
    const errors = [];

    validateInterpreterBoundary(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) =>
        /ratified required roots.*narrative-extraction\/reconciler/i.test(
          error,
        ),
      ),
      `expected the ratified reconciler root to remain mandatory: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /ratified.*forbidden dependency patterns.*sql-import/i.test(error)),
      `expected the ratified SQL import deny semantics to remain mandatory: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /ratified.*forbidden dependency patterns.*non-literal-dynamic-import/i.test(error)),
      `expected nonliteral dynamic import deny semantics to remain mandatory: ${JSON.stringify(errors)}`,
    );
  });

  it("does not let the Interpreter allowlist hide files or broaden type-only imports", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    contract.interpreterBoundary.allowlist.files = [
      "src/features/narrative-extraction/reconciler/stageExecution.ts",
    ];
    contract.interpreterBoundary.allowlist.imports.find(
      (entry) => entry.id === "type-only-domain-vocabulary",
    ).pattern = ".*";
    const errors = [];

    validateInterpreterBoundary(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) => /ratified Interpreter allowlist files/i.test(error)),
      `expected the allowlist file set to remain ratified: ${JSON.stringify(errors)}`,
    );
    assert.ok(
      errors.some((error) => /ratified Interpreter allowlist import.*type-only-domain-vocabulary/i.test(error)),
      `expected the allowlist import pattern to remain ratified: ${JSON.stringify(errors)}`,
    );
  });

  it("pins every required artifact's lifecycle and authority classification", () => {
    const original = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    for (const artifact of original.artifacts) {
      for (const field of [
        "lifecycle",
        "authority",
        "authoritative",
        "storage",
        "retention.default",
        "retention.scope",
      ]) {
        const contract = structuredClone(original);
        const candidate = contract.artifacts.find(
          (entry) => entry.id === artifact.id,
        );
        if (field === "lifecycle") {
          candidate[field] = artifact.lifecycle === "durable" ? "ephemeral" : "durable";
        } else if (field === "authority") {
          candidate[field] = artifact.authority === "none" ? "source-identity" : "none";
        } else if (field === "retention.scope") {
          candidate.retention.scope = `${artifact.retention.scope}-mutated`;
        } else if (field === "storage") {
          candidate.storage = `${artifact.storage}-mutated`;
        } else if (field === "retention.default") {
          candidate.retention.default =
            artifact.retention.default === "retained"
              ? "not-retained"
              : "retained";
        } else {
          candidate[field] = !artifact.authoritative;
        }
        const errors = [];

        validateArtifactAuthorityContract(REPO_ROOT, contract, errors);

        assert.ok(
          errors.some((error) =>
            new RegExp(`artifact ${artifact.id}.*ratified`, "i").test(error),
          ),
          `expected ${artifact.id}.${field} mutation to fail closed: ${JSON.stringify(errors)}`,
        );
      }
    }
  });

  it("rejects an appended authority kind outside the ratified vocabulary", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    contract.authorityKinds.push("future-authority");
    const errors = [];

    validateArtifactAuthorityContract(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) => /authority kinds.*ratified/i.test(error)),
      `appended authority kinds must fail closed: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects a new authoritative artifact row outside the ratified matrix", () => {
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-artifact-authority.json",
        ),
        "utf8",
      ),
    );
    contract.artifacts.push({
      id: "future-authority-artifact",
      lifecycle: "durable",
      authority: "review",
      authoritative: true,
      storage: "future-authority-storage",
      retention: {default: "retained", scope: "project-scoped"},
    });
    const errors = [];

    validateArtifactAuthorityContract(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) => /artifact ids.*ratified/i.test(error)),
      `appended artifact rows must fail closed: ${JSON.stringify(errors)}`,
    );
  });

  it("rejects strict Scope containment and unresolved-reason identity", () => {
    const contract = structuredClone(
      JSON.parse(
        readFileSync(
          path.join(
            REPO_ROOT,
            "policies/narrative/narrative-scope-relation-contract.json",
          ),
          "utf8",
        ),
      ),
    );
    contract.relationSemantics.containsIsStrict = true;
    contract.unresolvedSemantics.reasonAloneEstablishesIdentity = true;
    const errors = [];

    validateScopeRelationContract(REPO_ROOT, contract, errors);

    assert.ok(
      errors.some((error) => /must not claim strict containment/i.test(error)),
    );
    assert.ok(
      errors.some((error) => /reason alone must not establish/i.test(error)),
    );
  });

  it("rejects ordinary Catalog drift mapped to unknown and a versioned dependencyKey", () => {
    const readPolicy = (relativePath) =>
      JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
    const contract = structuredClone(
      readPolicy("policies/narrative/narrative-dependency-role-registry.json"),
    );
    const catalogRule = contract.effectRules.find(
      (rule) => rule.id === "entity-resolution-input-changed",
    );
    catalogRule.freshness = "unknown";
    contract.dependencyKey.hashComponents = [
      "role-contract-version",
      "dependency-role",
      "canonical-selector",
    ];
    const errors = [];

    validateDependencyRoleContract(
      REPO_ROOT,
      contract,
      readPolicy("policies/narrative/semantic-state-vocabulary.json"),
      readPolicy("policies/narrative/narrative-finding-contract.json"),
      readPolicy("policies/narrative/narrative-consumer-contract.json"),
      errors,
    );

    assert.ok(errors.some((error) => /uses unknown outside/i.test(error)));
    assert.ok(
      errors.some((error) => /must map to stale\/resolve-only/i.test(error)),
    );
    assert.ok(
      errors.some((error) =>
        /must exclude the role contract version/i.test(error),
      ),
    );
  });

  it("rejects a declared contract with a production marker", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "scope-implementation-status-"),
    );
    const sourceRoot = "src/features/narrative-semantic-core";
    mkdirSync(path.join(root, sourceRoot), { recursive: true });
    writeFileSync(
      path.join(root, sourceRoot, "scopeV2.ts"),
      "export const NARRATIVE_SCOPE_V2_SCHEMA_VERSION = 2;\n",
    );
    const contract = JSON.parse(
      readFileSync(
        path.join(
          REPO_ROOT,
          "policies/narrative/narrative-scope-relation-contract.json",
        ),
        "utf8",
      ),
    );
    contract.implementationStatus.scanRoots = [sourceRoot];
    const errors = [];

    validateScopeRelationContract(root, contract, errors);
    rmSync(root, { recursive: true, force: true });

    assert.ok(
      errors.some((error) =>
        /declared but production markers are wired/i.test(error),
      ),
    );
  });

  it("fails closed for an unknown route and a forbidden interpreter import", () => {
    const root = minimalFixtureRoot();
    const baseline = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !baseline.errors.some((error) => /unknown authority route/i.test(error)),
      "the fixture must not already contain an unknown route finding",
    );
    assert.ok(
      !baseline.errors.some((error) =>
        /agent writer or domain api directly/i.test(error),
      ),
      "the fixture must not already contain a direct-call finding",
    );
    const manifest = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.operations[0].authorityRoute = "unknown";
    writeFileSync(manifest, JSON.stringify(parsed));
    mkdirSync(path.join(root, "src/features/narrative-extraction/reconciler"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "src/features/narrative-extraction/reconciler/bad.ts"),
      'import { agentCreateCodexEntry } from "@/features/agent-writes/codex";\nimport { createCodexEntry } from "@/features/codex/api";\ninvoke("agent_chronicle_bulk_mutate");\nexecute("ai_tree_plan_apply");\ninvoke(\n  "agent_chronicle_multiline",\n);\n',
    );
    mkdirSync(path.join(root, "src-tauri/crates/grimodex-semantic/src"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "src-tauri/crates/grimodex-semantic/src/bad.rs"),
      "use grimodex_db::agent_writes::agent_codex_create_impl;\nfn bad() { agent_writes::agent_codex_create_impl(); }\n",
    );

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => /unknown authority route/i.test(error)),
    );
    assert.ok(
      result.errors.some((error) =>
        /forbidden.*agent writer|interpreter.*agent/i.test(error),
      ),
    );
    assert.ok(
      result.errors.some((error) => /Domain API directly/i.test(error)),
    );
    assert.ok(
      result.errors.some((error) =>
        /agent writer or domain api directly/i.test(error),
      ),
      "direct Chronicle and AI Tree command calls must stay inside the typed boundary",
    );
  });

  it("validates every authority variant instead of trusting one static label", () => {
    const root = minimalFixtureRoot();
    const baseline = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !baseline.errors.some((error) => /unknown authority route/i.test(error)),
      "the fixture must not already contain an unknown route finding",
    );
    const manifest = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.operations[0].authorityVariants = [
      { authorityRoute: "unknown-route", controls: [] },
    ];
    writeFileSync(manifest, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) => /unknown authority route/i.test(error)),
    );
  });

  it("fails closed when an interactive Agent operation omits field authority", () => {
    const root = minimalFixtureRoot();
    const baseline = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !baseline.errors.some((error) =>
        error.includes("missing required control 'field-authority'"),
      ),
      "the fixture must not already omit field authority",
    );
    const manifest = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.operations[0].authorityRoute = "interactive-agent-command";
    parsed.operations[0].controls = ["typed-writer"];
    writeFileSync(manifest, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes("missing required control 'field-authority'"),
      ),
    );
  });

  it("rejects caller allowlist overlap and required/conditional control overlap", () => {
    const root = minimalFixtureRoot();
    const registry = path.join(
      root,
      "policies/narrative/mutation-authority-routes.json",
    );
    const parsed = JSON.parse(readFileSync(registry, "utf8"));
    parsed.routes[0].allowedCallers = ["fixture-caller", "fixture-caller"];
    parsed.routes[0].forbiddenCallers = ["fixture-caller"];
    parsed.routes[0].conditionalControls = [
      { control: "typed-writer", when: "fixture-condition" },
    ];
    writeFileSync(registry, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        /allowedCallers must be unique/i.test(error),
      ),
    );
    assert.ok(result.errors.some((error) => /must be disjoint/i.test(error)));
    assert.ok(
      result.errors.some((error) =>
        /both required and conditional/i.test(error),
      ),
    );
  });

  it("fails closed when a mutation command is not registered", () => {
    const root = minimalFixtureRoot();
    writeFileSync(
      path.join(root, "electron/shared/fixture.ts"),
      "const handlers = {\n  fixture_unknown: {},\n};\n",
    );

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "unregistered mutation command electron-ipc:fixture_unknown",
        ),
      ),
    );
  });

  it("does not allow the manifest to shrink the minimum boundary scan roots", () => {
    const root = minimalFixtureRoot();
    const baseline = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !baseline.errors.some((error) =>
        error.includes(
          "semanticBoundary.scanRoots is missing required minimum root: electron/main",
        ),
      ),
      "the fixture must include the full minimum root set before mutation",
    );
    const manifest = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    parsed.semanticBoundary.scanRoots =
      parsed.semanticBoundary.scanRoots.filter(
        (relativeRoot) => relativeRoot !== "electron/main",
      );
    writeFileSync(manifest, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "semanticBoundary.scanRoots is missing required minimum root: electron/main",
        ),
      ),
    );
  });

  it("rejects a declared required root that is absent on disk", () => {
    const root = minimalFixtureRoot();
    rmSync(path.join(root, "electron/main"), { recursive: true, force: true });

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "semanticBoundary required scan root is missing or not a directory: electron/main",
        ),
      ),
    );
  });

  it("accepts contributionTargetStates and maintenanceOwnershipStates when both are fully populated", () => {
    const root = minimalFixtureRoot();

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !result.errors.some((error) =>
        error.includes("contributionTargetStates"),
      ),
      `unexpected contributionTargetStates error: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      !result.errors.some((error) =>
        error.includes("maintenanceOwnershipStates"),
      ),
      `unexpected maintenanceOwnershipStates error: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      !result.errors.some((error) => /mixed across axes/i.test(error)),
      `unexpected axis overlap error: ${JSON.stringify(result.errors)}`,
    );
  });

  it("fails closed when contributionTargetStates is missing one of the six Rust states", () => {
    const root = minimalFixtureRoot();
    const vocabulary = path.join(
      root,
      "policies/narrative/semantic-state-vocabulary.json",
    );
    const parsed = JSON.parse(readFileSync(vocabulary, "utf8"));
    parsed.contributionTargetStates = [
      "unchanged",
      "modified",
      "missing",
      "superseded",
      "undone",
      // "not-applicable" intentionally omitted
    ];
    writeFileSync(vocabulary, JSON.stringify(parsed));

    const result = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      result.errors.some(
        (error) =>
          error.includes("contributionTargetStates") &&
          error.includes("not-applicable"),
      ),
      `expected a missing-value error for contributionTargetStates: ${JSON.stringify(result.errors)}`,
    );
  });
});
