import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_CANONICAL_PATH,
  SCHEMA_LEGACY_PATH,
  scanNarrativeSchema,
  validateNarrativeWriters,
} from "./validate-narrative-writers.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

/**
 * The validator is strict by default: a missing or empty canonical schema fails
 * (DR-MP4-3 addendum). Fixture roots in this file have no schema file at all, so
 * they opt out explicitly through this one helper. A fixture that does contain a
 * schema file is checked in full even here (`scanNarrativeSchema` ignores the
 * opt-out when a file exists and is wrong).
 */
function validateFixtureRoot(options) {
  return validateNarrativeWriters({ requireSchema: false, ...options });
}

const C2A_PROTECTED_TABLES = [
  "narrative_extraction_tasks",
  "narrative_extraction_attempts",
  "narrative_extraction_artifacts",
  "narrative_extraction_stage_model_bindings",
  "narrative_extraction_stage_receipts",
];

const C2A_DRIZZLE_TABLES = [
  ["narrative_extraction_tasks", "narrativeExtractionTasks"],
  ["narrative_extraction_attempts", "narrativeExtractionAttempts"],
  ["narrative_extraction_artifacts", "narrativeExtractionArtifacts"],
  [
    "narrative_extraction_stage_model_bindings",
    "narrativeExtractionStageModelBindings",
  ],
  ["narrative_extraction_stage_receipts", "narrativeExtractionStageReceipts"],
];

const C2ZC_NATIVE_OWNED_TABLES = [
  "change_events",
  "state_snapshots",
  "narrative_semantic_epochs",
  "narrative_extraction_runs",
  "narrative_dependency_edges",
  "narrative_dependency_edge_states",
  "narrative_consumer_freshness",
  "narrative_semantic_index_metadata",
  "narrative_maintenance_finding_lifecycle",
  "narrative_maintenance_finding_observations",
  "narrative_maintenance_repair_leases",
];

function writeActiveFixtureRegistry(root) {
  const policiesDir = path.join(root, "policies/narrative");
  mkdirSync(policiesDir, { recursive: true });
  writeFileSync(
    path.join(policiesDir, "protected-writers.json"),
    JSON.stringify([
      {
        aggregate: "fixture",
        table: "narrative_protected_fixture",
        protection: "table",
        writer: "narrative.fixture",
        enforcement: "active",
      },
      {
        aggregate: "fixture",
        table: "narrative_protected_shared_fixture",
        protection: "table",
        writer: "narrative.fixture",
        enforcement: "deferred",
      },
    ]),
  );
  return path.join(policiesDir, "protected-writers.json");
}

function writeColumnProtectedFixtureRegistry(root) {
  const policiesDir = path.join(root, "policies/narrative");
  mkdirSync(policiesDir, { recursive: true });
  writeFileSync(
    path.join(policiesDir, "protected-writers.json"),
    JSON.stringify([
      {
        aggregate: "fixture",
        table: "tree_nodes",
        protection: "columns",
        columns: ["story_time_order", "story_time_label"],
        versionColumn: "version",
        writer: "temporal.scene",
        enforcement: "active",
      },
    ]),
  );
  return path.join(policiesDir, "protected-writers.json");
}

function writeStructuralOnlyProjectRegistry(root) {
  const policiesDir = path.join(root, "policies/narrative");
  mkdirSync(policiesDir, { recursive: true });
  writeFileSync(
    path.join(policiesDir, "protected-writers.json"),
    JSON.stringify([
      {
        aggregate: "project-lifecycle",
        table: "projects",
        protection: "columns",
        columns: [],
        writer: "project.lifecycle",
        enforcement: "active",
      },
    ]),
  );
  return path.join(policiesDir, "protected-writers.json");
}

