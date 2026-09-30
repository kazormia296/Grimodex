// AI チャット napi glue の end-to-end スモーク (Electron 移行 Phase 3 バッチ3a)。
//
// grimodex-ai の provider 分岐 / SSE パースは Rust 単体 (203 tests) で gate 済み。
// ここで検証するのは **napi グルー**: args(camelCase) の deserialize → build_chat_params
// → send_chat_stream → EventQueue(=StreamEmitter) → onEvent への emit、そして
// エラー時の chat:stream-error emit + reject。ローカル HTTP モックで OpenAI 互換の
// /chat/completions を立て、キーは注入引数で渡す (napi は keyring を触らない)。
//
// 実行: pnpm napi:build 後に `node --test test/`。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-chat-"));
const appDataDir = join(root, "app-data");
mkdirSync(appDataDir, { recursive: true }); // Backend より先に ai-settings.json を書くため
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

/** OpenAI 互換 /chat/completions を模す HTTP サーバを起動し base URL を返す。 */
function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** OpenAI 互換 SSE を書き出す（chunk 群 + finish + [DONE]）。 */
function writeSseStream(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const frame = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  frame({ choices: [{ delta: { content: "Hello" } }] });
  frame({ choices: [{ delta: { content: ", world" } }] });
  frame({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** appDataDir/ai-settings.json を openai-compatible + 指定 baseUrl で書く。 */
function writeAiSettings(baseUrl) {
  writeFileSync(
    join(appDataDir, "ai-settings.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "mock-model",
      ollamaEndpoint: "",
      openaiCompatibleEndpoints: [{ id: "test", baseUrl }],
      activeOpenaiCompatibleEndpointId: "test",
    }),
  );
}

/** provider/endpoint/model override の境界テスト用設定を書く。 */
function writeOverrideAiSettings(defaultBaseUrl, otherBaseUrl) {
  writeFileSync(
    join(appDataDir, "ai-settings.json"),
    JSON.stringify({
      provider: "openai",
      model: "base-model",
      ollamaEndpoint: "",
      openaiCompatibleEndpoints: [
        { id: "default", baseUrl: defaultBaseUrl },
        { id: "other", baseUrl: otherBaseUrl },
      ],
      activeOpenaiCompatibleEndpointId: "default",
    }),
  );
}

function makeBackend() {
  const events = [];
  const backend = new Backend(appDataDir);
  backend.onEvent((channel, payload) => events.push({ channel, payload }));
  return { backend, events };
}

async function waitForEvent(events, channel, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find((e) => e.channel === channel);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`event not received within ${timeoutMs}ms: ${channel}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const CHAT_ARGS = { messages: [{ role: "user", content: "hi" }] };
let auditExecutionCounter = 0;

async function auditedArgs(backend, args, pathId, { stream = false } = {}) {
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const expectedWorkspacePath = realpathSync(workspace);
  auditExecutionCounter += 1;
  const executionId = `chat-fixture-execution-${auditExecutionCounter}`;
  const operationId = `chat-fixture-operation-${auditExecutionCounter}`;
  const projectId = null;
  const auditContext = {
    expectedWorkspacePath,
    projectId,
    operationId,
    executionId,
    parentExecutionId: null,
    pathId,
  };
  await backend.aiAuditAppendBatch(expectedWorkspacePath, projectId, [
    {
      eventId: `chat-fixture-start-${auditExecutionCounter}`,
      executionId,
      operationId,
      parentExecutionId: null,
      pathId,
      eventType: "execution.started",
      timestamp: Date.now(),
      payload: {
        captureState: "complete",
        appVersion: "2.0.10",
      },
    },
    {
      eventId: `chat-fixture-prepared-${auditExecutionCounter}`,
      executionId,
      operationId,
      parentExecutionId: null,
      pathId,
      eventType: "request.prepared",
      timestamp: Date.now(),
      payload: {
        captureState: "complete",
        credentialsExcluded: true,
        request: { messages: args.messages ?? [] },
      },
    },
    {
      eventId: `chat-fixture-dispatched-${auditExecutionCounter}`,
      executionId,
      operationId,
      parentExecutionId: null,
      pathId,
      eventType: "request.dispatched",
      timestamp: Date.now(),
      payload: {
        captureState: "complete",
        dispatchBoundary: "before_electron_native_ipc_invoke",
      },
    },
  ]);
  return {
    ...args,
    ...(stream ? { streamId: executionId } : {}),
    auditContext,
  };
}

test("getAiSettings がディスクの ai-settings.json を camelCase で返す", async () => {
  writeAiSettings("http://127.0.0.1:1");
  const { backend } = makeBackend();
  const settings = JSON.parse(await backend.getAiSettings());
  assert.equal(settings.provider, "openai-compatible");
  assert.equal(settings.model, "mock-model");
  assert.equal(settings.activeOpenaiCompatibleEndpointId, "test");
  // キー系フィールドは含まない（renderer に返して安全）。
  assert.equal(settings.apiKey, undefined);
});

test("native AI dispatchはdurable lifecycleの欠落・identity偽装をHTTP前に拒否する", async () => {
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500).end();
  });
  try {
    writeAiSettings(baseUrl);
    const { backend } = makeBackend();
    const workspace = join(root, "workspace");
    await backend.openWorkspace(workspace);
    const expectedWorkspacePath = realpathSync(workspace);
    const settings = JSON.parse(await backend.getAiSettings());
    const bypassArgs = {
      ...CHAT_ARGS,
      auditContext: {
        expectedWorkspacePath,
        projectId: null,
        operationId: "bypass-operation",
        executionId: "bypass-execution",
        parentExecutionId: null,
        pathId: "napi_direct_bypass",
      },
    };

    await assert.rejects(
      backend.sendChatMessage(bypassArgs, settings, "sk-injected"),
      /AI_AUDIT_DISPATCH_PRECONDITION_FAILED/,
    );

    const correlated = await auditedArgs(
      backend,
      CHAT_ARGS,
      "napi_identity_original",
    );
    correlated.auditContext = {
      ...correlated.auditContext,
      pathId: "napi_identity_forged",
    };
    await assert.rejects(
      backend.sendChatMessage(correlated, settings, "sk-injected"),
      /AI_AUDIT_DISPATCH_PRECONDITION_FAILED/,
    );
    assert.equal(requestCount, 0, "precondition failure must precede HTTP send");
  } finally {
    server.close();
  }
});

test("restricted Native chat families reject a forged caller before local HTTP", async () => {
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500).end();
  });
  const isolatedRoot = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-chat-"));
  const isolatedAppDataDir = join(isolatedRoot, "app-data");
  try {
    mkdirSync(isolatedAppDataDir, { recursive: true });
    writeFileSync(
      join(isolatedAppDataDir, "ai-settings.json"),
      JSON.stringify({
        provider: "openai-compatible",
        model: "mock-model",
        ollamaEndpoint: "",
        openaiCompatibleEndpoints: [{ id: "test", baseUrl }],
        activeOpenaiCompatibleEndpointId: "test",
      }),
    );
    const backend = new Backend(isolatedAppDataDir);
    await backend.initializeProfileEgress();
    const status = JSON.parse(await backend.activateProfileEgress());
    const workspace = join(isolatedRoot, "d2a-restricted-chat");
    await backend.openWorkspace(workspace);
    const expectedWorkspacePath = realpathSync(workspace);
    const forgedIdentity = {
      profileId: status.profileId,
      callerId: "forged-chat-caller",
      callerEpoch: status.callerEpoch,
      senderId: 900,
      workspaceId: expectedWorkspacePath,
      sessionId: "forged-chat-session",
    };
    const settings = JSON.parse(await backend.getAiSettings());
    const auditContext = (executionId) => ({
      expectedWorkspacePath,
      projectId: null,
      operationId: `${executionId}-operation`,
      executionId,
      parentExecutionId: null,
      pathId: "restricted-native-chat",
    });
    const chatArgs = {
      ...CHAT_ARGS,
      auditContext: auditContext("restricted-chat"),
      callerIdentity: forgedIdentity,
    };
    const streamArgs = {
      ...CHAT_ARGS,
      streamId: "restricted-chat-stream",
      auditContext: auditContext("restricted-chat-stream"),
      callerIdentity: forgedIdentity,
    };

    await assert.rejects(
      backend.sendChatMessage(chatArgs, settings, "sk-injected"),
      /D2A_EGRESS_DENIED:/,
    );
    await assert.rejects(
      backend.sendChatMessageStream(streamArgs, settings, "sk-injected"),
      /D2A_EGRESS_DENIED:/,
    );
    assert.equal(requestCount, 0, "Native gate must precede the local HTTP transport");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
});

test("sendChatMessage がキー注入 + provider/endpoint/model override を保つ", async () => {
  let received;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk.toString();
    received = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(rawBody),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { content: "Non-stream reply" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    );
  });
  try {
    // active(default) は到達不能にし、既知 endpoint override(other) が効かなければ失敗させる。
    writeOverrideAiSettings("http://127.0.0.1:1", baseUrl);
    const { backend } = makeBackend();
    const settings = JSON.parse(await backend.getAiSettings());
    const args = await auditedArgs(
      backend,
      {
        ...CHAT_ARGS,
        provider: "openai-compatible",
        endpointId: "other",
        model: "override-model",
        requestMaxOutputTokens: 1234,
      },
      "napi_chat_message",
    );
    const result = JSON.parse(
      await backend.sendChatMessage(args, settings, "sk-injected"),
    );

    assert.equal(received.url, "/chat/completions");
    assert.equal(received.authorization, "Bearer sk-injected");
    assert.equal(received.body.model, "override-model");
    assert.equal(received.body.max_tokens, 1234);
    assert.deepEqual(result.blocks, [
      { type: "text", content: "Non-stream reply" },
    ]);
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.inputTokens, 4);
    assert.equal(result.outputTokens, 3);
  } finally {
    server.close();
  }
});

test("sendChatMessageStream が SSE を chat:stream-chunk/done へ橋渡しする", async () => {
  const { server, baseUrl } = await startMockServer((req, res) => {
    assert.equal(req.url, "/chat/completions");
    writeSseStream(res);
  });
  try {
    writeAiSettings(baseUrl);
    const { backend, events } = makeBackend();
    // dispatchInvoke と同じく settings を1回読んで送信へ渡す（原子性）。
    const settings = JSON.parse(await backend.getAiSettings());
    const args = await auditedArgs(
      backend,
      CHAT_ARGS,
      "napi_chat_stream",
      { stream: true },
    );
    await backend.sendChatMessageStream(args, settings, "sk-injected");

    const chunks = events.filter((e) => e.channel === "chat:stream-chunk");
    const text = chunks
      .map((e) => JSON.parse(e.payload))
      .filter((p) => p.block_type === "text")
      .map((p) => p.delta)
      .join("");
    assert.equal(text, "Hello, world", "chunk delta が順に届く");

    const done = await waitForEvent(events, "chat:stream-done");
    const donePayload = JSON.parse(done.payload);
    // Rust は OpenAI の finish_reason "stop" を正準の "end_turn" へ正規化する。
    assert.equal(donePayload.stop_reason, "end_turn");
    assert.equal(donePayload.output_tokens, 2);
  } finally {
    server.close();
  }
});

test("HTTP エラーは chat:stream-error を emit し reject する", async () => {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  try {
    writeAiSettings(baseUrl);
    const { backend, events } = makeBackend();
    const settings = JSON.parse(await backend.getAiSettings());
    const args = await auditedArgs(
      backend,
      CHAT_ARGS,
      "napi_chat_stream_error",
      { stream: true },
    );
    await assert.rejects(
      backend.sendChatMessageStream(args, settings, "sk-injected"),
      (err) => {
        assert.ok(String(err.message).length > 0);
        return true;
      },
    );
    // 失敗時も chat:stream-error が飛ぶ（FE の spinner を止める契約）。
    const errEvent = await waitForEvent(events, "chat:stream-error");
    assert.ok(JSON.parse(errEvent.payload).message.length > 0);
  } finally {
    server.close();
  }
});

test("abortChatStream が進行中 SSE を止め stopped done を emit する", async () => {
  let response;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const { server, baseUrl } = await startMockServer((_req, res) => {
    response = res;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`,
    );
    markStarted();
  });
  try {
    writeAiSettings(baseUrl);
    const { backend, events } = makeBackend();
    const settings = JSON.parse(await backend.getAiSettings());
    const args = await auditedArgs(
      backend,
      CHAT_ARGS,
      "napi_chat_stream_abort",
      { stream: true },
    );
    const stream = backend.sendChatMessageStream(
      args,
      settings,
      "sk-injected",
    );

    await started;
    await waitForEvent(events, "chat:stream-chunk");
    assert.equal(await backend.abortChatStream(args.streamId), true);
    // bytes_stream.next() を起こす。abort 判定はこの第2チャンクを処理する前に走る。
    response.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "must-not-arrive" } }],
      })}\n\n`,
    );
    response.end();
    await stream;

    const done = await waitForEvent(events, "chat:stream-done");
    assert.equal(JSON.parse(done.payload).stop_reason, "stopped");
    const text = events
      .filter((e) => e.channel === "chat:stream-chunk")
      .map((e) => JSON.parse(e.payload).delta)
      .join("");
    assert.equal(text, "first", "abort 後の delta は emit しない");
  } finally {
    response?.end();
    server.close();
  }
});

test("abortChatStream は未知IDをfuture tombstoneとして受理しfalseを返す", async () => {
  writeAiSettings("http://127.0.0.1:1");
  const { backend } = makeBackend();
  assert.equal(await backend.abortChatStream("future-chat-stream"), false);
});
