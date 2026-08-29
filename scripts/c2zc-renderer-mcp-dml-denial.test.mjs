import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  C2ZC_MCP_GENERIC_SQL_CONTRACT,
  C2ZC_RENDERER_DML_PHASE_ALLOWLIST,
  C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY,
  C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY,
  C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  C2ZC_RENDERER_DML_TIMELINE_EVENT,
  C2ZC_RENDERER_REPRESENTATIVE_DML_CASE,
  C2ZC_RUST_DML_ACCEPTANCE_REFERENCES,
  runC2ZcRendererMcpDmlDenialJourney,
} from "../electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { resolveProductJourneyImpactCatalog } from "../electron/scripts/product-journey-impact.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readRepo(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("DML proof does not duplicate the Rust table matrix or scheduler seam", async () => {
  const source = await readRepo(
    "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
  );
  assert.doesNotMatch(source, /C2ZC_NATIVE_OWNED_TABLE_NAMES/);
  assert.doesNotMatch(source, /C2ZC_RENDERER_TABLE_CONTRACTS/);
  assert.doesNotMatch(source, /C2ZC_RENDERER_DML_OPERATIONS/);
  assert.doesNotMatch(
    source,
    /NARRATIVE_MAINTENANCE_OWNER_TOKEN|withLaunchEnvironmentForTest/,
  );
  assert.match(source, /keyColumn/);
  assert.match(source, /narrative_runtime_policy/);
  assert.match(source, /singleton_id/);
  assert.match(source, /version/);
  assert.match(source, /mutableSentinel/);
});

test("C2-ZC renderer/MCP DML denial keeps one Rust-bound representative case", async () => {
  assert.equal(
    C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY.id,
    C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  );
  assert.deepEqual(C2ZC_RENDERER_REPRESENTATIVE_DML_CASE, {
    table: "narrative_runtime_policy",
    operation: "UPDATE",
    keyColumn: "singleton_id",
    keyValue: 1,
    mutableColumn: "version",
    mutableSentinel: "c2-zc-renderer-dml-denial-sentinel",
  });
  assert.deepEqual(C2ZC_RENDERER_MCP_DML_DENIAL_PHASES, [
    "c2-zc-renderer-mcp-dml-denial/representative",
  ]);
  assert.deepEqual(C2ZC_RENDERER_DML_PHASE_ALLOWLIST, [
    ...C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  ]);
  assert.deepEqual(
    C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY,
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.find(
      ({ id }) => id === C2ZC_RENDERER_MCP_DML_DENIAL_ID,
    ),
  );
  assert.ok(
    PRODUCT_JOURNEY_CATALOG.some(
      ({ id }) => id === C2ZC_RENDERER_MCP_DML_DENIAL_ID,
    ),
  );
  assert.ok(
    resolveProductJourneyImpactCatalog("c2-zc").some(
      ({ id }) => id === C2ZC_RENDERER_MCP_DML_DENIAL_ID,
    ),
  );
});

test("DML representative row is production-reachable before C2-ZC cutover", async () => {
  const [migration, policy, registry] = await Promise.all([
    readRepo("src-tauri/crates/grimodex-db/src/migrate.rs"),
    readRepo("src-tauri/crates/grimodex-db/src/narrative_runtime_policy.rs"),
    readRepo("policies/narrative/protected-writers.json"),
  ]);
  assert.match(
    migration,
    /ensure_narrative_runtime_policy_row\(&conn\)/,
    "normal workspace migration must seed the policy singleton",
  );
  assert.match(
    policy,
    /INSERT INTO narrative_runtime_policy[\s\S]*?VALUES \(1, 'review-only', 0, 0, 0, 1\)/,
    "pre-cutover policy row must have a deterministic version",
  );
  assert.match(
    registry,
    /"table": "narrative_runtime_policy"[\s\S]*?"protection": "table"[\s\S]*?"enforcement": "active"/,
    "the selected row must remain protected by the Native writer registry",
  );
});

test("DML denial uses one immediate representative probe", async () => {
  const source = await readRepo(
    "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
  );
  assert.doesNotMatch(source, /waitUntil|settlement|quiescence/i);
  assert.doesNotMatch(source, /restart/i);
  assert.doesNotMatch(source, /C2ZC_RENDERER_DURABLE_SETTLEMENT_QUERIES/);
  assert.match(source, /C2ZC_RENDERER_REPRESENTATIVE_DML_CASE/);
  assert.match(source, /narrative_extraction_capture_workspace_binding/);
  assert.match(source, /db_execute/);
  assert.doesNotMatch(source, /project_create/);
  assert.doesNotMatch(source, /epoch_number/);
  assert.match(source, /singleton_id/);
  assert.match(source, /runtime_policy/);
  assert.match(source, /mutableSentinel/);
  assert.match(source, /beforeRows/);
  assert.match(source, /afterRows/);
});

test("DML journey performs one launch, one denial, and exact row equality", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2zc-dml-minimal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const events = [];
  const calls = [];
  const timeline = [];
  const runtimePolicyRow = {
    singleton_id: 1,
    runtime_mode: "review-only",
    maintenance_enabled: 0,
    generic_import_enabled: 0,
    background_ai_enabled: 0,
    version: 1,
  };
  const harness = {
    workspacePath(name) {
      assert.equal(name, C2ZC_RENDERER_MCP_DML_DENIAL_ID);
      return workspace;
    },
    async launch(phase) {
      events.push(`launch:${phase}`);
      return { app: { phase }, page: { phase } };
    },
    async close(_app, _page, phase) {
      events.push(`close:${phase}`);
    },
    recordTimeline(event, details) {
      timeline.push({ event, details });
    },
    async invokeOk(_page, command, args) {
      calls.push({ command, args });
      if (command === "open_workspace") return { path: args.path };
      if (command === "narrative_extraction_capture_workspace_binding") {
        assert.equal(args.expectedWorkspacePath, workspace);
        return {
          authorityId: "authority-c2zc",
          generation: 3,
          authorityInstanceId: "9",
        };
      }
      if (command === "db_execute" && args.method === "all") {
        assert.match(args.sql, /WHERE "singleton_id" = \?/);
        assert.deepEqual(args.params, [1]);
        return { rows: [{ ...runtimePolicyRow }] };
      }
      if (command === "db_execute" && args.method === "run") {
        assert.match(args.sql, /SET "version" = \? WHERE "singleton_id" = \?/);
        assert.deepEqual(args.params, [
          C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.mutableSentinel,
          1,
        ]);
        throw new Error(
          "db_execute rejected: PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
        );
      }
      throw new Error(`unexpected command ${command}`);
    },
  };

  const result = await runC2ZcRendererMcpDmlDenialJourney(harness);
  assert.deepEqual(events, [
    `launch:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0]}`,
    `close:${C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0]}`,
  ]);
  assert.deepEqual(
    calls.map(({ command }) => command),
    [
      "open_workspace",
      "narrative_extraction_capture_workspace_binding",
      "db_execute",
      "db_execute",
      "db_execute",
    ],
  );
  assert.equal(result.rendererDenials, 1);
  assert.equal("protectedTableCount" in result, false);
  assert.equal(result.evidence.representativeProbe.unchanged, true);
  assert.equal(
    result.evidence.representativeProbe.table,
    C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.table,
  );
  assert.equal(
    result.evidence.representativeProbe.operation,
    C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.operation,
  );
  assert.equal(result.evidence.representativeProbe.keyColumn, "singleton_id");
  assert.equal(result.evidence.representativeProbe.keyValue, 1);
  assert.deepEqual(
    result.evidence.representativeProbe.beforeRow,
    result.evidence.representativeProbe.afterRow,
  );
  assert.equal(result.evidence.representativeProbe.beforeRow.singleton_id, 1);
  assert.equal(
    result.evidence.representativeProbe.beforeMutableValue,
    result.evidence.representativeProbe.afterMutableValue,
  );
  assert.equal(
    result.evidence.representativeProbe.beforeDigest,
    result.evidence.representativeProbe.afterDigest,
  );
  assert.equal(
    result.evidence.representativeProbe.denial,
    "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
  );
  assert.equal(result.evidence.scope, "immediate-row-equality-only");
  assert.equal("localTamperResistance" in result.evidence, false);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].event, C2ZC_RENDERER_DML_TIMELINE_EVENT);
});

