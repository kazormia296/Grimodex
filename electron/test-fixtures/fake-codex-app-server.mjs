#!/usr/bin/env node

// Deterministic JSONL App Server fixture. It is intentionally dependency-free
// so Electron protocol tests never need a real Codex install or network.
import readline from "node:readline";

let nextThread = 1;
let nextTurn = 1;
const pending = new Map();
const activeTurns = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function emitTurn(threadId, turnId) {
  notify("turn/started", { threadId, turnId });
  notify("item/started", {
    turnId,
    item: { id: `${turnId}-reasoning`, type: "reasoning", status: "started" },
  });
  notify("item/reasoning/summaryTextDelta", {
    turnId,
    itemId: `${turnId}-reasoning`,
    delta: "考えています。",
  });
  notify("item/completed", {
    turnId,
    item: {
      id: `${turnId}-reasoning`,
      type: "reasoning",
      status: "completed",
      text: "考えています。",
    },
  });
  notify("item/agentMessage/delta", { turnId, delta: "日本語の応答です。" });
  notify("thread/tokenUsage/updated", {
    turnId,
    usage: { inputTokens: 12, outputTokens: 8, cachedInputTokens: 2 },
  });
  notify("turn/completed", {
    threadId,
    turnId,
    status: { status: "completed" },
    usage: { inputTokens: 12, outputTokens: 8 },
  });
  activeTurns.delete(turnId);
}

function handleRequest(message) {
  if (message.method === "initialize") {
    response(message.id, {
      serverInfo: { name: "fake-codex", version: "fixture-1" },
    });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    response(message.id, {
      models: [{ id: "fake-model", name: "Fake Model" }],
    });
    return;
  }
  if (message.method === "thread/start") {
    if (
      process.env.FAKE_CODEX_REJECT_MCP === "1" &&
      message.params?.mcpServers
    ) {
      error(message.id, -32602, "unknown field mcpServers");
      return;
    }
    const threadId = `fake-thread-${nextThread++}`;
    response(message.id, { thread: { id: threadId } });
    notify("thread/started", { threadId });
    return;
  }
  if (message.method === "thread/resume") {
    response(message.id, { thread: { id: message.params?.threadId } });
    return;
  }
  if (
    message.method === "thread/archive" ||
    message.method === "thread/name/set"
  ) {
    response(message.id, {});
    return;
  }
  if (message.method === "turn/start") {
    const threadId = message.params?.threadId ?? "fake-thread-unknown";
    const turnId = `fake-turn-${nextTurn++}`;
    activeTurns.set(turnId, { threadId });
    response(message.id, { turn: { id: turnId } });
    if (process.env.FAKE_CODEX_APPROVAL === "1") {
      const requestId = `approval-${turnId}`;
      pending.set(requestId, { threadId, turnId });
      send({
        jsonrpc: "2.0",
        id: requestId,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          summary: "Run the fixture command",
          command: ["echo", "fixture"],
          affectedPaths: ["notes/example.txt"],
          diff: "+ fixture change",
        },
      });
    } else {
      setTimeout(() => emitTurn(threadId, turnId), 0);
    }
    return;
  }
  if (message.method === "turn/interrupt") {
    const turnId = message.params?.turnId;
    const active = activeTurns.get(turnId);
    response(message.id, {});
    if (active) {
      notify("turn/completed", {
        threadId: active.threadId,
        turnId,
        status: { status: "interrupted" },
      });
      activeTurns.delete(turnId);
    }
    return;
  }
  error(message.id, -32601, `unknown method ${message.method}`);
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
process.stdin.resume();
const keepAlive = setInterval(() => {}, 60_000);
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stdout.write("not-json\n");
    return;
  }
  if (Object.hasOwn(message, "id") && message.method === undefined) {
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.result?.decision === "accept") {
        setTimeout(() => emitTurn(request.threadId, request.turnId), 0);
      } else {
        notify("turn/completed", {
          threadId: request.threadId,
          turnId: request.turnId,
          status: { status: "declined" },
        });
      }
    }
    return;
  }
  handleRequest(message);
});
