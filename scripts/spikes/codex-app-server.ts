/**
 * Manual protocol spike. This file is intentionally outside the Electron
 * runtime; it only verifies the installed Codex CLI's JSONL surface.
 *
 * Run with:
 *   GRIMODEX_TEST_CODEX_APP_SERVER=1 pnpm exec tsx scripts/spikes/codex-app-server.ts
 */
let childForFailure: { kill: () => boolean } | null = null;

async function main(): Promise<void> {
  if (process.env.GRIMODEX_TEST_CODEX_APP_SERVER !== "1") {
    console.error(
      "Set GRIMODEX_TEST_CODEX_APP_SERVER=1 to run the real Codex smoke test.",
    );
    return;
  }

  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const executable = process.env.CODEX_BIN ?? "codex";
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: false,
  });
  childForFailure = child;
  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      console.error("invalid JSON from app-server:", line);
      return;
    }
    console.log("<", JSON.stringify(message));
    if (
      typeof message === "object" &&
      message !== null &&
      "id" in message &&
      typeof message.id === "number"
    ) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    console.log(">", JSON.stringify(message));
    child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  await request("initialize", {
    clientInfo: {
      name: "grimodex-spike",
      title: "Grimodex spike",
      version: "0.0.0",
    },
    capabilities: { experimentalApi: false },
  });
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n', "utf8");
  await request("model/list", {});
  const thread = (await request("thread/start", {
    cwd: process.cwd(),
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
  })) as { result?: { thread?: { id?: string }; threadId?: string } };
  const threadId = thread?.result?.thread?.id ?? thread?.result?.threadId;
  const turn = (await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "日本語の短い応答を返してください。" }],
    sandbox: "read-only",
    approvalPolicy: "never",
    clientUserMessageId: "spike-user-message",
  })) as { result?: { turn?: { id?: string }; turnId?: string } };
  const turnId = turn?.result?.turn?.id ?? turn?.result?.turnId;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await request("thread/resume", { threadId });
  if (turnId) await request("turn/interrupt", { threadId, turnId });
  child.stdin.end();
}

main().catch((cause) => {
  console.error(cause);
  childForFailure?.kill();
  process.exitCode = 1;
});
