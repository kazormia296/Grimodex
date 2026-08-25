import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateChangeFeedWriters } from "./validate-change-feed-writers.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function fixtureOperation(overrides = {}) {
  return {
    id: "fixture.write",
    feedPolicy: "required",
    coverageStatus: "declared",
    reason: "Fixture domain mutations invalidate derived narrative artifacts.",
    implementation: {
      module: "src-tauri/crates/fixture/src/writer.rs",
      symbol: "fixture_writer",
    },
    routes: [
      {
        surface: "electron-ipc",
        name: "fixture_write",
        module: "electron/shared/fixture.ts",
      },
      {
        surface: "napi",
        name: "fixture_write",
        module: "src-tauri/crates/fixture/src/writer.rs",
      },
    ],
    writerIds: ["fixture.writer"],
    scope: "project",
    requiredIdentities: [
      "projectId",
      "requestId",
      "sessionId",
      "transactionId",
    ],
    canonical: {
      origin: "renderer",
      opType: "fixture.write",
    },
    ...overrides,
  };
}

function writeFixture(operations, { operationFragments, fragmentFiles } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "change-feed-writers-"));
  const policyDir = path.join(root, "policies/narrative");
  const rustDir = path.join(root, "src-tauri/crates/fixture/src");
  const electronDir = path.join(root, "electron/shared");
  mkdirSync(policyDir, { recursive: true });
  mkdirSync(rustDir, { recursive: true });
  mkdirSync(electronDir, { recursive: true });
  writeFileSync(
    path.join(policyDir, "protected-writers.json"),
    JSON.stringify([
      {
        aggregate: "fixture",
        table: "fixture_rows",
        protection: "table",
        writer: "fixture.writer",
        enforcement: "active",
      },
    ]),
  );
  writeFileSync(
    path.join(policyDir, "change-feed-writers.json"),
    JSON.stringify({
      schemaVersion: 1,
      gateId: "gate-c1",
      ...(operationFragments ? { operationFragments } : {}),
      writerMatrix: [
        {
          writer: "fixture.writer",
          objectKey: "fixture",
          addressing: "independent-key",
          paths: ["/"],
          textImpact: "none",
          cause: ["forward"],
          atomic: true,
          undoRedo: false,
          idempotent: true,
        },
      ],
      operations,
    }),
  );
  if (fragmentFiles) {
    const fragmentDir = path.join(policyDir, "change-feed-operations");
    mkdirSync(fragmentDir, { recursive: true });
    for (const [name, content] of Object.entries(fragmentFiles)) {
      writeFileSync(path.join(fragmentDir, name), JSON.stringify(content));
    }
  }
  writeFileSync(
    path.join(rustDir, "writer.rs"),
    "pub fn fixture_writer() {}\npub async fn fixture_write() {}\n",
  );
  writeFileSync(
    path.join(electronDir, "fixture.ts"),
    "export const fixture_write = true;\n",
  );
  return root;
}

function validateFixture(root, options = {}) {
  return validateChangeFeedWriters({
    repoRoot: root,
    manifestPath: path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    ),
    registryPath: path.join(root, "policies/narrative/protected-writers.json"),
    knownRoutes: [],
    ...options,
  });
}

