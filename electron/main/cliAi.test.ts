import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCliInvocation,
  createCliAiManager,
  createNodeCliProcessRunner,
  detectCliBinaryMain,
  MAX_CLI_LINE_BYTES,
  type CliCommandSpec,
  type CliProcessResult,
  type CliProcessRunner,
  type RunningCliProcess,
} from "./cliAi.js";

class FakeRunningProcess implements RunningCliProcess {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly terminate = vi.fn<(signal: "SIGTERM" | "SIGKILL") => void>();
  readonly completion: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private finishCompletion!: (result: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;

  constructor() {
    this.completion = new Promise((resolve) => {
      this.finishCompletion = resolve;
    });
  }

  finish(
    exitCode: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.stdout.end();
    this.stderr.end();
    this.finishCompletion({ exitCode, signal });
  }
}

class FakeRunner implements CliProcessRunner {
  readonly runCalls: Array<{
    spec: CliCommandSpec;
    options: { timeoutMs: number; maxOutputBytes: number };
  }> = [];
  readonly startCalls: CliCommandSpec[] = [];
  runResult: CliProcessResult = {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
  };
  nextRunning = new FakeRunningProcess();
  startError: Error | null = null;
  readonly disposeAll = vi.fn<() => void>();

  async run(
    spec: CliCommandSpec,
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CliProcessResult> {
    this.runCalls.push({ spec, options });
    return this.runResult;
  }

  start(spec: CliCommandSpec): RunningCliProcess {
    this.startCalls.push(spec);
    if (this.startError) throw this.startError;
    return this.nextRunning;
  }
}

interface EmittedEvent {
  channel: string;
  payload: unknown;
}

function createHarness() {
  const events: EmittedEvent[] = [];
  const runner = new FakeRunner();
  const detectBinary = vi.fn(async (kind: string) => `/usr/local/bin/${kind}`);
  const manager = createCliAiManager(
    (channel, payload) => events.push({ channel, payload }),
    {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      authorizeExecutable: async () => true,
      detectBinary,
      forceKillAfterMs: 20,
    },
  );
  return { events, runner, detectBinary, manager };
}

describe("buildCliInvocation", () => {
  it("Claudeはpromptを単一argvに保ち、全toolを無効化する", () => {
    const prompt = 'hello"; rm -rf / #';
    const spec = buildCliInvocation("claude", "/opt/bin/claude", {
      model: "sonnet",
      prompt,
    });
    expect(spec.executable).toBe("/opt/bin/claude");
    expect(spec.args).toEqual([
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowed-tools",
      "",
      "--permission-mode",
      "default",
      "--model",
      "sonnet",
    ]);
  });

  it("Codexはread-only sandbox、OpenCodeは全tool denyを固定する", () => {
    expect(
      buildCliInvocation("codex", "codex", {
        model: "gpt-5",
        prompt: "write?",
      }),
    ).toMatchObject({
      executable: "codex",
      args: [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-5",
        "write?",
      ],
    });

    const opencode = buildCliInvocation("opencode", "opencode", {
      model: null,
      prompt: "hello",
    });
    expect(opencode.args).toEqual([
      "--print-logs",
      "run",
      "--format",
      "json",
      "hello",
    ]);
    expect(JSON.parse(opencode.env?.OPENCODE_PERMISSION ?? "")).toEqual({
      permission: {
        read: "deny",
        edit: "deny",
        glob: "deny",
        grep: "deny",
        bash: "deny",
        task: "deny",
        skill: "deny",
        lsp: "deny",
        question: "deny",
        webfetch: "deny",
        websearch: "deny",
        external_directory: "deny",
      },
    });
  });
});

describe("CliAiManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("detectは厳格なCliKindだけを受け、見つからなければnull", async () => {
    const { manager, detectBinary } = createHarness();
    await expect(
      manager.handlers.detect_cli_binary({ cli: "claude" }),
    ).resolves.toBe("/usr/local/bin/claude");
    expect(detectBinary).toHaveBeenCalledWith("claude");
    await expect(
      manager.handlers.detect_cli_binary({ cli: "node" }),
    ).rejects.toThrow("invalid CLI kind: node");
  });

  it("testはkindと無関係な実行ファイルを拒否し、許可CLIへ--versionだけ渡す", async () => {
    const { manager, runner } = createHarness();
    await expect(
      manager.handlers.test_cli_connection({ binaryPath: "/usr/bin/node" }),
    ).rejects.toThrow(/CLI executable/);
    runner.runResult.stdout = "claude 1.2.3\n";
    await expect(
      manager.handlers.test_cli_connection({
        binaryPath: "/usr/local/bin/claude",
      }),
    ).resolves.toBe("claude 1.2.3");
    expect(runner.runCalls.at(-1)?.spec).toMatchObject({
      executable: "/usr/local/bin/claude",
      args: ["--version"],
    });
    expect(runner.runCalls.at(-1)?.options.timeoutMs).toBeLessThanOrEqual(
      10_000,
    );
  });

