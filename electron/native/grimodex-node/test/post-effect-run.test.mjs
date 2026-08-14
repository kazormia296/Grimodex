// post-effect run 3コマンドの napi end-to-end 契約（Electron移行 Phase 3d）。
//
// 共有 Rust runner の詳細な分岐は grimodex-post-effect の単体テストで固定し、
// ここでは napi 境界で重要な次の契約を実 workspace + local HTTP server で確認する。
//   - start は AI 完了を待たず run_id を即返し、4ch を EventQueue へ流す。
//   - completed run は同一 cache key で再利用され、AI/key error/event を発生させない。
//   - multi abort は同一 Backend の registry を共有し、cancelled を維持する。
//   - secret lookup error は cache miss で fail-closed、cache hit は再実行しない。
//   - role effect の provider/endpoint override と default effect の無視規則を保つ。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const roots = [];
process.on("exit", () => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      // The native Backend can release its SQLite handle after exit listeners
      // on Windows, so fixture cleanup is best-effort there.
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
    }
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withTimeout(promise, label, timeoutMs = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  return raw;
}

function writeAiResponse(res, content) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(content),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
}

function writeReviewResponse(res, suffix = "") {
  writeAiResponse(res, {
    findings: [
      {
        title: `表現の確認${suffix}`,
        reason: "同じ語が続いています",
        found_text: "風",
        found_context: "風が吹く",
        severity: "warning",
      },
    ],
  });
}

function writeTypoResponse(res) {
  writeAiResponse(res, { issues: [] });
}

function writeImpactResponse(res) {
  writeAiResponse(res, { judgments: [] });
}

function makeBackend() {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-pe-run-"));
  roots.push(root);
  const events = [];
  const backend = new Backend(join(root, "app-data"));
  backend.onEvent((channel, payload) => {
    events.push({ channel, payload: JSON.parse(payload) });
  });
  return { backend, events, workspace: join(root, "workspace") };
}

function aiSettings(baseUrl) {
  return {
    provider: "openai-compatible",
    model: "mock-review-model",
    ollamaEndpoint: "http://127.0.0.1:1",
    openaiCompatibleEndpoints: [{ id: "mock", baseUrl }],
    activeOpenaiCompatibleEndpointId: "mock",
  };
}

function aiSettingsWithEndpoints(defaultBaseUrl, roleBaseUrl) {
  return {
    ...aiSettings(defaultBaseUrl),
    openaiCompatibleEndpoints: [
      { id: "default", baseUrl: defaultBaseUrl },
      { id: "role", baseUrl: roleBaseUrl },
    ],
    activeOpenaiCompatibleEndpointId: "default",
  };
}

function singleArgs(sceneId, inputHash = "review-hash-1") {
  return {
    project_id: "default-project",
    effect_type: "review",
    scope_type: "scene",
    scope_target_id: sceneId,
    model: "mock-review-model",
    prompt_version: "review_v1.1",
    input_hash: inputHash,
    codex_payload_json: "[]",
    scene_text: "風が吹く。風が止む。",
    system_prompt: "文章を校閲してください。",
  };
}

function multiArgs(sceneIds, inputHash = "review-multi-hash-1") {
  return {
    project_id: "default-project",
    effect_type: "review",
    scope_type: "project",
    scope_target_id: null,
    model: "mock-review-model",
    prompt_version: "review_v1.1",
    input_hash: inputHash,
    scenes: sceneIds.map((sceneId) => ({
      scene_id: sceneId,
      codex_payload_json: "[]",
      scene_text: "風が吹く。風が止む。",
    })),
    system_prompt: "文章を校閲してください。",
  };
}

function impactMultiArgs(sceneId, inputHash, sourceGuard) {
  return {
    project_id: "default-project",
    effect_type: "impact_review",
    scope_type: "project",
    scope_target_id: null,
    model: "mock-review-model",
    prompt_version: "impact_review_v1.1",
    input_hash: inputHash,
    source_guard: sourceGuard,
    scenes: [
      {
        scene_id: sceneId,
        codex_payload_json: JSON.stringify({
          change_id: "change-1",
          entry_id: "entry-1",
          entry_name: "アリス",
          entry_type: "character",
          change_summary: "年齢を変更",
          changes: [],
        }),
        scene_text: "風が吹く。",
      },
    ],
    system_prompt: "変更の影響を確認してください。",
  };
}

function scopedArgs(args, workspace) {
  return { ...args, expectedWorkspacePath: workspace };
}

