// Semantic Phase 3 Batch 4 の実 .node E2E。
// モデルfixtureなしで検証できるpure-DB 6 command、workspace未open、
// resource欠落fail-soft、open/restore後に新しいDBだけを見る契約を固定する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

function makeFixture(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-semantic-${label}-`));
  const appData = join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  // These tests exercise semantic behavior, not automatic backups. Disable
  // backup creation up front so the intentionally detached workspace
  // maintenance worker cannot recreate fixture directories during t.after.
  writeFileSync(
    join(appData, "global-settings.json"),
    JSON.stringify({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
      userPreferences: { "data.autoBackup": "false" },
    }),
  );
  const backend = new Backend(
    appData,
    join(root, "missing-semantic-resources"),
  );
  const events = [];
  backend.onEvent((channel, payload) => events.push({ channel, payload }));
  return {
    root,
    backend,
    events,
    cleanup: () => {
      try {
        rmSync(root, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        });
      } catch (error) {
        // The native Backend can release its SQLite handle after test hooks
        // on Windows, so fixture cleanup is best-effort there.
        if (process.platform !== "win32" || error?.code !== "EPERM") {
          throw error;
        }
      }
    },
  };
}

async function waitForEvent(events, channel, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(
      (event) =>
        event.channel === channel && predicate(JSON.parse(event.payload)),
    );
    if (hit) return JSON.parse(hit.payload);
    if (Date.now() > deadline) {
      throw new Error(`event not received within ${timeoutMs}ms: ${channel}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function exec(backend, sql, params = [], method = "all") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

async function waitForNewBackup(
  backend,
  workspace,
  before,
  timeoutMs = 30000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const created = JSON.parse(await backend.listBackups()).find(
      ({ fileName }) => !before.has(fileName),
    );
    if (created) return created;
    // The fixture's first open may still own the path-scoped maintenance
    // claim. Reopen until the old worker releases it; the first successful
    // claim after that point observes autoBackup=true and creates the backup.
    await backend.openWorkspace(workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`automatic backup was not created within ${timeoutMs}ms`);
}

async function writeTrustedPlainBackup(backend, workspace, path) {
  const before = new Set(
    JSON.parse(await backend.listBackups()).map(({ fileName }) => fileName),
  );
  const settings = JSON.parse(await backend.getGlobalSettings());
  settings.userPreferences = {
    ...(settings.userPreferences ?? {}),
    "data.autoBackup": "true",
    "data.backupInterval": "0",
  };
  await backend.saveGlobalSettings(settings);
  const created = await waitForNewBackup(backend, workspace, before);
  const compressed = readFileSync(join(workspace, "backups", created.fileName));
  writeFileSync(path, gunzipSync(compressed));
}

function tiptapDoc(text) {
  return JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text }] },
    ],
  });
}

async function seedScene(backend, id, title, text) {
  return JSON.parse(
    await backend.treeNodeCreate({
      id,
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title,
      sortOrder: "a0",
      content: tiptapDoc(text),
    }),
  );
}

test("workspace未openではsemantic DB commandsがDB pin時点でfail-closedする", async (t) => {
  const fixture = makeFixture("no-workspace");
  t.after(fixture.cleanup);

  const calls = [
    () => fixture.backend.semanticIndexStatus("default-project"),
    () => fixture.backend.codexIndexStatus("default-project"),
    () => fixture.backend.eventsIndexStatus("default-project"),
    () => fixture.backend.chatIndexStatus("default-project"),
    () => fixture.backend.semanticChunkContext("scene-1", 0, 1, 10),
    () => fixture.backend.semanticDebugDump("default-project"),
    () =>
      fixture.backend.semanticIndexScene(
        join(fixture.root, "workspace"),
        "default-project",
        "scene-1",
      ),
  ];
  for (const call of calls) {
    await assert.rejects(call(), /No workspace is open/);
  }
});

