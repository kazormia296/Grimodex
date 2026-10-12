// Phase 3 バッチ3b の napi 公開境界テスト。
// save/settings、inline stream + 専用 abort、agent tool wire、models、connection を
// ローカル OpenAI 互換モックで end-to-end 検証する。

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { closeMockServer as closeServer, startMockServer } from "./mock-http.mjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));
const agentPayloadFixture = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "..",
      "src",
      "features",
      "chat",
      "turn",
      "fixtures",
      "openaiNativeAgentPayload.json",
    ),
    "utf8",
  ),
);

const roots = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeBackend() {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-ai-3b-"));
  roots.push(root);
  const appDataDir = join(root, "app-data");
  mkdirSync(appDataDir, { recursive: true });
  const events = [];
  const backend = new Backend(appDataDir);
  backend.onEvent((channel, payload) => events.push({ channel, payload }));
  return { backend, events, root };
}

let auditExecutionCounter = 0;

async function auditedArgs(
  backend,
  root,
  args,
  pathId,
  { stream = false } = {},
) {
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const expectedWorkspacePath = realpathSync(workspace);
  auditExecutionCounter += 1;
  const executionId = `batch3b-execution-${auditExecutionCounter}`;
  const operationId = `batch3b-operation-${auditExecutionCounter}`;
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
      eventId: `batch3b-start-${auditExecutionCounter}`,
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
      eventId: `batch3b-prepared-${auditExecutionCounter}`,
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
      eventId: `batch3b-dispatched-${auditExecutionCounter}`,
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

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  return JSON.parse(raw);
}

function settingsWithEndpoints(
  defaultBaseUrl,
  otherBaseUrl,
  provider = "openai",
) {
  return {
    provider,
    model: "base-model",
    ollamaEndpoint: "http://127.0.0.1:1",
    openaiCompatibleEndpoints: [
      { id: "default", baseUrl: defaultBaseUrl },
      { id: "other", baseUrl: otherBaseUrl },
    ],
    activeOpenaiCompatibleEndpointId: "default",
  };
}

