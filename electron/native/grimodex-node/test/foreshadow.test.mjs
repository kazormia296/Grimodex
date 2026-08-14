// foreshadow napi 写像の roundtrip + 境界テスト (Electron 移行 Phase 3 バッチ1)。
//
// grimodex-db::foreshadow を Tauri と共用する napi 写像を、ビルド済み
// grimodex-node.node に対して end-to-end で検証する。Rust 単体テストが直接
// 触れない **napi 境界** に集中する:
//   - i64 の JSON 往復 (save_anchors の doc_content_size ガード / setup_create_ai
//     の from/to_pos / load_anchors の座標) — normalize_integer_numbers 依存。
//   - Option<Option<T>> の null クリア (update の intent)。
//   - Option<String> 返り (resolve_orphan の reinsert new_id / None→null)。
//   - camelCase mark 出力 (load_anchors)。
//   - load_bearing のワイヤエラー文字列。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`。
// 宣言順に直列実行される (共有 Backend の状態に依存。順序を変えないこと)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-fore-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project"; // migrate seed

function mutationIdentity(requestId, projectId = PROJECT, origin = "human") {
  const isInteractiveAgent = origin === "ai-apply";
  const isRestore = origin === "restore";
  return {
    requestId,
    projectId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    authorityRoute: isInteractiveAgent
      ? "interactive-agent-command"
      : isRestore
        ? "restore-or-migration"
        : "human-direct",
    caller: isInteractiveAgent
      ? "chat-tool-executor"
      : isRestore
        ? "restore-controller"
        : "manual-wrapper",
    controls: isInteractiveAgent
      ? [
          "knowledge-write-policy",
          "stable-request-id",
          "agent-provenance",
          "typed-writer",
          "occ",
          "undo-journal",
          "change-event",
          "change-feed",
        ]
      : isRestore
        ? [
            "exclusive-system-operation",
            "semantic-epoch-event",
            "full-rebuild-marker",
          ]
      : [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
    provenance: isInteractiveAgent
      ? { requestId, traceId: `${requestId}:trace` }
      : null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
  };
}

/** WHERE で一意に絞った SELECT の 1 行（無ければ undefined）を返す。 */
async function row(sql, params = []) {
  const res = JSON.parse(await backend.dbExecute(sql, params, "all"));
  return res.rows[0];
}
async function firstForeshadow() {
  return JSON.parse(await backend.foreshadowListWithLabels(PROJECT))
    .foreshadows[0];
}

async function createScene(id, projectId = PROJECT) {
  const requestId = `foreshadow-scene-create:${projectId}:${id}`;
  return JSON.parse(
    await backend.treeNodeCreate({
      ...mutationIdentity(requestId, projectId),
      undoJournalId: null,
      id,
      projectId,
      parentId: null,
      nodeType: "scene",
      title: id,
      sortOrder: `test-${id}`,
      synopsis: null,
      status: null,
      sourceUri: null,
      sourceMtime: null,
      content: "{}",
    }),
  );
}

test("workspace 未オープンの foreshadowListWithLabels は 'No workspace is open' で reject", async () => {
  await assert.rejects(backend.foreshadowListWithLabels(PROJECT), (err) => {
    assert.match(String(err.message), /No workspace is open/);
    return true;
  });
});

test("foreshadowCreate は load_bearing を検証する（ワイヤエラー文字列）", async () => {
  await backend.openWorkspace(join(root, "ws"));

  await assert.rejects(
    backend.foreshadowCreate({
      ...mutationIdentity("foreshadow-invalid-load-bearing"),
      projectId: PROJECT,
      title: "不正",
      intent: null,
      loadBearing: "required",
    }),
    (err) => {
      assert.match(String(err.message), /invalid load_bearing value/);
      return true;
    },
  );
});

test("renderer canonical create は未知の caller を mutation 前に拒否する", async () => {
  const invalidTree = {
    ...mutationIdentity("renderer-authority-invalid-tree"),
    undoJournalId: null,
    caller: "background-maintenance-v2",
    id: "renderer-authority-invalid-tree",
    parentId: null,
    nodeType: "scene",
    title: "拒否されるシーン",
    sortOrder: "authority-invalid-tree",
    synopsis: null,
    status: null,
    sourceUri: null,
    sourceMtime: null,
    content: "{}",
  };
  await assert.rejects(backend.treeNodeCreate(invalidTree), /Forbidden caller/);
  assert.equal(
    await row("SELECT id FROM tree_nodes WHERE id = ?", [invalidTree.id]),
    undefined,
  );

  const invalidForeshadow = {
    ...mutationIdentity("renderer-authority-invalid-foreshadow"),
    caller: "background-maintenance-v2",
    id: "renderer-authority-invalid-foreshadow",
    title: "拒否される伏線",
    intent: null,
    notes: null,
    loadBearing: null,
  };
  await assert.rejects(
    backend.foreshadowCreate(invalidForeshadow),
    /Forbidden caller/,
  );
  assert.equal(
    await row("SELECT id FROM foreshadows WHERE id = ?", [invalidForeshadow.id]),
    undefined,
  );
});

test("foreshadowCreate → update は nullable field の null と欠落を区別する", async () => {
  await createScene("foreshadow-payoff-scene");
  const createPayload = {
    ...mutationIdentity("foreshadow-napi-request-1"),
    id: "foreshadow-napi-request-1",
    projectId: PROJECT,
    title: "刹那の伏線",
    intent: "最初の意図",
    notes: "full-row note",
    payoffSceneId: "foreshadow-payoff-scene",
    payoffFromPos: 3,
    payoffToPos: 9,
    payoffConfirmed: true,
    abandoned: true,
    secret: false,
    loadBearing: "critical",
    codexLinkDirtyAt: 1784000000000,
  };
  const created = JSON.parse(await backend.foreshadowCreate(createPayload));
  assert.equal(created.title, "刹那の伏線");
  assert.equal(created.intent, "最初の意図");
  assert.equal(created.notes, "full-row note");
  assert.equal(created.payoff_scene_id, "foreshadow-payoff-scene");
  assert.equal(created.payoff_from_pos, 3);
  assert.equal(created.payoff_to_pos, 9);
  assert.equal(created.payoff_confirmed, 1);
  assert.equal(created.abandoned, 1);
  assert.equal(created.secret, 0);
  assert.equal(created.load_bearing, "critical");
  assert.equal(created.codex_link_dirty_at, 1784000000000);
  const fid = created.id;
  assert.equal(fid, createPayload.id);
  assert.deepEqual(created.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const createEvent = await row(
    "SELECT payload FROM change_events WHERE event_uid = ?",
    [createPayload.eventUid],
  );
  const createEventPayload = JSON.parse(createEvent.payload);
  assert.equal(createEventPayload.authorityRoute, "human-direct");
  assert.equal(createEventPayload.authorityCaller, "manual-wrapper");
  assert.equal(createEventPayload.authorityEvidence.validated, true);
  const replay = JSON.parse(await backend.foreshadowCreate(createPayload));
  assert.equal(replay.id, created.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
  await assert.rejects(
    backend.foreshadowCreate({ ...createPayload, title: "別の伏線" }),
    /FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT/,
  );

  // Some(Some) — 値セットは効く（到達可能な唯一の書き込み経路）。
  const setted = JSON.parse(
    await backend.foreshadowUpdate(fid, {
      ...mutationIdentity("foreshadow-napi-update-intent"),
      baseVersion: created.version,
      intent: "改訂した意図",
    }),
  );
  assert.equal(setted.intent, "改訂した意図");
  assert.equal(setted.title, "刹那の伏線", "title は不変");

  // Nullable fields omitted from a patch stay unchanged at the N-API boundary.
  const omitted = JSON.parse(
    await backend.foreshadowUpdate(fid, {
      ...mutationIdentity("foreshadow-napi-update-title"),
      baseVersion: setted.version,
      title: "刹那の伏線（改題）",
    }),
  );
  assert.equal(omitted.intent, "改訂した意図");
  assert.equal(omitted.notes, "full-row note");
  assert.equal(omitted.payoff_scene_id, "foreshadow-payoff-scene");
  assert.equal(omitted.load_bearing, "critical");

  // Explicit JSON null clears every nullable Foreshadow patch field.
  const nulled = JSON.parse(
    await backend.foreshadowUpdate(fid, {
      ...mutationIdentity("foreshadow-napi-update-nullable"),
      baseVersion: omitted.version,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      loadBearing: null,
    }),
  );
  assert.equal(nulled.intent, null);
  assert.equal(nulled.notes, null);
  assert.equal(nulled.payoff_scene_id, null);
  assert.equal(nulled.payoff_from_pos, null);
  assert.equal(nulled.payoff_to_pos, null);
  assert.equal(nulled.load_bearing, null);

  // 空 patch は現行行をそのまま返す。
  const noop = JSON.parse(
    await backend.foreshadowUpdate(fid, {
      ...mutationIdentity("foreshadow-napi-update-noop"),
      baseVersion: nulled.version,
    }),
  );
  assert.equal(noop.id, fid);
  assert.equal(noop.version, nulled.version);
});

test("foreshadowCreate requestId-only は同じ entity と ledger を replay する", async () => {
  const payload = {
    ...mutationIdentity("foreshadow-napi-request-only"),
    title: "request only",
    intent: null,
    loadBearing: null,
  };
  const created = JSON.parse(await backend.foreshadowCreate(payload));
  const replay = JSON.parse(await backend.foreshadowCreate(payload));
  assert.equal(created.id, payload.requestId);
  assert.equal(replay.id, created.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
});

test("foreshadowCreate は delete 後も request tombstone を replay し deliberate restore を区別する", async () => {
  const payload = {
    ...mutationIdentity("foreshadow-napi-request-deleted"),
    id: "foreshadow-napi-entity-deleted",
    title: "削除後に復活しない伏線",
    intent: "SECRET_NAPI_FORESHADOW_SENTINEL",
    loadBearing: null,
  };
  const created = JSON.parse(await backend.foreshadowCreate(payload));
  const deleted = JSON.parse(
    await backend.foreshadowDelete({
      ...mutationIdentity("foreshadow-napi-delete"),
      id: payload.id,
      baseVersion: created.version,
    }),
  );
  assert.equal(typeof deleted.undoJournalId, "string");

  const replay = JSON.parse(await backend.foreshadowCreate(payload));
  assert.equal(replay.id, payload.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: false,
  });
  assert.equal(
    await row("SELECT id FROM foreshadows WHERE id = ?", [payload.id]),
    undefined,
  );

  const restored = JSON.parse(
    await backend.foreshadowCreate({
      ...payload,
      ...mutationIdentity(
        "foreshadow-napi-history-restore",
        PROJECT,
        "restore",
      ),
    }),
  );
  assert.equal(restored.id, payload.id);
  assert.deepEqual(restored.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
});

test("setup_create_ai → load_anchors: i64 座標が JSON 往復で保存され camelCase mark で返る", async () => {
  await createScene("sc1");
  const fs = await firstForeshadow();

  const setupCreated = JSON.parse(
    await backend.foreshadowSetupCreateAi({
      ...mutationIdentity(
        "foreshadow-napi-setup-create-ai",
        PROJECT,
        "ai-apply",
      ),
      id: "setup-ai-1",
      foreshadowId: fs.id,
      baseVersion: fs.version,
      sceneId: "sc1",
      fromPos: 10,
      toPos: 20,
      kind: "designated_existing",
      strength: "overt",
      aiStrength: "medium",
      attribution: "ai",
      aiRationale: null,
      aiReasoning: "preserve me",
      lastEvaluatedAt: 1783664540830, // Date.now() 相当（f64→i64 正規化の検証）
    }),
  );

  // DB に i64 がそのまま入っている（REAL 混入していない）。
  const r = await row(
    "SELECT from_pos, to_pos, last_evaluated_at FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(r.from_pos, 10);
  assert.equal(r.to_pos, 20);
  assert.equal(r.last_evaluated_at, 1783664540830);

  const marks = JSON.parse(await backend.foreshadowLoadAnchorsForScene("sc1"));
  const setupMark = marks.find((m) => m.markName === "foreshadowSetup");
  assert.ok(setupMark, "setup mark が返る");
  assert.equal(setupMark.from, 10);
  assert.equal(setupMark.to, 20);
  assert.equal(setupMark.attrs.setupId, "setup-ai-1");
  assert.equal(setupMark.attrs.foreshadowId, fs.id);
  assert.equal(setupMark.attrs.baseVersion, setupCreated.version);

  const setupOmitted = JSON.parse(
    await backend.foreshadowUpdateSetup("setup-ai-1", {
      ...mutationIdentity("foreshadow-napi-setup-update-orphan"),
      baseVersion: setupCreated.version,
      isOrphan: false,
    }),
  );
  assert.equal(setupOmitted.version, setupCreated.version);
  let setupRow = await row(
    "SELECT strength, ai_strength, ai_reasoning, last_evaluated_at FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(setupRow.strength, "overt");
  assert.equal(setupRow.ai_strength, "medium");
  assert.equal(setupRow.ai_reasoning, "preserve me");
  assert.equal(setupRow.last_evaluated_at, 1783664540830);

  const setupCleared = JSON.parse(
    await backend.foreshadowUpdateSetup("setup-ai-1", {
      ...mutationIdentity("foreshadow-napi-setup-update-clear"),
      baseVersion: setupOmitted.version,
      strength: null,
      aiStrength: null,
      aiReasoning: null,
      lastEvaluatedAt: null,
    }),
  );
  assert.equal(setupCleared.version, setupCreated.version + 1);
  setupRow = await row(
    "SELECT strength, ai_strength, ai_reasoning, last_evaluated_at FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(setupRow.strength, null);
  assert.equal(setupRow.ai_strength, null);
  assert.equal(setupRow.ai_reasoning, null);
  assert.equal(setupRow.last_evaluated_at, null);
});

test("save_anchors_for_scene の doc_content_size i64 ガード（境界 2 / 50）", async () => {
  // 現状 sc1 には非 orphan setup が 1 件（setup-ai-1）ある。

  // docContentSize=50（本文あり）+ setups 空 → bulk-orphan スキップ。
  await backend.foreshadowSaveAnchorsForScene({
    ...mutationIdentity("foreshadow-napi-anchor-save-nonempty"),
    sceneId: "sc1",
    setups: [],
    payoffs: [],
    baseVersions: {},
    docContentSize: 50,
  });
  const a = await row(
    "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(a.is_orphan, 0, "本文ありのとき bulk-orphan しない");

  // docContentSize=2（空 doc）+ setups 空 → bulk-orphan 発火。
  const beforeOrphan = await row(
    `SELECT root.id, root.version
       FROM foreshadows root
       JOIN foreshadow_setups setup ON setup.foreshadow_id = root.id
      WHERE setup.id = 'setup-ai-1'`,
  );
  const orphaned = JSON.parse(
    await backend.foreshadowSaveAnchorsForScene({
      ...mutationIdentity("foreshadow-napi-anchor-save-empty"),
      sceneId: "sc1",
      setups: [],
      payoffs: [],
      baseVersions: { [beforeOrphan.id]: beforeOrphan.version },
      docContentSize: 2,
    }),
  );
  assert.equal(orphaned[0].version, beforeOrphan.version + 1);
  const b = await row(
    "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(b.is_orphan, 1, "空 doc のとき bulk-orphan する");

  // orphan は load_anchors から除外される。
  const marks = JSON.parse(await backend.foreshadowLoadAnchorsForScene("sc1"));
  assert.equal(
    marks.filter((m) => m.markName === "foreshadowSetup").length,
    0,
    "orphan setup は mark に出ない",
  );
});

test("resolve_orphan reinsert/delete は authoritative Foreshadow receipt を返す", async () => {
  // setup-ai-1 は今 orphan。reinsert で新 id を採番し旧行を削除（原子的）。
  const beforeResolve = await row(
    `SELECT root.version
       FROM foreshadows root
       JOIN foreshadow_setups setup ON setup.foreshadow_id = root.id
      WHERE setup.id = 'setup-ai-1'`,
  );
  const reinsert = JSON.parse(
    await backend.foreshadowResolveOrphan({
      ...mutationIdentity("foreshadow-napi-orphan-reinsert"),
      setupId: "setup-ai-1",
      baseVersion: beforeResolve.version,
      action: "reinsert",
      sceneId: "sc1",
      fromPos: 3,
      toPos: 8,
    }),
  );
  const newId = reinsert.setupId;
  assert.equal(typeof newId, "string", "reinsert は new_id 文字列を返す");
  assert.notEqual(newId, "setup-ai-1");
  assert.equal(reinsert.foreshadow.version, beforeResolve.version + 1);

  // 旧行は消えている。
  const old = await row(
    "SELECT id FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(old, undefined, "旧 setup は削除済み");

  // action=delete は None → null。
  const deleted = JSON.parse(
    await backend.foreshadowResolveOrphan({
      ...mutationIdentity("foreshadow-napi-orphan-delete"),
      setupId: newId,
      baseVersion: reinsert.foreshadow.version,
      action: "delete",
    }),
  );
  assert.equal(deleted.setupId, null);
  assert.equal(deleted.foreshadow.version, reinsert.foreshadow.version + 1);
});

test("link_codex / list_linked_codex / unlink_codex の roundtrip", async () => {
  // type は DEFAULT 'character'（migrate トリガが default-project に seed 済み）。
  const codex = JSON.parse(
    await backend.agentCodexCreate({
      ...mutationIdentity("foreshadow-napi-codex-create", PROJECT, "human"),
      undoJournalId: null,
      entryId: "cx1",
      projectId: PROJECT,
      sessionId: "foreshadow-napi-session",
      surface: "manual",
      typeSlug: "character",
      name: "主人公",
      summary: "",
      content: "{}",
      authorshipSpans: [],
    }),
  );
  assert.equal(codex.entityId, "cx1");
  const fs = await firstForeshadow();

  const linkedRoot = JSON.parse(
    await backend.foreshadowLinkCodex({
      ...mutationIdentity("foreshadow-napi-codex-link"),
      foreshadowId: fs.id,
      codexId: "cx1",
      baseVersion: fs.version,
    }),
  );
  assert.equal(linkedRoot.version, fs.version + 1);
  let linked = JSON.parse(await backend.foreshadowListLinkedCodex(fs.id));
  assert.equal(linked.length, 1);
  assert.equal(linked[0].id, "cx1");
  assert.equal(linked[0].name, "主人公");

  const unlinkedRoot = JSON.parse(
    await backend.foreshadowUnlinkCodex({
      ...mutationIdentity("foreshadow-napi-codex-unlink"),
      foreshadowId: fs.id,
      codexId: "cx1",
      baseVersion: linkedRoot.version,
    }),
  );
  assert.equal(unlinkedRoot.version, linkedRoot.version + 1);
  linked = JSON.parse(await backend.foreshadowListLinkedCodex(fs.id));
  assert.deepEqual(linked, []);
});
