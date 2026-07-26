import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-sample-seed-"));
const appDataDir = join(root, "app-data");
const backend = new Backend(appDataDir);
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

test("seedSampleWorkspace creates a complete sample and exposes its active path after open", async () => {
  await assert.rejects(
    backend.getActiveWorkspacePath(),
    /No workspace is open/,
  );

  const policy = '{"preset":"full","toggles":{"chat":true}}';
  const seeded = JSON.parse(await backend.seedSampleWorkspace("en", policy));
  assert.equal(dirname(seeded.path), appDataDir);
  assert.match(
    seeded.path.slice(appDataDir.length + 1),
    /^sample-workspace-[0-9a-f-]{36}$/,
  );
  assert.equal(seeded.projectId, "default-project");
  assert.equal(backend.validateWorkspacePath(seeded.path), true);

  const settings = JSON.parse(await backend.getGlobalSettings());
  assert.equal(settings.sampleWorkspacePath, seeded.path);

  await backend.openWorkspace(seeded.path);
  assert.equal(await backend.getActiveWorkspacePath(), seeded.path);
  const project = JSON.parse(
    await backend.dbExecute(
      "SELECT language, ai_policy, is_sample FROM projects WHERE id = ?",
      ["default-project"],
      "get",
    ),
  ).rows[0];
  assert.deepEqual(project, {
    language: "en",
    ai_policy: policy,
    is_sample: 1,
  });
  const counts = JSON.parse(
    await backend.dbExecute(
      "SELECT (SELECT COUNT(*) FROM tree_nodes) AS nodes, " +
        "(SELECT COUNT(*) FROM codex_entries) AS codex, " +
        "(SELECT COUNT(*) FROM authorship_spans) AS spans",
      [],
      "get",
    ),
  ).rows[0];
  assert.ok(counts.nodes > 0);
  assert.ok(counts.codex > 0);
  assert.ok(counts.spans > 0);

  const secondPolicy = '{"preset":"assist","slot":2}';
  const second = JSON.parse(
    await backend.seedSampleWorkspace("ja", secondPolicy),
  );
  assert.equal(dirname(second.path), appDataDir);
  assert.match(
    second.path.slice(appDataDir.length + 1),
    /^sample-workspace-[0-9a-f-]{36}$/,
  );
  assert.notEqual(second.path, seeded.path);
  assert.equal(
    backend.validateWorkspacePath(seeded.path),
    true,
    "a published generation must remain available while it may still be open",
  );
  assert.equal(
    await backend.getActiveWorkspacePath(),
    seeded.path,
    "seeding must not swap or unlink the active primary DB",
  );
  const beforeSwap = JSON.parse(
    await backend.dbExecute(
      "SELECT language FROM projects WHERE id = ?",
      ["default-project"],
      "get",
    ),
  ).rows[0];
  assert.equal(beforeSwap.language, "en");

  await backend.openWorkspace(second.path);
  assert.equal(await backend.getActiveWorkspacePath(), second.path);
  const afterSwap = JSON.parse(
    await backend.dbExecute(
      "SELECT language, ai_policy FROM projects WHERE id = ?",
      ["default-project"],
      "get",
    ),
  ).rows[0];
  assert.deepEqual(afterSwap, { language: "ja", ai_policy: secondPolicy });

  const third = JSON.parse(
    await backend.seedSampleWorkspace("en", '{"slot":3}'),
  );
  assert.equal(dirname(third.path), appDataDir);
  assert.notEqual(third.path, seeded.path);
  assert.notEqual(third.path, second.path);
  assert.equal(backend.validateWorkspacePath(seeded.path), true);
  assert.equal(backend.validateWorkspacePath(second.path), true);
  assert.equal(await backend.getActiveWorkspacePath(), second.path);

  await backend.openWorkspace(seeded.path);
  const originalGeneration = JSON.parse(
    await backend.dbExecute(
      "SELECT language, ai_policy FROM projects WHERE id = ?",
      ["default-project"],
      "get",
    ),
  ).rows[0];
  assert.deepEqual(originalGeneration, { language: "en", ai_policy: policy });
});
