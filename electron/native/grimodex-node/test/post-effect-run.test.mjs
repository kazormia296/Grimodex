// post-effect run 3コマンドの napi end-to-end 契約（Electron移行 Phase 3d）。
//
// 共有 Rust runner の詳細な分岐は grimodex-post-effect の単体テストで固定し、
// ここでは napi 境界で重要な次の契約を実 workspace + local HTTP server で確認する。
//   - start は AI 完了を待たず run_id を即返し、4ch を EventQueue へ流す。
//   - completed run は同一 cache key で再利用され、AI/key error/event を発生させない。
//   - multi abort は同一 Backend の registry を共有し、cancelled を維持する。

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
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

function writeReviewResponse(res, suffix = "") {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              findings: [
                {
                  title: `表現の確認${suffix}`,
                  reason: "同じ語が続いています",
                  found_text: "風",
                  found_context: "風が吹く",
                  severity: "warning",
                },
              ],
            }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  );
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

async function insertScene(backend, sceneId) {
  await backend.dbExecute(
    "INSERT INTO tree_nodes (id, project_id, node_type, title, content) VALUES (?, 'default-project', 'scene', ?, ?)",
    [sceneId, sceneId, "風が吹く。風が止む。"],
    "run",
  );
}

async function rows(backend, sql, params = []) {
  const result = JSON.parse(await backend.dbExecute(sql, params, "all"));
  return result.rows;
}

async function waitForRunEvent(
  events,
  channel,
  runId,
  timeoutMs = 5000,
) {
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

test("startPostEffectRun は即返却し4ch完走、cache hitはAI/key error/eventを再実行しない", async () => {
  const requestSeen = deferred();
  const releaseResponse = deferred();
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestCount += 1;
    assert.equal(req.url, "/chat/completions");
    await readBody(req);
    requestSeen.resolve();
    await releaseResponse.promise;
    writeReviewResponse(res);
  });

  try {
    const { backend, events, workspace } = makeBackend();
    await backend.openWorkspace(workspace);
    await insertScene(backend, "pe-scene-1");
    const settings = aiSettings(baseUrl);
    const args = singleArgs("pe-scene-1");

    const startPromise = backend.startPostEffectRun(args, settings, null, null);
    const startJson = await Promise.race([
      startPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("start awaited the background AI request")),
          1000,
        ),
      ),
    ]);
    const started = JSON.parse(startJson);
    assert.equal(started.from_cache, false);
    assert.equal(typeof started.run_id, "string");

    await requestSeen.promise;
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

    const eventCountBeforeCache = events.length;
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requestCount, 1);
    assert.equal(events.length, eventCountBeforeCache);
  } finally {
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
      await backend.startPostEffectRunMulti(
        multiArgs(["pe-abort-1", "pe-abort-2"]),
        aiSettings(baseUrl),
        null,
        null,
      ),
    );
    assert.equal(started.from_cache, false);
    await requestSeen.promise;

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
    await closeServer(server);
  }
});