test("DML journey fails closed when the immediate representative row drifts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2zc-dml-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let selectCount = 0;
  let closeCount = 0;
  const runtimePolicyRow = {
    singleton_id: 1,
    runtime_mode: "review-only",
    maintenance_enabled: 0,
    generic_import_enabled: 0,
    background_ai_enabled: 0,
    version: 1,
  };
  const harness = {
    workspacePath: () => path.join(root, "workspace"),
    async launch(phase) {
      return { app: { phase }, page: { phase } };
    },
    async close() {
      closeCount += 1;
    },
    async invokeOk(_page, command, args) {
      if (command === "open_workspace") return {};
      if (command === "narrative_extraction_capture_workspace_binding") {
        return {
          authorityId: "authority-c2zc",
          generation: 3,
          authorityInstanceId: "9",
        };
      }
      if (command !== "db_execute") throw new Error(`unexpected ${command}`);
      if (args.method === "all") {
        selectCount += 1;
        assert.deepEqual(args.params, [1]);
        if (selectCount === 2) runtimePolicyRow.version = "drifted";
        return { rows: [{ ...runtimePolicyRow }] };
      }
      throw new Error(
        "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
      );
    },
  };
  await assert.rejects(
    runC2ZcRendererMcpDmlDenialJourney(harness),
    /changed immediately/,
  );
  assert.equal(selectCount, 2);
  assert.equal(closeCount, 1);
});

