import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));
const root = mkdtempSync(join(tmpdir(), "grimodex-nir1-change-review-"));

process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));

after(async () => {
  const wire = await backend.shutdownWorkspaceLifecycle();
  assert.equal(JSON.parse(wire).status, "closed");
});

async function rows(sql) {
  return JSON.parse(await backend.dbExecute(sql, [], "all")).rows;
}

async function rowCounts() {
  const tables = [
    "narrative_extraction_runs",
    "narrative_proposal_sets",
    "narrative_proposals",
    "narrative_proposal_revisions",
    "narrative_proposal_decisions",
    "narrative_revision_source_basis",
    "narrative_dependency_edges",
    "narrative_dependency_declaration_sets",
    "narrative_dependency_declaration_entries",
    "narrative_dependency_declaration_heads",
    "narrative_semantic_epochs",
    "narrative_semantic_index_metadata",
    "narrative_consumer_freshness",
    "codex_entries",
    "codex_relations",
  ];
  const counts = {};
  for (const table of tables) {
    counts[table] = (
      await rows(`SELECT COUNT(*) AS count FROM ${table}`)
    )[0].count;
  }
  return counts;
}

test("N-API preserves Unavailable reasons and performs no writes", async () => {
  const workspacePath = join(root, "workspace");
  await backend.openWorkspace(workspacePath);
  const before = await rowCounts();

  const result = JSON.parse(
    await backend.nir1ChangeReviewRead({
      projectId: "missing-project",
      revisionId: "missing-revision",
    }),
  );

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "current-revision-unavailable",
  });
  assert.deepEqual(await rowCounts(), before);
});
