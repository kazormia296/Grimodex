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

import { validateSemanticCoreBoundary } from "./validate-semantic-core-boundary.mjs";

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

describe("validate-semantic-core-boundary", () => {
  it("accepts the repository's ratified semantic contract", () => {
    const result = validateSemanticCoreBoundary({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
    assert.ok(result.operationCount > 0);
    assert.equal(result.schemaVersion, 30);
  });

  it("fails closed for an unknown route and a forbidden interpreter import", () => {
    const root = minimalFixtureRoot();
    const baseline = validateSemanticCoreBoundary({ repoRoot: root });
    assert.ok(
      !baseline.errors.some((error) => /unknown authority route/i.test(error)),
      "the fixture must not already contain an unknown route finding",
    );
    assert.ok(
      !baseline.errors.some((error) => /agent writer or domain api directly/i.test(error)),
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
      result.errors.some((error) => /agent writer or domain api directly/i.test(error)),
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
    parsed.semanticBoundary.scanRoots = parsed.semanticBoundary.scanRoots.filter(
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