test("pure-DB 6 commandsはcamelCase JSON wireを返しモデルをloadしない", async (t) => {
  const fixture = makeFixture("pure-db");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(join(fixture.root, "workspace"));
  await seedScene(
    fixture.backend,
    "scene-pure",
    "雨の場面",
    "alpha beta gamma",
  );

  const sceneStatus = JSON.parse(
    await fixture.backend.semanticIndexStatus("default-project"),
  );
  assert.equal(sceneStatus.indexedChunkCount, 0);
  assert.equal(sceneStatus.indexedSceneCount, 0);
  assert.equal(sceneStatus.nonemptySceneCount, 1);

  assert.deepEqual(
    JSON.parse(await fixture.backend.codexIndexStatus("default-project")),
    { indexedEntryCount: 0, totalEntryCount: 0 },
  );
  assert.deepEqual(
    JSON.parse(await fixture.backend.eventsIndexStatus("default-project")),
    { indexedEventCount: 0, totalEventCount: 0 },
  );
  assert.deepEqual(
    JSON.parse(await fixture.backend.chatIndexStatus("default-project")),
    { indexedMessageCount: 0, totalMessageCount: 0 },
  );

  const context = JSON.parse(
    await fixture.backend.semanticChunkContext("scene-pure", 0, 5, 6),
  );
  assert.equal(context.sceneTitle, "雨の場面");
  assert.equal(context.chunk, "alpha");

  const dump = JSON.parse(
    await fixture.backend.semanticDebugDump(
      "default-project",
      "scene-pure",
      20,
    ),
  );
  assert.equal(dump.totalChunks, 0);
  assert.equal(dump.returnedChunks, 0);
  assert.deepEqual(dump.chunks, []);
});

test("resource root欠落でもBackend/pure-DBは生き、embedding commandだけ明示エラー", async (t) => {
  const fixture = makeFixture("missing-resource");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(join(fixture.root, "workspace"));
  await seedScene(fixture.backend, "scene-missing", "S", "model required");

  await assert.rejects(
    fixture.backend.semanticIndexScene(
      join(fixture.root, "workspace"),
      "default-project",
      "scene-missing",
    ),
    /embedding model .* is not installed/,
  );
  const status = JSON.parse(
    await fixture.backend.semanticIndexStatus("default-project"),
  );
  assert.equal(status.nonemptySceneCount, 1);
  assert.deepEqual(await exec(fixture.backend, "SELECT 1 AS ok", [], "get"), [
    { ok: 1 },
  ]);
});

test("空project再indexはresource欠落でもdone progressをEventQueueへ全wire付きで流す", async (t) => {
  const fixture = makeFixture("reindex-event");
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "workspace");
  await fixture.backend.openWorkspace(workspace);

  assert.equal(
    JSON.parse(
      await fixture.backend.semanticReindexAll(
        workspace,
        "default-project",
        "run-empty-project",
      ),
    ),
    0,
  );
  const progress = await waitForEvent(
    fixture.events,
    "semantic:reindex_progress",
    (payload) => payload.runId === "run-empty-project",
  );
  assert.deepEqual(progress, {
    sceneIndex: 0,
    sceneId: "",
    totalScenes: 0,
    chunksIndexed: 0,
    done: true,
    projectId: "default-project",
    runId: "run-empty-project",
  });
});

