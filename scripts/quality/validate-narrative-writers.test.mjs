import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
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
});
