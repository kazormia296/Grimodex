// NIR-1 CP-3a S2a (P1-2): what a restricted renderer can already read.
//
// `related_scenes_graph_continue` takes the Raw R from the renderer. R must be
// a selection out of the dense hits `begin` returned, but the renderer can still
// name a hit it did not select. This file fixes, against the real Native, the
// facts the residual argument rests on (cp3a-decisions.md, DR-CP3A-17): a
// restricted renderer reads the pin table and the Scene rows (title, body, the
// body declaration) by generic SQL, and the typed Revision tables are closed to
// generic SQL but reachable through the typed `nir1-publication` readers. The
// Graph's reach (Scene to pin to Entity to path) therefore contains nothing the
// renderer cannot derive; a false R changes only which of its own dense hits
// carry a path and whether the one Graph-only slot is open.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const DENIED = /D2A_EGRESS_DENIED/;

async function restrictedRig(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-graph-reach-${label}-`));
  const backend = new Backend(join(root, "app-data"));
  await backend.initializeProfileEgress();
  const status = JSON.parse(await backend.activateProfileEgress());
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const identity = {
    profileId: status.profileId,
    callerId: "main-caller",
    callerEpoch: status.callerEpoch,
    senderId: 42,
    workspaceId: workspace,
    sessionId: "main-session",
  };
  await backend.registerProfileEgressCaller(JSON.stringify(identity));
  return {
    root,
    backend,
    status,
    workspace,
    wire: JSON.stringify(identity),
    async close() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const run = (rig, sql, own) =>
  rig.backend.dbExecute(sql, [], "all", rig.wire, own);

test("the pin table and the Scene rows are readable by generic SQL from a restricted renderer", async () => {
  const rig = await restrictedRig("pins");
  try {
    const policy = rig.status.sqlPolicy;
    for (const table of ["scene_codex_pins", "tree_nodes", "codex_entries"]) {
      assert.ok(!policy.closedTables.includes(table), `${table} is not closed`);
      assert.ok(
        !policy.readOpenTables.includes(table),
        `${table} is not a ledger table`,
      );
      for (const own of [undefined, true]) {
        const result = JSON.parse(
          await run(rig, `SELECT * FROM ${table} LIMIT 1`, own),
        );
        assert.ok(Array.isArray(result.rows), `${table} read (${own})`);
      }
    }
    // The body declaration of a Scene lives on the Scene row.
    const columns = JSON.parse(
      await run(rig, "SELECT name FROM pragma_table_info('tree_nodes')", true),
    ).rows.map((row) => row.name);
    assert.ok(columns.includes("content"));
    assert.ok(columns.includes("title"));
  } finally {
    await rig.close();
  }
});

test("the typed Revision tables are closed to generic SQL and open to the typed readers", async () => {
  const rig = await restrictedRig("revisions");
  try {
    for (const table of [
      "narrative_proposal_revisions",
      "narrative_proposals",
      "narrative_extraction_runs",
    ]) {
      assert.ok(rig.status.sqlPolicy.closedTables.includes(table), table);
      for (const own of [undefined, true]) {
        await assert.rejects(
          run(rig, `SELECT * FROM ${table} LIMIT 1`, own),
          DENIED,
          `${table} (${own})`,
        );
      }
    }
    // The typed `nir1-publication` reader admits the registered renderer; the
    // request fails on its own domain ground (no such project), not on D2a.
    await rig.backend
      .nir1EntityRelationRevisionRead(
        {
          expectedWorkspacePath: rig.workspace,
          projectId: "no-project",
          revisionId: "no-revision",
        },
        rig.wire,
      )
      .then(
        () => undefined,
        (error) => assert.doesNotMatch(String(error?.message ?? error), DENIED),
      );
  } finally {
    await rig.close();
  }
});
