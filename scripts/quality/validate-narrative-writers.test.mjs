import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNarrativeWriters } from "./validate-narrative-writers.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const REGISTRY_PATH = path.join(
  REPO_ROOT,
  "policies/narrative/protected-writers.json",
);

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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({ repoRoot: root, registryPath });
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
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

    const result = validateNarrativeWriters({
      repoRoot: root,
      registryPath,
    });
    assert.equal(result.violations.length, 0);
  });
});
