import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { launchProductJourneyMcpClient } from "../electron/scripts/product-journey-mcp-client.mjs";

function createFakeMcpProcess(handler) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };

  let buffered = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const lineEnd = buffered.indexOf("\n");
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const response = handler(message);
      if (response !== undefined) {
        child.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
  });
  child.stdin.on("end", () => {
    queueMicrotask(() => child.emit("exit", 0, null));
  });
  return child;
}

test("MCP client performs the stdio handshake, calls a tool, and closes cleanly", async () => {
  const messages = [];
  const spawnCalls = [];
  const child = createFakeMcpProcess((message) => {
    messages.push(message);
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-grimodex", version: "1.0.0" },
        },
      };
    }
    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "propose_scene_body" }] },
      };
    }
    if (message.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                staging_id: "stage-1",
                scene_id: "scene-1",
                status: "proposed",
              }),
            },
          ],
          isError: false,
        },
      };
    }
    return undefined;
  });

  const client = await launchProductJourneyMcpClient({
    binaryPath: "/tmp/grimodex-mcp",
    workspacePath: "/tmp/workspace",
    projectId: "project-1",
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
  });
  const listed = await client.listTools();
  const called = await client.callTool("propose_scene_body", {
    scene_id: "scene-1",
    text: "external body",
    mode: "append",
  });
  await client.close();

  assert.deepEqual(spawnCalls, [
    {
      command: "/tmp/grimodex-mcp",
      args: [
        "--workspace",
        "/tmp/workspace",
        "--project",
        "project-1",
      ],
      options: {
        stdio: ["pipe", "pipe", "pipe"],
      },
    },
  ]);
  assert.deepEqual(
    messages.map((message) => message.method),
    [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ],
  );
  assert.equal(messages[0].params.protocolVersion, "2025-11-25");
  assert.deepEqual(listed.tools, [{ name: "propose_scene_body" }]);
  assert.equal(called.isError, false);
  assert.match(called.content[0].text, /"staging_id":"stage-1"/);
  assert.equal(child.killed, false);
});

test("MCP client rejects protocol and tool-level errors", async () => {
  const rpcErrorChild = createFakeMcpProcess((message) => {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-grimodex", version: "1.0.0" },
        },
      };
    }
    if (message.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32_000, message: "tool exploded" },
      };
    }
    return undefined;
  });
  const rpcClient = await launchProductJourneyMcpClient({
    binaryPath: "/tmp/grimodex-mcp",
    workspacePath: "/tmp/workspace",
    projectId: "project-1",
    spawnProcess: () => rpcErrorChild,
  });
  await assert.rejects(
    rpcClient.callTool("propose_scene_body", {}),
    /tool exploded/,
  );
  await rpcClient.close();

  const toolErrorChild = createFakeMcpProcess((message) => {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-grimodex", version: "1.0.0" },
        },
      };
    }
    if (message.method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "rejected" }],
          isError: true,
        },
      };
    }
    return undefined;
  });
  const toolClient = await launchProductJourneyMcpClient({
    binaryPath: "/tmp/grimodex-mcp",
    workspacePath: "/tmp/workspace",
    projectId: "project-1",
    spawnProcess: () => toolErrorChild,
  });
  await assert.rejects(
    toolClient.callTool("propose_scene_body", {}),
    /tool returned an error.*rejected/i,
  );
  await toolClient.close();
});