test("DML journey rejects a representative UPDATE that succeeds and mutates the protected row", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2zc-dml-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let selectCount = 0;
  let closeCount = 0;
  const runtimePolicyRow = {
    singleton_id: 1,
    runtime_mode: "review-only",
    maintenance_enabled: 0,
    generic_import_enabled: 0,
    background_ai_enabled: 0,
    version: 1,
  };
  const harness = {
    workspacePath: () => path.join(root, "workspace"),
    async launch(phase) {
      return { app: { phase }, page: { phase } };
    },
    async close() {
      closeCount += 1;
    },
    async invokeOk(_page, command, args) {
      if (command === "open_workspace") return {};
      if (command === "narrative_extraction_capture_workspace_binding") {
        return {
          authorityId: "authority-c2zc",
          generation: 3,
          authorityInstanceId: "9",
        };
      }
      if (command !== "db_execute") throw new Error(`unexpected ${command}`);
      if (args.method === "all") {
        selectCount += 1;
        assert.deepEqual(args.params, [1]);
        return { rows: [{ ...runtimePolicyRow }] };
      }
      assert.equal(args.method, "run");
      assert.deepEqual(args.params, [
        C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.mutableSentinel,
        1,
      ]);
      runtimePolicyRow.version = args.params[0];
      return { changes: 1 };
    },
  };

  await assert.rejects(
    runC2ZcRendererMcpDmlDenialJourney(harness),
    /changed immediately/,
  );
  assert.equal(selectCount, 2);
  assert.equal(closeCount, 1);
  assert.equal(
    runtimePolicyRow.version,
    C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.mutableSentinel,
  );
});

test("DML journey rejects a preexisting sentinel before attempting the UPDATE", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "c2zc-dml-sentinel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let selectCount = 0;
  let closeCount = 0;
  let runCount = 0;
  const harness = {
    workspacePath: () => path.join(root, "workspace"),
    async launch(phase) {
      return { app: { phase }, page: { phase } };
    },
    async close() {
      closeCount += 1;
    },
    async invokeOk(_page, command, args) {
      if (command === "open_workspace") return {};
      if (command === "narrative_extraction_capture_workspace_binding") {
        return {
          authorityId: "authority-c2zc",
          generation: 3,
          authorityInstanceId: "9",
        };
      }
      if (command !== "db_execute") throw new Error(`unexpected ${command}`);
      if (args.method === "all") {
        selectCount += 1;
        assert.deepEqual(args.params, [1]);
        return {
          rows: [
            {
              singleton_id: 1,
              runtime_mode: "review-only",
              maintenance_enabled: 0,
              generic_import_enabled: 0,
              background_ai_enabled: 0,
              version: C2ZC_RENDERER_REPRESENTATIVE_DML_CASE.mutableSentinel,
            },
          ],
        };
      }
      runCount += 1;
      throw new Error("the UPDATE must not be attempted");
    },
  };

  await assert.rejects(
    runC2ZcRendererMcpDmlDenialJourney(harness),
    /distinct mutable value/,
  );
  assert.equal(selectCount, 1);
  assert.equal(runCount, 0);
  assert.equal(closeCount, 1);
});

test("DML and MCP generic writer proof stays bound to Rust evidence", async () => {
  assert.equal(C2ZC_MCP_GENERIC_SQL_CONTRACT.status, "not-exposed");
  assert.equal(C2ZC_MCP_GENERIC_SQL_CONTRACT.origin, "SqlOrigin::McpGeneric");
  assert.match(
    C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustSource,
    /src-tauri\/crates\/grimodex-db\/src\/execute\.rs$/,
  );
  assert.match(
    C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustTest,
    /c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes/,
  );
  assert.equal(
    C2ZC_RUST_DML_ACCEPTANCE_REFERENCES.status,
    "delegated-to-rust-acceptance-receipt",
  );
  assert.deepEqual(
    C2ZC_RUST_DML_ACCEPTANCE_REFERENCES.directDatabaseCorruption,
    {
      source:
        "src-tauri/crates/grimodex-db/src/narrative_extraction/c2z_preparation.rs",
      test: "rebuild_outcome_tamper_and_missing_evidence_fail_closed",
    },
  );
  assert.deepEqual(C2ZC_RUST_DML_ACCEPTANCE_REFERENCES.allTableGate, {
    source: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustSource,
    test: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustTest,
  });
  const source = await readRepo(
    "electron/scripts/c2zc-renderer-mcp-dml-denial-product-journey.mjs",
  );
  assert.doesNotMatch(source, /local[- ]tamper[- ]resistance/i);
  assert.doesNotMatch(source, /all Runs missing|fabricat/i);
});