describe("validate-change-feed-writers", () => {
  it("accepts the bundled Gate C1 declaration and inventories every policy class", () => {
    const result = validateChangeFeedWriters({ repoRoot: REPO_ROOT });
    assert.deepEqual(result.errors, []);
    assert.ok(result.operationCount > 0);
    assert.ok(result.policyCounts.required > 0);
    assert.ok(result.policyCounts.delegated > 0);
    assert.ok(result.policyCounts.excluded > 0);
    assert.equal(result.coverageCounts.declared, 0);

    const manifest = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "policies/narrative/change-feed-writers.json"),
        "utf8",
      ),
    );
    const routes = manifest.operations.flatMap((operation) => operation.routes);
    const mcpRoutes = routes
      .filter((route) => route.surface === "mcp-tool")
      .map((route) => route.name);
    for (const route of [
      "create_foreshadow",
      "update_foreshadow",
      "create_codex_entry",
      "update_codex_entry",
      "create_event",
      "update_event",
      "delete_event",
      "stamp_scene_event",
      "unstamp_scene_event",
      "set_event_participants",
      "add_event_relation",
      "remove_event_relation",
    ]) {
      assert.ok(mcpRoutes.includes(route), `missing MCP route ${route}`);
    }

    for (const route of [
      "ai_tree_plan_apply",
      "ai_tree_plan_undo",
      "revision_scene_restore",
      "trash_bin_restore",
      "agent_snippet_create",
    ]) {
      assert.ok(
        routes.some(
          (candidate) =>
            candidate.name === route &&
            (candidate.surface === "electron-ipc" ||
              candidate.surface === "napi"),
        ),
        `missing typed Native route ${route}`,
      );
    }

    const byId = new Map(
      manifest.operations.map((operation) => [operation.id, operation]),
    );
    const workflowWriters = Object.fromEntries(
      [
        "narrative.workflow.create-run",
        "narrative.workflow.cancel-run",
        "narrative.workflow.claim-task",
        "narrative.workflow.finish-task",
        "narrative.workflow.fail-task",
      ].map((operationId) => [operationId, byId.get(operationId)?.writerIds]),
    );
    assert.deepEqual(workflowWriters, {
      "narrative.workflow.create-run": ["narrative.extraction-task"],
      "narrative.workflow.cancel-run": ["narrative.extraction-task"],
      "narrative.workflow.claim-task": [
        "narrative.extraction-task",
        "narrative.extraction-attempt",
      ],
      "narrative.workflow.finish-task": [
        "narrative.extraction-task",
        "narrative.extraction-attempt",
        "narrative.extraction-artifact",
        "narrative.stage-provenance",
      ],
      "narrative.workflow.fail-task": [
        "narrative.extraction-task",
        "narrative.extraction-attempt",
      ],
    });
    assert.equal(byId.get("agent.sql-bundle.mutate")?.feedPolicy, "excluded");
    assert.equal(
      byId.get("agent.sql-bundle.mutate")?.exclusionReason,
      "untrusted-generic-sql",
    );
    assert.equal(byId.get("agent.prose.accept")?.feedPolicy, "excluded");
    assert.equal(
      byId.get("agent.prose.accept")?.exclusionReason,
      "staging-only",
    );

    const strict = validateChangeFeedWriters({
      repoRoot: REPO_ROOT,
      requireRuntimeCoverage: true,
    });
    assert.deepEqual(strict.errors, []);

    const excluded = new Map(
      manifest.operations
        .filter((operation) => operation.feedPolicy === "excluded")
        .map((operation) => [operation.id, operation.exclusionReason]),
    );
    assert.equal(
      excluded.get("renderer.generic-sql.execute"),
      "untrusted-generic-sql",
    );
    assert.equal(
      excluded.get("renderer.generic-sql.batch"),
      "untrusted-generic-sql",
    );
    assert.equal(
      excluded.get("workspace.backup.restore"),
      "database-image-replacement",
    );
    assert.equal(
      excluded.get("workspace.recovery.restore"),
      "database-image-replacement",
    );
    assert.equal(excluded.get("project.delete"), "project-deletion");
  });

  it("allows declared required routes by default and can tighten to verified runtime coverage", () => {
    const root = writeFixture([fixtureOperation()]);
    assert.deepEqual(validateFixture(root).errors, []);

    const strict = validateFixture(root, { requireRuntimeCoverage: true });
    assert.ok(
      strict.errors.some((error) =>
        error.includes("fixture.write must have coverageStatus verified"),
      ),
    );
  });

  it("rejects verified coverage without a runtime evidence bundle", () => {
    const root = writeFixture([
      fixtureOperation({ coverageStatus: "verified" }),
    ]);
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("verified coverage requires a schemaVersion 1 runtimeEvidence bundle"),
      ),
    );
  });

  it("rejects an MCP authority contract that points at a non-test source file", () => {
    const root = writeFixture([
      fixtureOperation({
        routes: [
          {
            surface: "mcp-tool",
            name: "fixture_write",
            module: "src-tauri/crates/fixture/src/writer.rs",
          },
        ],
        controls: ["field-authority"],
      }),
    ]);
    const manifestPath = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.mcpAuthorityContract = {
      schemaVersion: 1,
      fieldAuthority: "native-transactional-preflight",
      coverageStatus: "verified",
      executionSurface: "mcp-tool-native",
      runtimeTestCommand: "cargo test --manifest-path fixture/Cargo.toml",
      evidenceTests: [
        {
          file: "src-tauri/crates/fixture/src/writer.rs",
          symbols: ["fixture_writer"],
        },
      ],
      operationEvidence: [
        { operationId: "fixture.write", symbols: ["fixture_writer"] },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must contain executable test declarations"),
      ),
    );
  });

  it("does not treat a helper after a Rust test as the test symbol", () => {
    const root = writeFixture([
      fixtureOperation({
        routes: [
          {
            surface: "mcp-tool",
            name: "fixture_write",
            module: "src-tauri/crates/fixture/src/writer.rs",
          },
        ],
        controls: ["field-authority"],
      }),
    ]);
    writeFileSync(
      path.join(root, "src-tauri/crates/fixture/src/writer.rs"),
      "#[test]\nfn real_test() {}\nfn claimed_helper() {}\n",
    );
    const manifestPath = path.join(
      root,
      "policies/narrative/change-feed-writers.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.mcpAuthorityContract = {
      schemaVersion: 1,
      fieldAuthority: "native-transactional-preflight",
      coverageStatus: "verified",
      executionSurface: "mcp-tool-native",
      runtimeTestCommand:
        "cargo test --manifest-path fixture/Cargo.toml -p grimodex-db -p grimodex-mcp",
      evidenceTests: [
        {
          file: "src-tauri/crates/fixture/src/writer.rs",
          symbols: ["claimed_helper"],
        },
      ],
      operationEvidence: [
        { operationId: "fixture.write", symbols: ["claimed_helper"] },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("is not an executable test"),
      ),
    );
  });

  it("rejects required operations without the complete transaction identity contract", () => {
    const root = writeFixture([
      fixtureOperation({ requiredIdentities: ["projectId", "requestId"] }),
    ]);
    const result = validateFixture(root);
    assert.ok(result.errors.some((error) => error.includes("sessionId")));
    assert.ok(result.errors.some((error) => error.includes("transactionId")));
  });

  it("rejects excluded operations without a fixed exclusion reason and with canonical events", () => {
    const root = writeFixture([
      fixtureOperation({
        feedPolicy: "excluded",
        coverageStatus: "verified",
        exclusionReason: undefined,
        canonical: { origin: "renderer", opType: "fixture.write" },
        requiredIdentities: [],
      }),
    ]);
    const result = validateFixture(root);
    assert.ok(result.errors.some((error) => error.includes("exclusionReason")));
    assert.ok(
      result.errors.some((error) => error.includes("canonical must be null")),
    );
  });

  it("rejects duplicate operation ids, duplicate routes, and unknown writer ids", () => {
    const duplicate = fixtureOperation({ writerIds: ["unknown.writer"] });
    const root = writeFixture([fixtureOperation(), duplicate]);
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) => error.includes("duplicate operation id")),
    );
    assert.ok(result.errors.some((error) => error.includes("duplicate route")));
    assert.ok(
      result.errors.some((error) => error.includes("unknown writer id")),
    );
  });

  it("requires every active protected writer id to have an operation policy", () => {
    const root = writeFixture([
      fixtureOperation({
        writerIds: [],
        feedPolicy: "excluded",
        canonical: null,
        exclusionReason: "test-fixture",
      }),
    ]);
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("active writer id fixture.writer is not covered"),
      ),
    );
  });

  it("rejects missing implementation symbols and route modules", () => {
    const root = writeFixture([
      fixtureOperation({
        implementation: {
          module: "src-tauri/crates/fixture/src/writer.rs",
          symbol: "missing_writer",
        },
        routes: [
          {
            surface: "electron-ipc",
            name: "fixture_write",
            module: "electron/shared/missing.ts",
          },
        ],
      }),
    ]);
    const result = validateFixture(root);
    assert.ok(result.errors.some((error) => error.includes("missing_writer")));
    assert.ok(
      result.errors.some((error) =>
        error.includes("electron/shared/missing.ts"),
      ),
    );
  });

  it("fails when a known mutating route is absent from the manifest", () => {
    const root = writeFixture([fixtureOperation()]);
    const result = validateFixture(root, {
      knownRoutes: [
        { surface: "electron-ipc", name: "fixture_write" },
        { surface: "mcp-tool", name: "missing_mcp_write" },
      ],
    });
    assert.ok(
      result.errors.some((error) =>
        error.includes("known route mcp-tool:missing_mcp_write is not covered"),
      ),
    );
  });

  it("merges a verified, non-backflow-invariant operation fragment into the manifest", () => {
    const root = writeFixture([fixtureOperation()], {
      operationFragments: [
        "policies/narrative/change-feed-operations/*.json",
      ],
      fragmentFiles: {
        "c2-attention.json": {
          schemaVersion: 1,
          owner: "lane-d-attention",
          operations: [
            {
              id: "fixture.fragment-excluded",
              feedPolicy: "excluded",
              exclusionReason: "non-backflow-invariant",
              coverageStatus: "verified",
              reason:
                "Attention rows are user bookkeeping and must never backflow into the Change Feed.",
              implementation: {
                module: "src-tauri/crates/fixture/src/writer.rs",
                symbol: "fixture_writer",
              },
              routes: [],
              writerIds: [],
              scope: "project",
              requiredIdentities: [],
              canonical: null,
              runtimeEvidence: {
                schemaVersion: 1,
                status: "excluded",
                reason: "non-backflow-invariant",
              },
            },
          ],
        },
      },
    });
    const result = validateFixture(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.operationCount, 2);
    assert.equal(result.policyCounts.excluded, 1);
  });

  it("rejects a fragment operation that is not coverageStatus verified", () => {
    const root = writeFixture([fixtureOperation()], {
      operationFragments: [
        "policies/narrative/change-feed-operations/*.json",
      ],
      fragmentFiles: {
        "c2-attention.json": {
          schemaVersion: 1,
          owner: "lane-d-attention",
          operations: [
            {
              id: "fixture.fragment-declared",
              feedPolicy: "excluded",
              exclusionReason: "non-backflow-invariant",
              coverageStatus: "declared",
              reason: "Not yet implemented.",
              implementation: {
                module: "src-tauri/crates/fixture/src/writer.rs",
                symbol: "fixture_writer",
              },
              routes: [],
              writerIds: [],
              scope: "project",
              requiredIdentities: [],
              canonical: null,
            },
          ],
        },
      },
    });
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          "fixture.fragment-declared must have coverageStatus verified",
        ),
      ),
    );
  });

  it("rejects a fragment file with the wrong schemaVersion", () => {
    const root = writeFixture([fixtureOperation()], {
      operationFragments: [
        "policies/narrative/change-feed-operations/*.json",
      ],
      fragmentFiles: {
        "c2-attention.json": {
          schemaVersion: 2,
          owner: "lane-d-attention",
          operations: [],
        },
      },
    });
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) => error.includes("schemaVersion must be 1")),
    );
  });

  it("rejects a duplicate operation id between the root manifest and a fragment", () => {
    const root = writeFixture([fixtureOperation()], {
      operationFragments: [
        "policies/narrative/change-feed-operations/*.json",
      ],
      fragmentFiles: {
        "c2-attention.json": {
          schemaVersion: 1,
          owner: "lane-d-attention",
          operations: [
            fixtureOperation({
              routes: [
                {
                  surface: "electron-ipc",
                  name: "fixture_write_2",
                  module: "electron/shared/fixture.ts",
                },
                {
                  surface: "napi",
                  name: "fixture_write_2",
                  module: "src-tauri/crates/fixture/src/writer.rs",
                },
              ],
            }),
          ],
        },
      },
    });
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("duplicate operation id fixture.write"),
      ),
    );
  });

  it("rejects an operationFragments pattern that does not end in /*.json", () => {
    const root = writeFixture([fixtureOperation()], {
      operationFragments: ["policies/narrative/change-feed-operations"],
    });
    const result = validateFixture(root);
    assert.ok(
      result.errors.some((error) =>
        error.includes("must end with '/*.json'"),
      ),
    );
  });
});