describe("validate-narrative-writers", () => {
  it("activates C2A execution and stage tables without a closure table", () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    const entries = registry.filter((entry) =>
      C2A_PROTECTED_TABLES.includes(entry.table),
    );

    assert.deepEqual(
      entries.map((entry) => entry.table).sort(),
      [...C2A_PROTECTED_TABLES].sort(),
    );
    assert.ok(entries.every((entry) => entry.enforcement === "active"));
    assert.ok(
      entries.every((entry) => entry.protection === "table"),
      "C2A execution/stage rows require whole-table Native ownership",
    );
    assert.equal(
      registry.some((entry) =>
        /^narrative_extraction_.*closure/.test(entry.table),
      ),
      false,
      "the ephemeral stage-provenance closure must not become a table",
    );
  });

  it("keeps the eleven C2-ZC authority, finding, repair, and timelapse tables registered", () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    const entries = registry.filter((entry) =>
      C2ZC_NATIVE_OWNED_TABLES.includes(entry.table),
    );

    assert.deepEqual(
      entries.map((entry) => entry.table).sort(),
      [...C2ZC_NATIVE_OWNED_TABLES].sort(),
    );
    assert.equal(entries.length, C2ZC_NATIVE_OWNED_TABLES.length);
    assert.ok(entries.every((entry) => entry.enforcement === "active"));
    assert.ok(entries.every((entry) => entry.protection === "table"));
  });

  it("maps existing C2A Drizzle exports to active protected tables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const srcDir = path.join(root, "src/renderer");
    mkdirSync(srcDir, { recursive: true });
    const imports = C2A_DRIZZLE_TABLES.map(([, identifier]) => identifier).join(
      ", ",
    );
    const mutations = C2A_DRIZZLE_TABLES.map(
      ([, identifier]) =>
        `await db.insert(${identifier}).values({});\nawait db.update(${identifier}).set({});\nawait db.delete(${identifier});`,
    ).join("\n");
    writeFileSync(
      path.join(srcDir, "generic.ts"),
      `import { ${imports} } from '@/db/schema';\n${mutations}\n`,
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath: REGISTRY_PATH,
    });
    assert.deepEqual(
      result.violations.map((violation) => violation.table).sort(),
      C2A_DRIZZLE_TABLES.map(([table]) => table).sort(),
    );
  });

  it("maps timelapse Drizzle exports to the active Native registry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = path.join(
      root,
      "policies/narrative/protected-writers.json",
    );
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify([
        {
          aggregate: "narrative-c2zc-timelapse",
          table: "change_events",
          protection: "table",
          writer: "narrative.authority",
          enforcement: "active",
        },
        {
          aggregate: "narrative-c2zc-timelapse",
          table: "state_snapshots",
          protection: "table",
          writer: "narrative.authority",
          enforcement: "active",
        },
      ]),
    );
    const srcDir = path.join(root, "src/features/timelapse");
    mkdirSync(srcDir, { recursive: true });
    const illegalOperations = [
      [
        "change-events-insert",
        "changeEvents",
        "await db.insert(changeEvents).values({});",
      ],
      [
        "change-events-update",
        "changeEvents",
        "await db.update(changeEvents).set({});",
      ],
      [
        "change-events-delete",
        "changeEvents",
        "await db.delete(changeEvents);",
      ],
      [
        "state-snapshots-insert",
        "stateSnapshots",
        "await db.insert(stateSnapshots).values({});",
      ],
      [
        "state-snapshots-update",
        "stateSnapshots",
        "await db.update(stateSnapshots).set({});",
      ],
      [
        "state-snapshots-delete",
        "stateSnapshots",
        "await db.delete(stateSnapshots);",
      ],
    ];
    for (const [fileStem, identifier, mutation] of illegalOperations) {
      writeFileSync(
        path.join(srcDir, `${fileStem}.ts`),
        [
          "import { changeEvents, stateSnapshots } from '@/db/schema';",
          mutation,
          "",
        ].join("\n"),
      );
    }

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, illegalOperations.length);
    assert.deepEqual(
      result.violations
        .map((violation) => [violation.file, violation.table])
        .sort(),
      illegalOperations
        .map(([fileStem, identifier]) => [
          `src/features/timelapse/${fileStem}.ts`,
          identifier === "changeEvents" ? "change_events" : "state_snapshots",
        ])
        .sort(),
    );
  });

  it("rejects generic renderer, browser, and MCP SQL DML for every C2A table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const surfaces = [
      ["src/renderer", "renderer"],
      ["src/features/browser-generic", "browser"],
      ["electron/mcp-generic", "mcp"],
    ];
    const operations = (table) =>
      [
        `INSERT INTO ${table} (id) VALUES ('generic-${table}')`,
        `UPDATE ${table} SET id = 'generic-${table}-updated'`,
        `DELETE FROM ${table}`,
      ].map((sql) => `await db.execute(${JSON.stringify(sql)});`);

    for (const [relativeDir, surface] of surfaces) {
      const dir = path.join(root, relativeDir);
      mkdirSync(dir, { recursive: true });
      for (const table of C2A_PROTECTED_TABLES) {
        writeFileSync(
          path.join(dir, `${surface}-${table}.ts`),
          `${operations(table).join("\n")}\n`,
        );
      }
    }

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath: REGISTRY_PATH,
    });
    assert.equal(
      result.violations.length,
      surfaces.length * C2A_PROTECTED_TABLES.length,
    );
    assert.deepEqual(
      [
        ...new Set(result.violations.map((violation) => violation.table)),
      ].sort(),
      [...C2A_PROTECTED_TABLES].sort(),
    );
  });

  it("passes for the bundled registry with fixture-only active tables", () => {
    const result = validateNarrativeWriters({ repoRoot: REPO_ROOT });
    assert.equal(result.violations.length, 0);
    assert.deepEqual(result.schemaScanViolations, []);
    assert.deepEqual(result.registryCoverageViolations, []);
    assert.ok(result.activeCount >= 1);
    assert.equal(result.deferredCount, 0);
  });

  it("fails when production source mutates an active protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "api.ts"),
      "import { narrativeProtectedFixture } from '@/db/schema';\nawait db.insert(narrativeProtectedFixture).values({});\n",
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "narrative_protected_fixture");
  });

  it("fails when a Native narrative authority table is absent from the registry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    mkdirSync(path.join(root, "src/db"), { recursive: true });
    writeFileSync(
      path.join(root, "src/db/schema.ts"),
      'export const narrativeFieldAuthority = sqliteTable("narrative_field_authority", {});\n',
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.deepEqual(result.registryCoverageViolations, [
      "narrative_field_authority",
    ]);
  });

  it("fails when tx.update mutates an active protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "tx.ts"),
      [
        "import { narrativeProtectedFixture } from '@/db/schema';",
        "await tx.update(narrativeProtectedFixture).set({ name: 'x' });",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "narrative_protected_fixture");
  });

  it("allows non-protected columns on a column-protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeColumnProtectedFixtureRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "tree.ts"),
      [
        "import { treeNodes } from '@/db/schema';",
        "await db.update(treeNodes).set({ title: 'x', synopsis: 'y' });",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 0);
  });

  it("fails when a protected column is set on a column-protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeColumnProtectedFixtureRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "tree.ts"),
      [
        "import { treeNodes } from '@/db/schema';",
        "await db.update(treeNodes).set({ storyTimeOrder: 'a0', title: 'x' });",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "tree_nodes");
  });

  it("fails closed for insert and delete on a column-protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeColumnProtectedFixtureRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "insert.ts"),
      "import { treeNodes } from '@/db/schema';\nawait db.insert(treeNodes).values({ title: 'x' });\n",
    );
    writeFileSync(
      path.join(srcDir, "delete.ts"),
      [
        "import { treeNodes } from '@/db/schema';",
        "await db.delete(treeNodes);",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 2);
    assert.deepEqual(
      result.violations.map((violation) => violation.table),
      ["tree_nodes", "tree_nodes"],
    );
  });

  it("allows arbitrary metadata updates but rejects Project insert/delete", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeStructuralOnlyProjectRegistry(root);
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "update.ts"),
      [
        "import { projects } from '@/db/schema';",
        "await db.update(projects).set({ ...patch, updatedAt: now });",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(srcDir, "insert.ts"),
      "import { projects } from '@/db/schema';\nawait db.insert(projects).values({ id: 'x' });\n",
    );
    writeFileSync(
      path.join(srcDir, "delete.ts"),
      "import { projects } from '@/db/schema';\nawait db.delete(projects);\n",
    );

    const result = validateFixtureRoot({ repoRoot: root, registryPath });
    assert.deepEqual(
      result.violations.map((violation) => violation.file),
      ["src/features/example/delete.ts", "src/features/example/insert.ts"],
    );
  });

  it("fails when aliasedDb.delete mutates an active protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const srcDir = path.join(root, "packages/example");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, "delete.ts"),
      [
        "import { narrativeProtectedFixture as fixture } from '@/db/schema';",
        "const aliasedDb = db;",
        "await aliasedDb.delete(fixture);",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "narrative_protected_fixture");
  });

  it("fails when raw SQL UPDATE targets an active protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const electronDir = path.join(root, "electron/main");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(
      path.join(electronDir, "raw.ts"),
      [
        "const sql = `UPDATE narrative_protected_fixture SET name = 'x'`;",
        "await db.execute(sql);",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "narrative_protected_fixture");
  });

  it("passes when mutation lives only in test fixtures", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const testDir = path.join(root, "src/features/example");
    const fixtureDir = path.join(root, "src/features/example/__fixtures__");
    mkdirSync(testDir, { recursive: true });
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      path.join(testDir, "api.test.ts"),
      [
        "import { narrativeProtectedFixture } from '@/db/schema';",
        "await db.insert(narrativeProtectedFixture).values({});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(fixtureDir, "seed.ts"),
      [
        "import { narrativeProtectedFixture } from '@/db/schema';",
        "await db.delete(narrativeProtectedFixture);",
        "",
      ].join("\n"),
    );
    const mainDir = path.join(root, "electron/main");
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(
      path.join(mainDir, "example.pipeline.spec.ts"),
      [
        "import { narrativeProtectedFixture } from '@/db/schema';",
        "await db.delete(narrativeProtectedFixture);",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 0);
  });

  it("keeps scanning a .spec.ts that is not a Main pipeline test", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    const mainDir = path.join(root, "electron/main");
    mkdirSync(mainDir, { recursive: true });
    writeFileSync(
      path.join(mainDir, "example.spec.ts"),
      [
        "import { narrativeProtectedFixture } from '@/db/schema';",
        "await db.delete(narrativeProtectedFixture);",
        "",
      ].join("\n"),
    );

    const result = validateFixtureRoot({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, "electron/main/example.spec.ts");
  });
});

