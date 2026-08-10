import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNarrativeWriters } from "./validate-narrative-writers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

describe("validate-narrative-writers", () => {
  it("passes for the bundled registry with fixture-only active tables", () => {
    const result = validateNarrativeWriters({ repoRoot: REPO_ROOT });
    assert.equal(result.violations.length, 0);
    assert.ok(result.activeCount >= 1);
    assert.ok(result.deferredCount >= 1);
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