async function insertScene(backend, sceneId) {
  const requestId = `post-effect-scene-create:${sceneId}`;
  return JSON.parse(
    await backend.treeNodeCreate({
      requestId,
      sessionId: `${requestId}:session`,
      eventUid: `${requestId}:event`,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      id: sceneId,
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: sceneId,
      sortOrder: sceneId,
      content: "風が吹く。風が止む。",
    }),
  );
}

async function rows(backend, sql, params = []) {
  const result = JSON.parse(await backend.dbExecute(sql, params, "all"));
  return result.rows;
}

async function readSourceGuard(backend) {
  const [revision] = await rows(
    backend,
    `SELECT meta.epoch AS connection_epoch,
            CAST(total_changes() AS TEXT) AS total_changes,
            CAST(version.data_version AS TEXT) AS data_version
       FROM temp.grimodex_connection_meta AS meta
       CROSS JOIN pragma_data_version AS version
      WHERE meta.singleton = 1`,
  );
  return {
    kind: "sqlite_revision_v1",
    expected_connection_epoch: revision.connection_epoch,
    expected_total_changes: revision.total_changes,
    expected_data_version: revision.data_version,
  };
}

async function waitForRunEvent(events, channel, runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = events.find(
      (candidate) =>
        candidate.channel === channel && candidate.payload.run_id === runId,
    );
    if (event) return event.payload;
    if (Date.now() > deadline) {
      throw new Error(`event timeout: ${channel} (${runId})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Impact source guard は cache より先に同一connection revisionを原子的に検証する", async () => {
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    await readBody(req);
    writeImpactResponse(res);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "impact-guard-scene");

    const seedGuard = await readSourceGuard(backend);
    const seeded = JSON.parse(
      await backend.startPostEffectRunMulti(
        scopedArgs(
          impactMultiArgs(
            "impact-guard-scene",
            "impact-guard-cache-hash",
            seedGuard,
          ),
          workspace,
        ),
        aiSettings(baseUrl),
        null,
        null,
      ),
    );
    assert.equal(seeded.from_cache, false);
    await waitForRunEvent(events, "post_effect:done", seeded.run_id);

    const matchingGuard = await readSourceGuard(backend);
    const cached = JSON.parse(
      await backend.startPostEffectRunMulti(
        scopedArgs(
          impactMultiArgs(
            "impact-guard-scene",
            "impact-guard-cache-hash",
            matchingGuard,
          ),
          workspace,
        ),
        aiSettings("http://127.0.0.1:1"),
        null,
        "cache path must not resolve a secret",
      ),
    );
    assert.deepEqual(cached, {
      run_id: seeded.run_id,
      from_cache: true,
    });

    const staleGuard = await readSourceGuard(backend);
    await insertScene(backend, "impact-guard-revision-change");
    await assert.rejects(
      backend.startPostEffectRunMulti(
        scopedArgs(
          impactMultiArgs(
            "impact-guard-scene",
            "impact-guard-stale-hash",
            staleGuard,
          ),
          workspace,
        ),
        aiSettings("http://127.0.0.1:1"),
        null,
        null,
      ),
      /IMPACT_SOURCE_CHANGED/,
    );
    const [staleRunCount] = await rows(
      backend,
      "SELECT COUNT(*) AS n FROM post_effect_runs WHERE input_hash = 'impact-guard-stale-hash'",
    );
    assert.equal(staleRunCount.n, 0, "stale guard never creates a run row");
  } finally {
    await closeServer(server);
  }
});

test("Impact source guard は別Backendのcommitと不正wireをnative境界で拒否する", async () => {
  const first = makeBackend();
  await first.backend.openWorkspace(first.workspace);
  await insertScene(first.backend, "impact-external-scene");
  const staleGuard = await readSourceGuard(first.backend);

  await assert.rejects(
    first.backend.startPostEffectRun(
      scopedArgs(
        {
          ...singleArgs("impact-external-scene", "impact-single-unguarded"),
          effect_type: "impact_review",
          prompt_version: "impact_review_v1.1",
        },
        first.workspace,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /impact_review requires start_post_effect_run_multi with source_guard/,
  );

  const second = makeBackend();
  await second.backend.openWorkspace(first.workspace);
  await insertScene(second.backend, "impact-external-revision-change");

  await assert.rejects(
    first.backend.startPostEffectRunMulti(
      scopedArgs(
        impactMultiArgs(
          "impact-external-scene",
          "impact-guard-missing-hash",
          undefined,
        ),
        first.workspace,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /source_guard is required for impact_review/,
  );

  await assert.rejects(
    first.backend.startPostEffectRunMulti(
      scopedArgs(
        impactMultiArgs(
          "impact-external-scene",
          "impact-guard-external-hash",
          staleGuard,
        ),
        first.workspace,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /IMPACT_SOURCE_CHANGED/,
  );

  await assert.rejects(
    first.backend.startPostEffectRunMulti(
      scopedArgs(
        impactMultiArgs("impact-external-scene", "impact-guard-wire-hash", {
          ...staleGuard,
          unexpected: true,
        }),
        first.workspace,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /unknown field `unexpected`/,
  );
});

test("workspace切替後のsingle/multi startは旧pathをruntime開始前に拒否する", async () => {
  const { backend, workspace: workspaceA } = makeBackend();
  const workspaceB = `${workspaceA}-next`;
  await backend.openWorkspace(workspaceA);
  await insertScene(backend, "workspace-collision");
  await backend.openWorkspace(workspaceB);
  await insertScene(backend, "workspace-collision");

  const [before] = await rows(
    backend,
    "SELECT COUNT(*) AS n FROM post_effect_runs",
  );
  await assert.rejects(
    backend.startPostEffectRun(
      scopedArgs(
        singleArgs("workspace-collision", "stale-workspace-single"),
        workspaceA,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /POST_EFFECT_WORKSPACE_CHANGED/,
  );
  await assert.rejects(
    backend.startPostEffectRunMulti(
      scopedArgs(
        multiArgs(["workspace-collision"], "stale-workspace-multi"),
        workspaceA,
      ),
      aiSettings("http://127.0.0.1:1"),
      null,
      null,
    ),
    /POST_EFFECT_WORKSPACE_CHANGED/,
  );
  const [after] = await rows(
    backend,
    "SELECT COUNT(*) AS n FROM post_effect_runs",
  );
  assert.deepEqual(after, before, "rejected starts never create a run row");
});

test("startPostEffectRun は即返却し4ch完走、cache hitはAI/key error/eventを再実行しない", async () => {
  const requestSeen = deferred();
  const releaseResponse = deferred();
  let requestCount = 0;
  const requestBodies = [];
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestCount += 1;
    assert.equal(req.url, "/chat/completions");
    requestBodies.push(JSON.parse(await readBody(req)));
    requestSeen.resolve();
    await releaseResponse.promise;
    writeReviewResponse(res);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-scene-1");
    const settings = aiSettings(baseUrl);
    const args = scopedArgs(singleArgs("pe-scene-1"), workspace);

    const startJson = await withTimeout(
      backend.startPostEffectRun(args, settings, null, null),
      "startPostEffectRun immediate return",
      1000,
    );
    const started = JSON.parse(startJson);
    assert.equal(started.from_cache, false);
    assert.equal(typeof started.run_id, "string");

    await withTimeout(requestSeen.promise, "first post-effect HTTP request");
    releaseResponse.resolve();
    const done = await waitForRunEvent(
      events,
      "post_effect:done",
      started.run_id,
    );
    assert.equal(done.annotation_count, 1);
    assert.ok(
      events.some(
        (event) =>
          event.channel === "post_effect:progress" &&
          event.payload.run_id === started.run_id,
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.channel === "post_effect:partial" &&
          event.payload.run_id === started.run_id,
      ),
    );

    const [run] = await rows(
      backend,
      "SELECT status FROM post_effect_runs WHERE id = ?",
      [started.run_id],
    );
    assert.equal(run.status, "completed");
    const [annotationCount] = await rows(
      backend,
      "SELECT COUNT(*) AS n FROM post_effect_annotations WHERE run_id = ?",
      [started.run_id],
    );
    assert.equal(annotationCount.n, 1);
    const [preparedAuditRow] = await rows(
      backend,
      `SELECT payload
         FROM ai_audit_events
        WHERE operation_id = ? AND event_type = 'request.prepared'
        ORDER BY sequence DESC
        LIMIT 1`,
      [started.run_id],
    );
    const preparedAudit = JSON.parse(preparedAuditRow.payload);
    assert.deepEqual(
      preparedAudit.request.body,
      requestBodies[0],
      "durable prepared body must equal the exact provider JSON body",
    );
    assert.deepEqual(preparedAudit.request.effectiveOutputTokenLimit, {
      field: null,
      value: null,
      source: "provider_default",
      omitted: true,
    });
    assert.equal(preparedAudit.captureState, "partial");
    assert.deepEqual(preparedAudit.limitations, [
      "provider-default-output-token-limit-not-observable",
    ]);

    const runEventCountBeforeCache = events.filter(
      (event) => event.payload.run_id === started.run_id,
    ).length;
    const cached = JSON.parse(
      await backend.startPostEffectRun(
        args,
        settings,
        null,
        "保存済み API キーを復号できません",
      ),
    );
    assert.deepEqual(cached, {
      run_id: started.run_id,
      from_cache: true,
    });

    // 固定 sleep で「何も起きない」を推測せず、同じ Backend/runtime に cache hit
    // より後で fresh run を投入して終端まで待つ。先行 cache branch が誤って task を
    // spawn していれば、その HTTP または同一 run_id の event が barrier 完了前に現れる。
    await insertScene(backend, "pe-cache-barrier");
    const barrier = JSON.parse(
      await backend.startPostEffectRun(
        scopedArgs(
          singleArgs("pe-cache-barrier", "review-hash-barrier"),
          workspace,
        ),
        settings,
        null,
        null,
      ),
    );
    assert.equal(barrier.from_cache, false);
    await waitForRunEvent(events, "post_effect:done", barrier.run_id);

    assert.equal(requestCount, 2, "初回 + barrier だけがAIを呼ぶ");
    assert.equal(
      events.filter((event) => event.payload.run_id === started.run_id).length,
      runEventCountBeforeCache,
      "cache hitは既存runへeventを追加しない",
    );
  } finally {
    // 途中 assertion 失敗でも request handler の gate を解放して server.close を
    // 永久待ちにしない。resolve は完了後に再度呼んでも no-op。
    releaseResponse.resolve();
    await closeServer(server);
  }
});

test("cache missのrequired providerでsecret lookupが失敗するとHTTP送信せずfailedへ着地する", async () => {
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestCount += 1;
    await readBody(req);
    writeReviewResponse(res);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-secret-error");
    const lookupError = "保存済み API キーを復号できません";
    const args = {
      ...singleArgs("pe-secret-error", "review-secret-error-cache-miss"),
      // Anthropic はキー必須。base settings の local OpenAI-compatible endpointへ
      // fail-openする実装も requestCount で検知する。
      provider_override: "anthropic",
      model_override: "claude-required-key",
    };

    const started = JSON.parse(
      await withTimeout(
        backend.startPostEffectRun(
          scopedArgs(args, workspace),
          aiSettings(baseUrl),
          null,
          lookupError,
        ),
        "secret-error run start",
        1000,
      ),
    );
    assert.equal(started.from_cache, false);

    const error = await waitForRunEvent(
      events,
      "post_effect:error",
      started.run_id,
    );
    assert.match(error.error, new RegExp(lookupError));
    const [run] = await rows(
      backend,
      "SELECT status, error_message FROM post_effect_runs WHERE id = ?",
      [started.run_id],
    );
    assert.equal(run.status, "failed");
    assert.match(run.error_message, new RegExp(lookupError));
    assert.equal(requestCount, 0, "secret error時はHTTPを一度も送らない");
  } finally {
    await closeServer(server);
  }
});

test("role effectだけがoverride endpoint+keyを使い、default effectはrequest内overrideを無視する", async () => {
  const defaultRequests = [];
  const roleRequests = [];
  const [defaultMock, roleMock] = await Promise.all([
    startMockServer(async (req, res) => {
      defaultRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(await readBody(req)),
      });
      writeTypoResponse(res);
    }),
    startMockServer(async (req, res) => {
      roleRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(await readBody(req)),
      });
      writeReviewResponse(res, "-role");
    }),
  ]);

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-route-review");
    await insertScene(backend, "pe-route-typo");
    const settings = aiSettingsWithEndpoints(
      defaultMock.baseUrl,
      roleMock.baseUrl,
    );

    const review = JSON.parse(
      await backend.startPostEffectRun(
        scopedArgs(
          {
            ...singleArgs("pe-route-review", "review-route-role"),
            model_override: "role-review-model",
            provider_override: "openai-compatible",
            endpoint_id_override: "role",
          },
          workspace,
        ),
        settings,
        "sk-role-only",
        null,
      ),
    );
    await waitForRunEvent(events, "post_effect:done", review.run_id);

    const typo = JSON.parse(
      await backend.startPostEffectRun(
        scopedArgs(
          {
            ...singleArgs("pe-route-typo", "typo-route-default"),
            effect_type: "typo_detection",
            prompt_version: "typo_detection_v1.2",
            // typo は role effect ではない。DTOに混入しても既定設定を使う。
            model_override: "must-not-be-used",
            provider_override: "openai-compatible",
            endpoint_id_override: "role",
          },
          workspace,
        ),
        settings,
        "sk-default-only",
        null,
      ),
    );
    await waitForRunEvent(events, "post_effect:done", typo.run_id);

    assert.equal(roleRequests.length, 1);
    assert.equal(roleRequests[0].url, "/chat/completions");
    assert.equal(roleRequests[0].authorization, "Bearer sk-role-only");
    assert.equal(roleRequests[0].body.model, "role-review-model");

    assert.equal(defaultRequests.length, 1);
    assert.equal(defaultRequests[0].url, "/chat/completions");
    assert.equal(defaultRequests[0].authorization, "Bearer sk-default-only");
    assert.equal(defaultRequests[0].body.model, "mock-review-model");
  } finally {
    await Promise.all([
      closeServer(defaultMock.server),
      closeServer(roleMock.server),
    ]);
  }
});

test("wrong-project abortはregistryを汚染せずmulti runが2scene完走する", async () => {
  const requestSeen = deferred();
  const releaseResponse = deferred();
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestCount += 1;
    await readBody(req);
    if (requestCount === 1) {
      requestSeen.resolve();
      await releaseResponse.promise;
    }
    writeReviewResponse(res, `-xproj-${requestCount}`);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-xproj-1");
    await insertScene(backend, "pe-xproj-2");

    const started = JSON.parse(
      await withTimeout(
        backend.startPostEffectRunMulti(
          scopedArgs(
            multiArgs(["pe-xproj-1", "pe-xproj-2"], "review-multi-xproj"),
            workspace,
          ),
          aiSettings(baseUrl),
          null,
          null,
        ),
        "wrong-project multi run start",
        1000,
      ),
    );
    assert.equal(started.from_cache, false);
    await withTimeout(requestSeen.promise, "wrong-project first HTTP request");

    await backend.abortPostEffectRun(started.run_id, "another-project");
    releaseResponse.resolve();
    const done = await waitForRunEvent(
      events,
      "post_effect:done",
      started.run_id,
    );
    assert.equal(done.annotation_count, 2);
    assert.equal(requestCount, 2, "wrong-project abort後も次sceneを処理する");

    const [run] = await rows(
      backend,
      "SELECT status FROM post_effect_runs WHERE id = ?",
      [started.run_id],
    );
    assert.equal(run.status, "completed");
    assert.equal(
      events.some(
        (event) =>
          event.channel === "post_effect:error" &&
          event.payload.run_id === started.run_id,
      ),
      false,
    );
  } finally {
    releaseResponse.resolve();
    await closeServer(server);
  }
});

test("abortPostEffectRun はmultiとregistryを共有し、abort勝利時はcancelled+errorを維持する", async () => {
  const requestSeen = deferred();
  const releaseResponse = deferred();
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestCount += 1;
    await readBody(req);
    requestSeen.resolve();
    await releaseResponse.promise;
    writeReviewResponse(res, `-${requestCount}`);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-abort-1");
    await insertScene(backend, "pe-abort-2");

    const started = JSON.parse(
      await withTimeout(
        backend.startPostEffectRunMulti(
          scopedArgs(multiArgs(["pe-abort-1", "pe-abort-2"]), workspace),
          aiSettings(baseUrl),
          null,
          null,
        ),
        "abort multi run start",
        1000,
      ),
    );
    assert.equal(started.from_cache, false);
    await withTimeout(requestSeen.promise, "abort first HTTP request");

    await backend.abortPostEffectRun(started.run_id, "default-project");
    releaseResponse.resolve();
    const error = await waitForRunEvent(
      events,
      "post_effect:error",
      started.run_id,
    );
    assert.match(error.error, /中断されました/);
    assert.equal(requestCount, 1, "abort後は次sceneのAIを呼ばない");

    const [run] = await rows(
      backend,
      "SELECT status FROM post_effect_runs WHERE id = ?",
      [started.run_id],
    );
    assert.equal(run.status, "cancelled");
    assert.equal(
      events.some(
        (event) =>
          event.channel === "post_effect:done" &&
          event.payload.run_id === started.run_id,
      ),
      false,
    );
  } finally {
    releaseResponse.resolve();
    await closeServer(server);
  }
});