/**
 * Narrative authority table names the validator read from `src/db/schema.ts` at
 * origin/master 269e2577, before the schema moved to
 * `electron/shared/readDomain/db/schema.ts` (MP-4b PR-3b-1). Measured by running
 * the validator's own `sqliteTable("narrative_…" | change_events | state_snapshots)`
 * pattern over the pre-move file: 47 names. Of the validator's 36 hand-listed
 * authority tables, 30 are among them (the six `nir1_…` tables do not match the
 * pattern, so the inverse-coverage gate never compared them; that was already
 * true before the move). The pin is a set containment, not a count: adding a
 * table must not fail it, losing or renaming one must.
 */
const BASE_NARRATIVE_SCHEMA_TABLES = [
  "change_events",
  "narrative_application_contributions",
  "narrative_apply_commits",
  "narrative_apply_operations",
  "narrative_change_cursors",
  "narrative_change_events",
  "narrative_change_object_heads",
  "narrative_change_sets",
  "narrative_change_transactions",
  "narrative_commit_journals",
  "narrative_consumer_freshness",
  "narrative_dependency_declaration_entries",
  "narrative_dependency_declaration_heads",
  "narrative_dependency_declaration_sets",
  "narrative_dependency_edge_states",
  "narrative_dependency_edges",
  "narrative_extraction_artifacts",
  "narrative_extraction_attempts",
  "narrative_extraction_runs",
  "narrative_extraction_stage_model_bindings",
  "narrative_extraction_stage_receipts",
  "narrative_extraction_task_edges",
  "narrative_extraction_tasks",
  "narrative_field_authority",
  "narrative_maintenance_attention",
  "narrative_maintenance_finding_lifecycle",
  "narrative_maintenance_finding_observations",
  "narrative_maintenance_repair_leases",
  "narrative_maintenance_wake_outbox",
  "narrative_nir1_chronicle_vectors",
  "narrative_projection_dependencies",
  "narrative_projection_freshness",
  "narrative_proposal_applications",
  "narrative_proposal_decisions",
  "narrative_proposal_revisions",
  "narrative_proposal_sets",
  "narrative_proposals",
  "narrative_revision_source_basis",
  "narrative_runtime_policy",
  "narrative_scene_scope_bindings",
  "narrative_scope_registries",
  "narrative_semantic_epochs",
  "narrative_semantic_index_metadata",
  "narrative_temporal_constraints",
  "narrative_temporal_nodes",
  "narrative_temporal_projections",
  "state_snapshots",
];

