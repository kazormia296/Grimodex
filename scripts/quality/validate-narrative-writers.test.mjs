import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { validateNarrativeWriters } from "./validate-narrative-writers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("validate-narrative-writers", () => {
  it("passes for the bundled registry with fixture-only active tables", () => {
    const result = validateNarrativeWriters({ repoRoot: REPO_ROOT });
    assert.equal(result.violations.length, 0);
    assert.ok(result.activeCount >= 1);
    assert.ok(result.deferredCount >= 1);
  });

  it("fails when production source mutates an active protected table", () => {
    const root = mkdtempSync(path.join(tmpdir(), "narrative-writers-"));
    const policiesDir = path.join(root, "policies/narrative");
    const srcDir = path.join(root, "src/features/example");
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
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
      ]),
    );
    writeFileSync(
      path.join(srcDir, "api.ts"),
      "import { narrativeProtectedFixture } from '@/db/schema';\nawait db.insert(narrativeProtectedFixture).values({});\n",
    );

    const result = validateNarrativeWriters({
      repoRoot: root,
      registryPath: path.join(policiesDir, "protected-writers.json"),
    });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].table, "narrative_protected_fixture");
  });
});