async function waitForEvent(events, channel, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = events.find((candidate) => candidate.channel === channel);
    if (event) return event;
    if (Date.now() > deadline) throw new Error(`event timeout: ${channel}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sseFrame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

test("saveAiSettings → getAiSettings が同じappDataパスでroundtripする", async () => {
  const { backend } = makeBackend();
  const settings = {
    provider: "openai-compatible",
    model: "saved-model",
    ollamaEndpoint: "http://localhost:11434",
    openaiCompatibleEndpoints: [
      { id: "saved", label: "Saved", baseUrl: "http://localhost:9000/v1" },
    ],
    activeOpenaiCompatibleEndpointId: "saved",
  };
  await backend.saveAiSettings(settings);
  const loaded = JSON.parse(await backend.getAiSettings());
  assert.equal(loaded.provider, "openai-compatible");
  assert.equal(loaded.model, "saved-model");
  assert.equal(loaded.activeOpenaiCompatibleEndpointId, "saved");
  assert.equal(loaded.openaiCompatibleEndpoints[0].label, "Saved");
});

test("sendAgentMessage がcamelCase tool履歴を送り、低信頼providerのwrite toolを落とす", async () => {
  let request;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readJson(req),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "read-1",
                  type: "function",
                  function: {
                    name: "search_codex",
                    arguments: '{"query":"moon"}',
                  },
                },
                {
                  id: "write-1",
                  type: "function",
                  function: {
                    name: "update_codex_entry",
                    arguments: '{"id":"c1"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 7,
          completion_tokens: 3,
          prompt_tokens_details: {
            cached_tokens: 5,
            cache_write_tokens: 2,
          },
        },
      }),
    );
  });
  try {
    const { backend, root } = makeBackend();
    const settings = {
      ...settingsWithEndpoints("http://127.0.0.1:1", baseUrl),
      // A settings re-read would choose Hermes. The turn-start snapshot below
      // must keep the already-budgeted native payload shape.
      toolProtocolMode: "hermes",
    };
    const args = {
      messages: agentPayloadFixture.input.messages,
      tools: agentPayloadFixture.input.tools,
      provider: "openai-compatible",
      endpointId: "other",
      model: "agent-model",
      webSearch: null,
      resolvedToolProtocol: "native",
    };
    const audited = await auditedArgs(
      backend,
      root,
      args,
      "napi_agent_message",
    );
    const result = JSON.parse(
      await backend.sendAgentMessage(audited, settings, "sk-agent"),
    );

    assert.equal(request.url, "/chat/completions");
    assert.equal(request.authorization, "Bearer sk-agent");
    assert.equal(request.body.model, "agent-model");
    assert.deepEqual(
      request.body.messages,
      agentPayloadFixture.expected.messages,
    );
    assert.deepEqual(request.body.tools, agentPayloadFixture.expected.tools);
    assert.equal(
      JSON.stringify({
        messages: request.body.messages,
        tools: request.body.tools,
      }),
      JSON.stringify(agentPayloadFixture.expected),
      "Rust wireのmessages/toolsは共有fixtureとcanonical JSONでも一致する",
    );
    assert.deepEqual(
      result.blocks.filter((block) => block.type === "tool_use"),
      [
        {
          type: "tool_use",
          id: "read-1",
          name: "search_codex",
          input: { query: "moon" },
        },
      ],
      "read-only toolは維持し、mutating toolは破棄する",
    );
    assert.equal(result.stopReason, "tool_use");
    assert.equal(result.cacheReadTokens, 5);
    assert.equal(result.cacheWriteTokens, 2);
  } finally {
    await closeServer(server);
  }
});

test("sendAgentMessage は unresolved tool protocol をN-API境界で拒否する", async () => {
  const { backend, root } = makeBackend();
  const settings = settingsWithEndpoints(
    "http://127.0.0.1:1",
    "http://127.0.0.1:1",
  );
  const args = await auditedArgs(
    backend,
    root,
    {
      messages: [],
      tools: [],
      resolvedToolProtocol: "auto",
    },
    "napi_agent_invalid_protocol",
  );
  await assert.rejects(
    backend.sendAgentMessage(args, settings, "sk-agent"),
    /failed to deserialize args|unknown variant.*auto/,
  );
});

test("listAiModels はendpoint overrideを使い、空キーならAuthorizationを付けない", async () => {
  let request;
  const { server, baseUrl } = await startMockServer((req, res) => {
    request = { url: req.url, authorization: req.headers.authorization };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }] }));
  });
  try {
    const { backend } = makeBackend();
    const settings = settingsWithEndpoints("http://127.0.0.1:1", baseUrl);
    const models = JSON.parse(
      await backend.listAiModels(
        { provider: "openai-compatible", endpointId: "other" },
        settings,
        "",
      ),
    );
    assert.equal(request.url, "/models");
    assert.equal(request.authorization, undefined);
    assert.deepEqual(models, [{ id: "model-a", name: "Model A" }]);
  } finally {
    await closeServer(server);
  }
});

test("listAiModels は選択Ollamaモデルだけをロードしてrunner contextを再取得する", async () => {
  const shownModels = [];
  const requestedRoutes = [];
  let psCalls = 0;
  let preloadBody;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    requestedRoutes.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/tags") {
      res.end(
        JSON.stringify({
          models: [
            { name: "gemma4:latest" },
            { name: "slow-unrelated:latest" },
          ],
        }),
      );
      return;
    }
    if (req.url === "/api/ps") {
      psCalls += 1;
      res.end(
        JSON.stringify({
          models:
            psCalls === 1
              ? []
              : [
                  {
                    name: "gemma4:latest",
                    model: "gemma4:latest",
                    context_length: 16384,
                  },
                ],
        }),
      );
      return;
    }
    if (req.url === "/api/show") {
      const body = await readJson(req);
      shownModels.push(body.model);
      res.end(
        JSON.stringify({
          model_info: {
            "general.architecture": "gemma4",
            "gemma4.context_length": 131072,
          },
          capabilities: ["completion", "tools"],
        }),
      );
      return;
    }
    if (req.url === "/api/generate") {
      preloadBody = await readJson(req);
      res.end(JSON.stringify({ done: true, done_reason: "load" }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const { backend } = makeBackend();
    const settings = {
      ...settingsWithEndpoints(baseUrl, baseUrl, "ollama"),
      model: "gemma4:latest",
      ollamaEndpoint: baseUrl,
    };
    const models = JSON.parse(
      await backend.listAiModels(
        {
          provider: "ollama",
          endpointId: null,
          selectedModelId: "gemma4:latest",
          expectedOllamaEndpoint: baseUrl,
        },
        settings,
        "",
      ),
    );
    assert.deepEqual(shownModels, ["gemma4:latest"]);
    assert.deepEqual(requestedRoutes, [
      "/api/tags",
      "/api/ps",
      "/api/show",
      "/api/generate",
      "/api/ps",
    ]);
    assert.deepEqual(preloadBody, {
      model: "gemma4:latest",
      stream: false,
    });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "gemma4:latest");
    assert.equal(models[0].contextLength, 131072);
    assert.equal(models[0].effectiveContextLength, 16384);
    assert.equal(models[0].effectiveContextSource, "runner");
  } finally {
    await closeServer(server);
  }
});

test("同名Ollamaモデルのendpoint A/B driftをplain/stream/agent/models全境界で拒否する", async () => {
  const { backend, root } = makeBackend();
  const endpointA = "http://127.0.0.1:11434";
  const endpointB = "http://127.0.0.1:21434";
  const settings = {
    ...settingsWithEndpoints(endpointB, endpointB, "ollama"),
    model: "shared-model:latest",
    ollamaEndpoint: endpointB,
  };
  const messages = [{ role: "user", content: "hello" }];
  const expected = /Ollama endpoint changed before request/;
  const plainArgs = await auditedArgs(
    backend,
    root,
    {
      messages,
      provider: "ollama",
      model: "shared-model:latest",
      expectedOllamaEndpoint: endpointA,
    },
    "napi_chat_endpoint_drift",
  );
  const streamArgs = await auditedArgs(
    backend,
    root,
    {
      messages,
      provider: "ollama",
      model: "shared-model:latest",
      expectedOllamaEndpoint: endpointA,
    },
    "napi_chat_stream_endpoint_drift",
    { stream: true },
  );
  const agentArgs = await auditedArgs(
    backend,
    root,
    {
      messages,
      tools: [],
      provider: "ollama",
      model: "shared-model:latest",
      expectedOllamaEndpoint: endpointA,
      resolvedToolProtocol: "native",
    },
    "napi_agent_endpoint_drift",
  );

  await assert.rejects(
    backend.sendChatMessage(plainArgs, settings, ""),
    expected,
  );
  await assert.rejects(
    backend.sendChatMessageStream(streamArgs, settings, ""),
    expected,
  );
  await assert.rejects(
    backend.sendAgentMessage(agentArgs, settings, ""),
    expected,
  );
  await assert.rejects(
    backend.listAiModels(
      {
        provider: "ollama",
        selectedModelId: "shared-model:latest",
        expectedOllamaEndpoint: endpointA,
      },
      settings,
      "",
    ),
    expected,
  );
});

test("testAiConnection はendpoint/model/key overrideを保ち、応答文字列を返す", async () => {
  let request;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    request = {
      url: req.url,
      authorization: req.headers.authorization,
      body: await readJson(req),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "Connection OK" } }],
      }),
    );
  });
  try {
    const { backend, root } = makeBackend();
    const settings = settingsWithEndpoints("http://127.0.0.1:1", baseUrl);
    const args = await auditedArgs(
      backend,
      root,
      {
        provider: "openai-compatible",
        model: "probe-model",
        apiVariant: "v1",
        endpointId: "other",
      },
      "ai_connection_test",
    );
    const message = await backend.testAiConnection(
      args,
      settings,
      "sk-probe",
    );
    assert.equal(message, "Connection OK");
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.authorization, "Bearer sk-probe");
    assert.equal(request.body.model, "probe-model");
    const snapshot = JSON.parse(
      await backend.aiAuditReadSnapshot(
        args.auditContext.expectedWorkspacePath,
        null,
        0,
        undefined,
        100,
      ),
    );
    const effectiveReceipt = snapshot.events.find(
      (event) =>
        event.executionId === args.auditContext.executionId &&
        event.eventId.startsWith("native-effective-request:"),
    );
    assert.ok(effectiveReceipt, "native effective request receipt must exist");
    assert.deepEqual(effectiveReceipt.payload.request.body, request.body);
    assert.equal(effectiveReceipt.payload.captureState, "complete");
    assert.equal(effectiveReceipt.payload.route.provider, "openai-compatible");
    assert.equal(effectiveReceipt.payload.route.endpointId, "other");
    assert.equal(
      JSON.stringify(effectiveReceipt.payload).includes("sk-probe"),
      false,
    );
  } finally {
    await closeServer(server);
  }
});

test("restricted Native inline/agent/model/connection families reject before local HTTP", async () => {
  let requestCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    requestCount += 1;
    res.writeHead(500).end();
  });
  try {
    const { backend, root } = makeBackend();
    await backend.initializeProfileEgress();
    const status = JSON.parse(await backend.activateProfileEgress());
    const workspace = join(root, "workspace");
    await backend.openWorkspace(workspace);
    const expectedWorkspacePath = realpathSync(workspace);
    const forgedIdentity = {
      profileId: status.profileId,
      callerId: "forged-ai-caller",
      callerEpoch: status.callerEpoch,
      senderId: 901,
      workspaceId: expectedWorkspacePath,
      sessionId: "forged-ai-session",
    };
    const settings = settingsWithEndpoints(
      baseUrl,
      baseUrl,
      "openai-compatible",
    );
    const inlineArgs = await auditedArgs(
      backend,
      root,
      { messages: [{ role: "user", content: "inline" }] },
      "restricted-inline",
      { stream: true },
    );
    inlineArgs.callerIdentity = forgedIdentity;
    const agentArgs = await auditedArgs(
      backend,
      root,
      { messages: [], tools: [], resolvedToolProtocol: "native" },
      "restricted-agent",
    );
    agentArgs.callerIdentity = forgedIdentity;
    const connectionArgs = await auditedArgs(
      backend,
      root,
      { provider: "openai-compatible", model: "probe-model" },
      "restricted-connection",
    );
    connectionArgs.callerIdentity = forgedIdentity;

    await assert.rejects(
      backend.sendInlineAiStream(inlineArgs, settings, "sk-injected"),
      /D2A_EGRESS_DENIED:/,
    );
    await assert.rejects(
      backend.sendAgentMessage(agentArgs, settings, "sk-injected"),
      /D2A_EGRESS_DENIED:/,
    );
    await assert.rejects(
      backend.listAiModels(
        {
          provider: "openai-compatible",
          endpointId: "other",
          callerIdentity: forgedIdentity,
        },
        settings,
        "sk-injected",
      ),
      /D2A_EGRESS_DENIED:/,
    );
    await assert.rejects(
      backend.testAiConnection(connectionArgs, settings, "sk-injected"),
      /D2A_EGRESS_DENIED:/,
    );
    assert.equal(requestCount, 0, "Native gate must precede the local HTTP transport");
  } finally {
    await closeServer(server);
  }
});

test("inline abortはinlineだけを停止し、同時実行chatを止めない", async () => {
  const responses = new Map();
  const streams = [];
  let streamFailure;
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    const body = await readJson(req);
    responses.set(body.model, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sseFrame({ choices: [{ delta: { content: `${body.model}-first` } }] }),
    );
  });
  try {
    const { backend, events, root } = makeBackend();
    const settings = settingsWithEndpoints(
      baseUrl,
      baseUrl,
      "openai-compatible",
    );
    const messages = [{ role: "user", content: "continue" }];
    const chatArgs = await auditedArgs(
      backend,
      root,
      { messages, model: "chat-model" },
      "napi_concurrent_chat_stream",
      { stream: true },
    );
    const inlineArgs = await auditedArgs(
      backend,
      root,
      { messages, model: "inline-model" },
      "napi_concurrent_inline_stream",
      { stream: true },
    );
    // Observe each rejection immediately, but rethrow it after both streams settle.
    streams.push(backend.sendChatMessageStream(chatArgs, settings, "").then(
      () => undefined,
      (error) => { streamFailure ??= { error }; },
    ));
    streams.push(backend.sendInlineAiStream(inlineArgs, settings, "").then(
      () => undefined,
      (error) => { streamFailure ??= { error }; },
    ));

    // Initial chunks prove both requests started through the existing bounded waits.
    await waitForEvent(events, "chat:stream-chunk");
    await waitForEvent(events, "inline-ai:stream-chunk");
    assert.equal(await backend.abortInlineAiStream(inlineArgs.streamId), true);

    const chatResponse = responses.get("chat-model");
    chatResponse.write(
      sseFrame({ choices: [{ delta: { content: "-second" } }] }),
    );
    chatResponse.write(
      sseFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    );
    chatResponse.write("data: [DONE]\n\n");
    chatResponse.end();

    await Promise.all(streams);
    if (streamFailure) throw streamFailure.error;
    const inlineDone = JSON.parse(
      (await waitForEvent(events, "inline-ai:stream-done")).payload,
    );
    const chatDone = JSON.parse(
      (await waitForEvent(events, "chat:stream-done")).payload,
    );
    assert.equal(inlineDone.stop_reason, "stopped");
    assert.equal(chatDone.stop_reason, "end_turn");

    const inlineText = events
      .filter((event) => event.channel === "inline-ai:stream-chunk")
      .map((event) => JSON.parse(event.payload).delta)
      .join("");
    const chatText = events
      .filter((event) => event.channel === "chat:stream-chunk")
      .map((event) => JSON.parse(event.payload).delta)
      .join("");
    assert.equal(inlineText, "inline-model-first");
    assert.equal(chatText, "chat-model-first-second");
  } finally {
    for (const response of responses.values()) response.end();
    try {
      await closeServer(server);
    } finally {
      await Promise.all(streams);
      if (streamFailure) throw streamFailure.error;
    }
  }
});

test("inline HTTP errorはinline-ai:stream-errorをemitしてrejectする", async () => {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "inline boom" }));
  });
  try {
    const { backend, events, root } = makeBackend();
    const settings = settingsWithEndpoints(
      baseUrl,
      baseUrl,
      "openai-compatible",
    );
    const args = await auditedArgs(
      backend,
      root,
      { messages: [{ role: "user", content: "continue" }] },
      "napi_inline_stream_error",
      { stream: true },
    );
    await assert.rejects(
      backend.sendInlineAiStream(args, settings, ""),
    );
    const event = await waitForEvent(events, "inline-ai:stream-error");
    assert.match(JSON.parse(event.payload).message, /HTTP 500/);
  } finally {
    await closeServer(server);
  }
});