const STUB_SOURCE = `export * from "@/../${SCHEMA_CANONICAL_PATH.replace(/\.ts$/, "")}";\n`;

function writeSchemaFixture(root, { canonical, legacy }) {
  if (canonical !== undefined) {
    const file = path.join(root, SCHEMA_CANONICAL_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, canonical);
  }
  if (legacy !== undefined) {
    const file = path.join(root, SCHEMA_LEGACY_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, legacy);
  }
}

function writeRegistryFor(root, tables) {
  const policiesDir = path.join(root, "policies/narrative");
  mkdirSync(policiesDir, { recursive: true });
  const file = path.join(policiesDir, "protected-writers.json");
  writeFileSync(
    file,
    JSON.stringify(
      tables.map((table) => ({
        aggregate: "fixture",
        table,
        protection: "table",
        writer: "narrative.fixture",
        enforcement: "deferred",
      })),
    ),
  );
  return file;
}

describe("validate-narrative-writers schema scan (DR-MP4-3 addendum)", () => {
  const codes = (scan) => scan.violations.map((violation) => violation.code);

  it("reads the real canonical schema, which is a superset of the pre-move table names", () => {
    const scan = scanNarrativeSchema(REPO_ROOT);
    assert.deepEqual(scan.violations, []);
    assert.equal(scan.requireSchema, true);
    assert.equal(scan.canonical.exists, true);
    assert.equal(scan.legacy.exists, true);
    assert.equal(
      scan.legacy.reExportStub,
      true,
      "src/db/schema.ts must be only a re-export of the canonical schema",
    );
    assert.deepEqual(scan.legacy.tables, []);
    const found = new Set(scan.canonical.tables);
    assert.deepEqual(
      BASE_NARRATIVE_SCHEMA_TABLES.filter((table) => !found.has(table)),
      [],
      "narrative tables the validator saw before the move must still be seen",
    );
  });

  it("the CLI --json output reports the same schema scan", () => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts/quality/validate-narrative-writers.mjs"),
        "--json",
      ],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(run.status, 0, run.stderr);
    const json = JSON.parse(run.stdout);
    assert.deepEqual(json.schemaScanViolations, []);
    assert.ok(
      json.schemaScan.canonical.tables.length >=
        BASE_NARRATIVE_SCHEMA_TABLES.length,
    );
  });

  it("T1: an unregistered narrative table is still detected after the move (single- and multi-line forms)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    writeSchemaFixture(root, {
      canonical: [
        'export const narrativeFieldAuthority = sqliteTable("narrative_field_authority", {});',
        "export const narrativeChangeSets = sqliteTable(",
        '  "narrative_change_sets",',
        "  {},",
        ");",
        "",
      ].join("\n"),
      legacy: STUB_SOURCE,
    });
    const result = validateNarrativeWriters({ repoRoot: root, registryPath });
    assert.deepEqual(result.schemaScanViolations, []);
    assert.deepEqual([...result.registryCoverageViolations].sort(), [
      "narrative_change_sets",
      "narrative_field_authority",
    ]);
  });

  it("registering those tables clears the violation (positive control)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeRegistryFor(root, [
      "narrative_field_authority",
      "narrative_change_sets",
    ]);
    writeSchemaFixture(root, {
      canonical:
        'sqliteTable("narrative_field_authority", {}); sqliteTable("narrative_change_sets", {});\n',
      legacy: STUB_SOURCE,
    });
    const result = validateNarrativeWriters({ repoRoot: root, registryPath });
    assert.deepEqual(result.schemaScanViolations, []);
    assert.deepEqual(result.registryCoverageViolations, []);
  });

  it("T2: a stub with no canonical schema fails (strict default and with the fixture opt-out)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    writeSchemaFixture(root, { legacy: STUB_SOURCE });
    assert.deepEqual(codes(scanNarrativeSchema(root)).sort(), [
      "canonical-missing",
      "legacy-stub-dangling",
    ]);
    assert.deepEqual(
      codes(scanNarrativeSchema(root, { requireSchema: false })),
      ["legacy-stub-dangling"],
    );
    const registryPath = writeActiveFixtureRegistry(root);
    assert.equal(
      validateNarrativeWriters({ repoRoot: root, registryPath })
        .schemaScanViolations.length,
      2,
    );
  });

  it("T2b: no schema file at all fails by default and passes only with the explicit opt-out", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    assert.deepEqual(codes(scanNarrativeSchema(root)), ["canonical-missing"]);
    assert.deepEqual(
      scanNarrativeSchema(root, { requireSchema: false }).violations,
      [],
    );
  });

  it("T3: a canonical schema with no narrative table fails, even with the opt-out", () => {
    for (const canonical of [
      "",
      "export const projects = sqliteTable('projects', {});\n",
      "const table = defineNarrativeTable('narrative_field_authority');\n",
    ]) {
      const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
      writeSchemaFixture(root, { canonical, legacy: STUB_SOURCE });
      assert.deepEqual(codes(scanNarrativeSchema(root)), ["canonical-empty"]);
      assert.deepEqual(
        codes(scanNarrativeSchema(root, { requireSchema: false })),
        ["canonical-empty"],
      );
    }
  });

  it("T4: a legacy path that is neither a canonical re-export nor a schema fails", () => {
    const canonical = 'sqliteTable("narrative_field_authority", {});\n';
    for (const legacy of [
      "export const x = 1;\n",
      "",
      'export * from "@/db/somewhere-else";\n',
      `${STUB_SOURCE}export const extra = 1;\n`,
      `export { projects } from "@/../${SCHEMA_CANONICAL_PATH.replace(/\.ts$/, "")}";\n`,
    ]) {
      const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
      writeSchemaFixture(root, { canonical, legacy });
      assert.deepEqual(
        codes(scanNarrativeSchema(root)),
        ["legacy-not-reexport"],
        legacy,
      );
    }
  });

  it("accepts a stub with comments and the .js form, and a legacy file that still defines tables", () => {
    const canonical = 'sqliteTable("narrative_field_authority", {});\n';
    for (const legacy of [
      `// moved\n/* moved */\n${STUB_SOURCE}`,
      `export * from "../../${SCHEMA_CANONICAL_PATH.replace(/\.ts$/, ".js")}";\n`,
      'sqliteTable("narrative_change_sets", {});\n',
    ]) {
      const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
      writeSchemaFixture(root, { canonical, legacy });
      assert.deepEqual(scanNarrativeSchema(root).violations, [], legacy);
    }
  });

  it("T5: the mutation scan still covers the canonical schema's directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const registryPath = writeActiveFixtureRegistry(root);
    writeSchemaFixture(root, {
      canonical: 'sqliteTable("narrative_field_authority", {});\n',
      legacy: STUB_SOURCE,
    });
    const dir = path.join(root, "electron/shared/readDomain/features/example");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "api.ts"),
      "import { narrativeProtectedFixture } from '../../db/schema.js';\nawait db.insert(narrativeProtectedFixture).values({});\n",
    );
    const result = validateNarrativeWriters({ repoRoot: root, registryPath });
    assert.equal(result.violations.length, 1);
    assert.equal(
      result.violations[0].file,
      "electron/shared/readDomain/features/example/api.ts",
    );
  });
});
