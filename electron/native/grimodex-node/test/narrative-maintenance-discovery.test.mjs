// Main-only Narrative Maintenance discovery boundary.
// Run after `pnpm napi:build` with:
//   node --import ./test/test-bootstrap.mjs --test test/narrative-maintenance-discovery.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

function createFixture(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-maintenance-${label}-`));
  const backend = new Backend(join(root, "app-data"));
  return {
    root,
    backend,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 20 });
    },
  };
}

function projectPayload(projectId) {
  return {
    projectId,
    requestId: `${projectId}-request`,
    sessionId: `${projectId}-session`,
    eventUid: `${projectId}-event`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
    title: projectId,
    genre: null,
    pov: null,
    tense: null,
    language: "en",
    styleGuide: null,
    aiInstructions: null,
    outline: null,
    targetReaders: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

test(
  "one N-API discovery call returns one binding and bounded stable pages",
  { timeout: 30_000 },
  async (t) => {
    const fixture = fixtureForTest(t, "pages");
    await fixture.backend.openWorkspace(join(fixture.root, "workspace"));
    for (let index = 0; index < 33; index += 1) {
      await fixture.backend.projectCreate(projectPayload(`maintenance-${index}`));
    }

    const result = JSON.parse(
      await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
    );
    assert.equal(typeof result.workspaceBinding.authorityId, "string");
    assert.equal(Number.isSafeInteger(result.workspaceBinding.generation), true);
    assert.ok(result.pages.length >= 2, "33 projects require multiple pages");
    assert.ok(
      result.pages.every(({ work }) => work.length <= 32),
      "native pages are bounded before main receives them",
    );
    const projectIds = result.pages.flatMap(({ work }) =>
      work.map(({ projectId }) => projectId),
    );
    assert.deepEqual(projectIds, [...projectIds].sort());
    assert.ok(projectIds.includes("maintenance-0"));
    assert.ok(projectIds.includes("maintenance-32"));
    for (const work of result.pages.flatMap(({ work }) => work)) {
      assert.equal("graphContractDigest" in work, false);
      assert.equal("ruleRegistryDigest" in work, false);
      assert.equal("producerGenerationSetDigest" in work, false);
      assert.notEqual(work.runKind, "repair");
    }
  },
);

test("restore install creates a fresh epoch whose first durable work is Verify", async (t) => {
  const fixture = fixtureForTest(t, "restore");
  const workspace = join(fixture.root, "workspace");
  await fixture.backend.openWorkspace(workspace);
  const initial = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  const initialWork = initial.pages.flatMap(({ work }) => work).slice(0, 1);
  assert.equal(initialWork.length, 1, "open must discover initial Backfill");
  await fixture.backend.runNarrativeMaintenanceCycle({
    work: initialWork,
    wakeProjectIds: [],
    workspaceBinding: initial.workspaceBinding,
  });
  const beforeEpoch = JSON.parse(
    await fixture.backend.dbExecute(
      "SELECT id FROM narrative_semantic_epochs WHERE project_id = ? ORDER BY epoch_number DESC LIMIT 1",
      ["default-project"],
      "get",
    ),
  ).rows[0]?.id;
  assert.equal(typeof beforeEpoch, "string");
  await fixture.backend.vacuumDatabase();
  const backupName = "grimodex-maintenance-restore.db";
  copyFileSync(join(workspace, "grimodex.db"), join(workspace, "backups", backupName));
  await fixture.backend.restoreBackup(backupName);
  const result = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("restore-completed"),
  );
  const restoredWork = result.pages.flatMap(({ work }) => work);
  assert.ok(restoredWork.length > 0);
  assert.equal(restoredWork[0].runKind, "dependency-verify");
  assert.notEqual(restoredWork[0].semanticEpochId, beforeEpoch);
});

test("the live binding round-trips into the cycle without a detached path", async (t) => {
  const fixture = fixtureForTest(t, "binding");
  await fixture.backend.openWorkspace(join(fixture.root, "workspace"));
  const discovery = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  const work = discovery.pages.flatMap(({ work }) => work).slice(0, 1);
  if (work.length === 0) {
    return;
  }
  const result = JSON.parse(
    await fixture.backend.runNarrativeMaintenanceCycle({
      work,
      wakeProjectIds: [],
      workspaceBinding: discovery.workspaceBinding,
    }),
  );
  assert.ok(["accepted", "coalesced", "deferred"].includes(result.status));
});

test("an authority swap fail-closes an old discovery binding", async (t) => {
  const fixture = fixtureForTest(t, "authority-swap");
  const firstWorkspace = join(fixture.root, "workspace-a");
  const secondWorkspace = join(fixture.root, "workspace-b");
  await fixture.backend.openWorkspace(firstWorkspace);
  const first = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  const firstWork = first.pages.flatMap(({ work }) => work).slice(0, 1);
  await fixture.backend.openWorkspace(secondWorkspace);
  const second = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  assert.notEqual(
    second.workspaceBinding.authorityId,
    first.workspaceBinding.authorityId,
    "a workspace replacement must receive a new authority identity",
  );
  if (firstWork.length === 0) return;
  const stale = JSON.parse(
    await fixture.backend.runNarrativeMaintenanceCycle({
      work: firstWork,
      wakeProjectIds: [],
      workspaceBinding: first.workspaceBinding,
    }),
  );
  assert.equal(stale.status, "workspace-unavailable");
  assert.match(stale.reason ?? "", /binding|workspace|snapshot/i);
});

test("foreground authoring and a background wake share one live writer", async (t) => {
  const fixture = fixtureForTest(t, "concurrency");
  const workspace = join(fixture.root, "workspace");
  await fixture.backend.openWorkspace(workspace);
  const discovery = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  const work = discovery.pages.flatMap(({ work }) => work).slice(0, 1);
  if (work.length === 0) return;

  const [foreground, background] = await Promise.allSettled([
    fixture.backend.projectCreate(projectPayload("foreground-project")),
    fixture.backend.runNarrativeMaintenanceCycle({
      work,
      wakeProjectIds: [],
      workspaceBinding: discovery.workspaceBinding,
    }),
  ]);
  assert.equal(foreground.status, "fulfilled");
  assert.equal(background.status, "fulfilled");
  assert.doesNotMatch(
    JSON.stringify([foreground, background]),
    /SQLITE_BUSY_SNAPSHOT|detached|second writer/i,
  );
});

test("Repair cannot cross the N-API automatic work enum", async (t) => {
  const fixture = fixtureForTest(t, "repair");
  await fixture.backend.openWorkspace(join(fixture.root, "workspace"));
  const discovery = JSON.parse(
    await fixture.backend.discoverNarrativeMaintenanceWork("workspace-opened"),
  );
  await assert.rejects(
    fixture.backend.runNarrativeMaintenanceCycle({
      work: [
        {
          projectId: "default-project",
          runKind: "repair",
          workKey: "repair",
          semanticEpochId: null,
          reasons: ["forged"],
        },
      ],
      wakeProjectIds: [],
      workspaceBinding: discovery.workspaceBinding,
    }),
    (error) => /repair|run.kind|unknown variant/i.test(String(error?.message)),
  );
});

function fixtureForTest(t, label) {
  const instance = createFixture(label);
  t.after(instance.cleanup);
  return instance;
}
