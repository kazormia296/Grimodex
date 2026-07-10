// Phase 3 バッチ3b の napi 公開境界テスト。
// save/settings、inline stream + 専用 abort、agent tool wire、models、connection を
// ローカル OpenAI 互換モックで end-to-end 検証する。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function makeBackend() {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-ai-3b-"));
  roots.push(root);
  const appDataDir = join(root, "app-data");
  mkdirSync(appDataDir, { recursive: true });
  const events = [];
  const backend = new Backend(appDataDir);
  backend.onEvent((channel, payload) => events.push({ channel, payload }));
  return { backend, events };
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
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }),
    );
  });
  try {
    const { backend } = makeBackend();
    const settings = settingsWithEndpoints("http://127.0.0.1:1", baseUrl);
    const args = {
      messages: [
        { role: "user", content: "find moon" },
        {
          role: "assistant",
          content: "",
          toolUses: [
            {
              id: "previous-1",
              name: "search_codex",
              input: { query: "sun" },
            },
          ],
          thinkingBlocks: [],
        },
        {
          role: "tool_result",
          toolUseId: "previous-1",
          content: "found",
          isError: false,
        },
      ],
      tools: [
        {
          name: "search_codex",
          description: "Search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
        {
          name: "update_codex_entry",
          description: "Update",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
      provider: "openai-compatible",
      endpointId: "other",
      model: "agent-model",
      webSearch: null,
    };
    const result = JSON.parse(
      await backend.sendAgentMessage(args, settings, "sk-agent"),
    );

    assert.equal(request.url, "/chat/completions");
    assert.equal(request.authorization, "Bearer sk-agent");
    assert.equal(request.body.model, "agent-model");
    assert.ok(
      request.body.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.[0]?.id === "previous-1",
      ),
    );
    assert.ok(
      request.body.messages.some(
        (message) =>
          message.role === "tool" && message.tool_call_id === "previous-1",
      ),
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
  } finally {
    await closeServer(server);
  }
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
    const { backend } = makeBackend();
    const settings = settingsWithEndpoints("http://127.0.0.1:1", baseUrl);
    const message = await backend.testAiConnection(
      {
        provider: "openai-compatible",
        model: "probe-model",
        apiVariant: "v1",
        endpointId: "other",
      },
      settings,
      "sk-probe",
    );
    assert.equal(message, "Connection OK");
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.authorization, "Bearer sk-probe");
    assert.equal(request.body.model, "probe-model");
  } finally {
    await closeServer(server);
  }
});

test("inline abortはinlineだけを停止し、同時実行chatを止めない", async () => {
  const responses = new Map();
  let markBothStarted;
  const bothStarted = new Promise((resolve) => {
    markBothStarted = resolve;
  });
  const { server, baseUrl } = await startMockServer(async (req, res) => {
    const body = await readJson(req);
    responses.set(body.model, res);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sseFrame({ choices: [{ delta: { content: `${body.model}-first` } }] }),
    );
    if (responses.size === 2) markBothStarted();
  });
  try {
    const { backend, events } = makeBackend();
    const settings = settingsWithEndpoints(
      baseUrl,
      baseUrl,
      "openai-compatible",
    );
    const messages = [{ role: "user", content: "continue" }];
    const chat = backend.sendChatMessageStream(
      { messages, model: "chat-model" },
      settings,
      "",
    );
    const inline = backend.sendInlineAiStream(
      { messages, model: "inline-model" },
      settings,
      "",
    );

    await bothStarted;
    await waitForEvent(events, "chat:stream-chunk");
    await waitForEvent(events, "inline-ai:stream-chunk");
    backend.abortInlineAiStream();

    const inlineResponse = responses.get("inline-model");
    inlineResponse.write(
      sseFrame({ choices: [{ delta: { content: "inline-must-not-arrive" } }] }),
    );
    inlineResponse.end();

    const chatResponse = responses.get("chat-model");
    chatResponse.write(
      sseFrame({ choices: [{ delta: { content: "-second" } }] }),
    );
    chatResponse.write(
      sseFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    );
    chatResponse.write("data: [DONE]\n\n");
    chatResponse.end();

    await Promise.all([chat, inline]);
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
    await closeServer(server);
  }
});

test("inline HTTP errorはinline-ai:stream-errorをemitしてrejectする", async () => {
  const { server, baseUrl } = await startMockServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "inline boom" }));
  });
  try {
    const { backend, events } = makeBackend();
    const settings = settingsWithEndpoints(
      baseUrl,
      baseUrl,
      "openai-compatible",
    );
    await assert.rejects(
      backend.sendInlineAiStream(
        { messages: [{ role: "user", content: "continue" }] },
        settings,
        "",
      ),
    );
    const event = await waitForEvent(events, "inline-ai:stream-error");
    assert.match(JSON.parse(event.payload).message, /HTTP 500/);
  } finally {
    await closeServer(server);
  }
});