  it("未検出の絶対pathはmain側authorizationなしに実行しない", async () => {
    const runner = new FakeRunner();
    const denied = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
    });
    await expect(
      denied.handlers.test_cli_connection({
        binaryPath: "/tmp/claude",
      }),
    ).rejects.toThrow("CLI executable was not authorized");
    expect(runner.runCalls).toHaveLength(0);

    const authorizeExecutable = vi.fn(async () => true);
    const allowed = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      authorizeExecutable,
    });
    runner.runResult.stdout = "claude 1.2.3\n";
    await expect(
      allowed.handlers.test_cli_connection({
        binaryPath: "/opt/custom/claude",
      }),
    ).resolves.toBe("claude 1.2.3");
    expect(authorizeExecutable).toHaveBeenCalledWith(
      "claude",
      "/opt/custom/claude",
    );
  });

  it("Claudeは静的model、Codex/OpenCodeは安全なargvの出力をparseする", async () => {
    const { manager, runner } = createHarness();
    const claude = await manager.handlers.list_cli_models({
      cli: "claude",
      binaryPath: null,
    });
    expect(claude).toEqual(
      expect.arrayContaining([
        { id: "opus", name: "Opus (latest alias)" },
        { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      ]),
    );
    expect(runner.runCalls).toHaveLength(0);

    runner.runResult.stdout = JSON.stringify({
      models: [
        { slug: "visible", display_name: "Visible", visibility: "list" },
        { slug: "hidden", visibility: "hide" },
      ],
    });
    await expect(
      manager.handlers.list_cli_models({
        cli: "codex",
        binaryPath: "/usr/local/bin/codex",
      }),
    ).resolves.toEqual([{ id: "visible", name: "Visible" }]);
    expect(runner.runCalls.at(-1)?.spec.args).toEqual([
      "debug",
      "models",
      "--bundled",
    ]);

    runner.runResult.stdout = "openai/gpt-5\nanthropic/claude\ninvalid\n";
    await expect(
      manager.handlers.list_cli_models({
        cli: "opencode",
        binaryPath: "/usr/local/bin/opencode",
      }),
    ).resolves.toEqual([
      { id: "openai/gpt-5", name: "gpt-5" },
      { id: "anthropic/claude", name: "claude" },
    ]);
  });

  it("streamはchunkを配信し、adapter Doneを終端で一度だけemitする", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      payload: {
        cli: "claude",
        binaryPath: "/usr/local/bin/claude",
        model: "sonnet",
        prompt: "hello",
      },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}\n',
    );
    runner.nextRunning.stdout.write(
      '{"type":"result","usage":{"input_tokens":3,"output_tokens":1},"stop_reason":"end_turn"}\n',
    );
    runner.nextRunning.finish();
    await expect(send).resolves.toBeNull();

    expect(events).toEqual([
      {
        channel: "cli:stream-chunk",
        payload: { delta: "Hello", block_type: "text" },
      },
      {
        channel: "cli:stream-done",
        payload: {
          stop_reason: "end_turn",
          input_tokens: 3,
          output_tokens: 1,
        },
      },
    ]);
  });

  it("mismatched binaryと並行2本目を明示拒否する", async () => {
    const { manager, runner } = createHarness();
    await expect(
      manager.handlers.send_cli_chat_stream({
        payload: {
          cli: "claude",
          binaryPath: "/usr/bin/node",
          prompt: "console.log('pwned')",
        },
      }),
    ).rejects.toThrow(/does not match CLI kind/);
    expect(runner.startCalls).toHaveLength(0);

    const first = manager.handlers.send_cli_chat_stream({
      payload: { cli: "codex", prompt: "first" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    await expect(
      manager.handlers.send_cli_chat_stream({
        payload: { cli: "codex", prompt: "second" },
      }),
    ).rejects.toThrow("CLI stream is already running");
    runner.nextRunning.finish();
    await first;
  });

  it("abortは無出力childを即TERMし、deltaを止めてstopped Doneにする", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      payload: { cli: "opencode", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));

    await expect(
      manager.handlers.abort_cli_chat_stream({}),
    ).resolves.toBeNull();
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM");
    runner.nextRunning.stdout.write(
      '{"type":"text","part":{"id":"p1","text":"late"}}\n',
    );
    runner.nextRunning.finish(null, "SIGTERM");
    await expect(send).resolves.toBeNull();
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("spawn準備中のabortも失わず、childを起動せずstopped Doneにする", async () => {
    const events: EmittedEvent[] = [];
    const runner = new FakeRunner();
    let resolveIsFile!: (value: boolean) => void;
    const isFile = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveIsFile = resolve;
        }),
    );
    const manager = createCliAiManager(
      (channel, payload) => events.push({ channel, payload }),
      {
        runner,
        platform: "linux",
        isFile,
        realPath: async (candidate) => candidate,
        authorizeExecutable: async () => true,
        forceKillAfterMs: 20,
      },
    );

    const send = manager.handlers.send_cli_chat_stream({
      payload: {
        cli: "claude",
        binaryPath: "/usr/local/bin/claude",
        prompt: "hello",
      },
    });
    await vi.waitFor(() => expect(isFile).toHaveBeenCalledOnce());
    await manager.handlers.abort_cli_chat_stream({});
    resolveIsFile(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.startCalls).toHaveLength(0);
    await expect(send).resolves.toBeNull();
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("spawn/非zero/巨大lineはerror eventとinvoke rejectの両方にする", async () => {
    const spawnHarness = createHarness();
    spawnHarness.runner.startError = new Error("ENOENT");
    await expect(
      spawnHarness.manager.handlers.send_cli_chat_stream({
        payload: { cli: "claude", prompt: "hello" },
      }),
    ).rejects.toThrow("Failed to spawn CLI");
    expect(spawnHarness.events).toEqual([
      {
        channel: "cli:stream-error",
        payload: { message: expect.stringContaining("Failed to spawn CLI") },
      },
    ]);

    const exitHarness = createHarness();
    const failed = exitHarness.manager.handlers.send_cli_chat_stream({
      payload: { cli: "codex", prompt: "hello" },
    });
    await vi.waitFor(() =>
      expect(exitHarness.runner.startCalls).toHaveLength(1),
    );
    exitHarness.runner.nextRunning.stderr.write("fatal auth error");
    exitHarness.runner.nextRunning.finish(2);
    await expect(failed).rejects.toThrow(
      /exited with code 2.*fatal auth error/,
    );
    expect(exitHarness.events.at(-1)?.channel).toBe("cli:stream-error");

    const lineHarness = createHarness();
    const oversized = lineHarness.manager.handlers.send_cli_chat_stream({
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() =>
      expect(lineHarness.runner.startCalls).toHaveLength(1),
    );
    lineHarness.runner.nextRunning.stdout.write(
      "x".repeat(MAX_CLI_LINE_BYTES + 1),
    );
    lineHarness.runner.nextRunning.finish();
    await expect(oversized).rejects.toThrow("CLI stdout line exceeds limit");
  });

  it("stream全体のbyte上限を超えたchildを停止してrejectする", async () => {
    const events: EmittedEvent[] = [];
    const runner = new FakeRunner();
    const manager = createCliAiManager(
      (channel, payload) => events.push({ channel, payload }),
      {
        runner,
        platform: "linux",
        isFile: async () => true,
        realPath: async (candidate) => candidate,
        authorizeExecutable: async () => true,
        maxStreamBytes: 64,
        maxStreamLines: 100,
        forceKillAfterMs: 20,
      },
    );
    const send = manager.handlers.send_cli_chat_stream({
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write("{}\n".repeat(32));
    runner.nextRunning.finish();

    await expect(send).rejects.toThrow("CLI stdout exceeds total byte limit");
    expect(events.at(-1)?.channel).toBe("cli:stream-error");
  });

  it("stream全体のline上限を超えたchildを停止してrejectする", async () => {
    const runner = new FakeRunner();
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      authorizeExecutable: async () => true,
      maxStreamBytes: 1024,
      maxStreamLines: 2,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write("{}\n{}\n{}\n");
    runner.nextRunning.finish();

    await expect(send).rejects.toThrow("CLI stdout exceeds line limit");
  });

  it("main側deadlineでhang childを停止してtimeoutとしてrejectする", async () => {
    const runner = new FakeRunner();
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      authorizeExecutable: async () => true,
      streamTimeoutMs: 20,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() =>
      expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM"),
    );
    runner.nextRunning.finish(null, "SIGTERM");

    await expect(send).rejects.toThrow("CLI stream timed out after 20ms");
  });

  it("disposeAllはactive childを停止する", async () => {
    const { manager, runner } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    manager.disposeAll();
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM");
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(runner.disposeAll).toHaveBeenCalledOnce();
    runner.nextRunning.finish(null, "SIGTERM");
    await send;
  });
});

describe("createNodeCliProcessRunner", () => {
  it(
    "disposeAllは実childを即時回収する",
    async () => {
      const runner = createNodeCliProcessRunner(process.platform);
      const running = runner.start({
        executable: process.execPath,
        args: [
          "-e",
          "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
        ],
      });
      await new Promise<void>((resolve, reject) => {
        running.stdout.once("data", () => resolve());
        running.stdout.once("error", reject);
      });

      if (!runner.disposeAll) {
        running.terminate("SIGKILL");
        await running.completion;
        throw new Error("CliProcessRunner.disposeAll is missing");
      }
      runner.disposeAll();
      const result = await running.completion;
      expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
    },
    10_000,
  );
});

describe("detectCliBinaryMain", () => {
  it("固定Cli名だけをshell argvへ渡し、実在する検出pathだけ返す", async () => {
    const runner = new FakeRunner();
    runner.runResult.stdout = "/custom/bin/claude\n";
    await expect(
      detectCliBinaryMain("claude", {
        runner,
        platform: "linux",
        env: { HOME: "/home/test", PATH: "" },
        homeDir: "/home/test",
        isFile: async (candidate) => candidate === "/custom/bin/claude",
      }),
    ).resolves.toBe("/custom/bin/claude");
    expect(runner.runCalls[0]?.spec.args.at(-1)).toBe("command -v claude");
  });
});
