import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { JsonRpcConnection } from "./jsonRpcConnection.js";

// Managed Codex sandboxes may prohibit spawning the bundled Node binary. Keep
// the fixture test active in normal CI while making that environmental limit
// an explicit skip instead of a protocol failure.
const nodeProbe = spawnSync(
  process.execPath,
  ["-e", "process.stdout.write('codex-node-probe')"],
  { encoding: "utf8" },
);
const canSpawnNode =
  !nodeProbe.error &&
  nodeProbe.status === 0 &&
  nodeProbe.stdout === "codex-node-probe";

describe("fake Codex App Server fixture", () => {
  const test = canSpawnNode ? it : it.skip;
  test("speaks initialize/model/thread/turn JSONL with UTF-8 notifications", async () => {
    const fixture = fileURLToPath(
      new URL("../../test-fixtures/fake-codex-app-server.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [fixture], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const notifications: string[] = [];
    const wire = {
      write(line: string) {
        child.stdin.write(line, "utf8");
      },
      onData(listener: (chunk: Buffer | string) => void) {
        const handler = (chunk: Buffer) => listener(chunk);
        child.stdout.on("data", handler);
        return () => child.stdout.off("data", handler);
      },
      onClose(listener: (cause?: Error) => void) {
        const handler = (code: number | null, signal: NodeJS.Signals | null) =>
          listener(new Error(`fixture exited: ${code ?? signal ?? "unknown"}`));
        child.once("close", handler);
        return () => child.off("close", handler);
      },
      onError(listener: (cause: Error) => void) {
        const handler = (cause: Error) => listener(cause);
        child.once("error", handler);
        return () => child.off("error", handler);
      },
      close() {
        child.stdin.end();
        child.kill();
      },
    };
    const connection = new JsonRpcConnection(wire, {
      requestTimeoutMs: 2_000,
      onNotification: (method) => notifications.push(method),
    });
    try {
      await expect(connection.request("initialize")).resolves.toMatchObject({
        serverInfo: { version: "fixture-1" },
      });
      connection.notify("initialized");
      await expect(connection.request("model/list")).resolves.toMatchObject({
        models: [{ id: "fake-model" }],
      });
      const thread = await connection.request("thread/start", {
        cwd: "/workspace",
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      const threadId = (thread as { thread: { id: string } }).thread.id;
      const turn = await connection.request("turn/start", {
        threadId,
        input: [{ type: "text", text: "改行\n日本語" }],
      });
      expect((turn as { turn: { id: string } }).turn.id).toMatch(/^fake-turn-/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notifications).toEqual(
        expect.arrayContaining([
          "thread/started",
          "turn/started",
          "item/reasoning/summaryTextDelta",
          "item/agentMessage/delta",
          "thread/tokenUsage/updated",
          "turn/completed",
        ]),
      );
    } finally {
      connection.dispose();
      child.kill();
    }
  });
});