test("openWorkspace後は同一IDでも新DBだけを読み、旧epochの状態を参照しない", async (t) => {
  const fixture = makeFixture("open-epoch");
  t.after(fixture.cleanup);
  const workspaceA = join(fixture.root, "workspace-a");
  const workspaceB = join(fixture.root, "workspace-b");

  await fixture.backend.openWorkspace(workspaceA);
  await seedScene(fixture.backend, "collision", "Workspace A", "alpha only");
  const fromA = JSON.parse(
    await fixture.backend.semanticChunkContext("collision", 0, 5, 8),
  );
  assert.equal(fromA.sceneTitle, "Workspace A");
  assert.equal(fromA.chunk, "alpha");
  await fixture.backend.codexRebuildMatcher([
    {
      id: "workspace-a-entry",
      name: "旧ワークスペース人物",
      entryType: "character",
      aliases: [],
      excludedAliases: [],
    },
  ]);
  assert.equal(
    JSON.parse(
      await fixture.backend.codexMatchText("旧ワークスペース人物", []),
    ).length,
    1,
  );

  await fixture.backend.openWorkspace(workspaceB);
  assert.deepEqual(
    JSON.parse(
      await fixture.backend.codexMatchText("旧ワークスペース人物", []),
    ),
    [],
    "workspace swapはDB由来matcherも破棄する",
  );
  await seedScene(fixture.backend, "collision", "Workspace B", "bravo only");
  const auditCountBefore = await exec(
    fixture.backend,
    "SELECT COUNT(*) AS count FROM ai_audit_events",
    [],
    "get",
  );
  const staleInferenceCalls = [
    () =>
      fixture.backend.semanticSearch(
        workspaceA,
        "default-project",
        "collision",
        5,
        null,
        false,
      ),
    () =>
      fixture.backend.semanticReindexAll(
        workspaceA,
        "default-project",
        "stale-semantic-reindex",
      ),
    () =>
      fixture.backend.codexSemanticSearch(
        workspaceA,
        "default-project",
        "collision",
        5,
      ),
    () => fixture.backend.codexReindexAll(workspaceA, "default-project"),
    () =>
      fixture.backend.eventsSemanticSearch(
        workspaceA,
        "default-project",
        "collision",
        5,
      ),
    () => fixture.backend.eventsReindexAll(workspaceA, "default-project"),
    () =>
      fixture.backend.chatMessageSearch(
        workspaceA,
        "default-project",
        "collision",
        5,
      ),
    () => fixture.backend.chatReindexAll(workspaceA, "default-project"),
    () =>
      fixture.backend.semanticRerankerShadowScore({
        requestId: "stale-reranker",
        expectedWorkspacePath: workspaceA,
        projectId: "default-project",
        auditPathId: "semantic_reranker_shadow",
        language: "ja",
        userMessage: "collision",
        sceneTail: "",
        candidates: [{ candidateId: "collision:0:5", text: "bravo" }],
      }),
  ];
  for (const call of staleInferenceCalls) {
    await assert.rejects(call(), /SEMANTIC_INDEX_WORKSPACE_CHANGED/);
  }
  await assert.rejects(
    fixture.backend.semanticIndexScene(
      workspaceA,
      "default-project",
      "collision",
    ),
    /SEMANTIC_INDEX_WORKSPACE_CHANGED/,
  );
  await assert.rejects(
    fixture.backend.semanticIndexScene(
      workspaceB,
      "another-project",
      "collision",
    ),
    /SEMANTIC_INDEX_AUTHORITY_MISMATCH/,
  );
  assert.deepEqual(
    await exec(
      fixture.backend,
      "SELECT COUNT(*) AS count FROM ai_audit_events",
      [],
      "get",
    ),
    auditCountBefore,
    "workspace/project authority mismatch must stop before inference/audit",
  );
  const fromB = JSON.parse(
    await fixture.backend.semanticChunkContext("collision", 0, 5, 8),
  );
  assert.equal(fromB.sceneTitle, "Workspace B");
  assert.equal(fromB.chunk, "bravo");
});

test("restoreBackup再活性化後は復元DBだけを読みsemantic commandsを継続できる", async (t) => {
  const fixture = makeFixture("restore-epoch");
  t.after(fixture.cleanup);
  const workspace = join(fixture.root, "workspace");
  const backups = join(workspace, "backups");
  await fixture.backend.openWorkspace(workspace);
  const seededScene = await seedScene(
    fixture.backend,
    "restore-scene",
    "Before",
    "saved state",
  );
  mkdirSync(backups, { recursive: true });
  const backupName = "grimodex-20260711-130000.db";
  await writeTrustedPlainBackup(
    fixture.backend,
    workspace,
    join(backups, backupName),
  );
  await fixture.backend.treeNodePatch({
    projectId: "default-project",
    nodeId: "restore-scene",
    patch: { title: "After", content: tiptapDoc("mutated state") },
    baseVersion: seededScene.version,
    bumpVersion: true,
    updatedAt: new Date().toISOString(),
  });

  await fixture.backend.restoreBackup(backupName);
  const restored = JSON.parse(
    await fixture.backend.semanticChunkContext("restore-scene", 0, 5, 8),
  );
  assert.equal(restored.sceneTitle, "Before");
  assert.equal(restored.chunk, "saved");
  const status = JSON.parse(
    await fixture.backend.semanticIndexStatus("default-project"),
  );
  assert.equal(status.nonemptySceneCount, 1);
});
