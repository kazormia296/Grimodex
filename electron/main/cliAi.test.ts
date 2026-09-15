import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const stableHashFile = async (): Promise<string> => "stable-sha256";

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
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      detectBinary,
      forceKillAfterMs: 20,
    },
  );
  return { events, runner, detectBinary, manager };
}

describe("buildCliInvocation", () => {
  it("Claudeはpromptをargvへ載せずstdinへ渡し、全toolを無効化する", () => {
    const prompt = 'hello"; rm -rf / #';
    const spec = buildCliInvocation("claude", "/opt/bin/claude", {
      model: "sonnet",
      prompt,
    });
    expect(spec.executable).toBe("/opt/bin/claude");
    expect(spec.input).toBe(prompt);
    expect(spec.args).toEqual([
      "-p",
      "--input-format",
      "text",
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
        "-",
      ],
      input: "write?",
    });

    const opencode = buildCliInvocation("opencode", "opencode", {
      model: null,
      prompt: "hello",
    });
    expect(opencode.args).toEqual(["--print-logs", "run", "--format", "json"]);
    expect(opencode.input).toBe("hello");
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

    const bedrock = buildCliInvocation("opencode", "opencode", {
      model: "amazon-bedrock/anthropic.claude-sonnet",
      prompt: "hello",
    });
    expect(bedrock.envKeys).toEqual(
      expect.arrayContaining([
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_PROFILE",
        "AWS_REGION",
      ]),
    );
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
      hashFile: stableHashFile,
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
      hashFile: async () => "abc123",
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
      { sha256: "abc123" },
    );
  });

  it("PATH自動検出されたcanonical pathも初回authorizationを要求する", async () => {
    const runner = new FakeRunner();
    const detectBinary = vi.fn(async () => "/usr/local/bin/claude");
    const authorizeExecutable = vi.fn(async () => false);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: async () => "abc123",
      detectBinary,
      authorizeExecutable,
    });

    await expect(
      manager.handlers.detect_cli_binary({ cli: "claude" }),
    ).rejects.toThrow("CLI executable was not authorized");
    expect(authorizeExecutable).toHaveBeenCalledWith(
      "claude",
      "/usr/local/bin/claude",
      { sha256: "abc123" },
    );
    expect(runner.runCalls).toHaveLength(0);
  });

  it("許可済み identity も実行直前に再hashし、同一なら再確認しない", async () => {
    const runner = new FakeRunner();
    runner.runResult.stdout = "claude 1.2.3\n";
    const hashFile = vi.fn(stableHashFile);
    const authorizeExecutable = vi.fn(async () => true);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile,
      authorizeExecutable,
    });

    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });
    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });

    expect(hashFile).toHaveBeenCalledTimes(3);
    expect(authorizeExecutable).toHaveBeenCalledOnce();
    expect(runner.runCalls).toHaveLength(2);
  });

  it("SHA-256 を取得できない実行ファイルは許可確認前に fail-closed する", async () => {
    const runner = new FakeRunner();
    const authorizeExecutable = vi.fn(async () => true);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: async () => null,
      authorizeExecutable,
    });

    await expect(
      manager.handlers.test_cli_connection({
        binaryPath: "/opt/claude",
      }),
    ).rejects.toThrow("CLI executable could not be fingerprinted");
    expect(authorizeExecutable).not.toHaveBeenCalled();
    expect(runner.runCalls).toHaveLength(0);
  });

  it("同じ requested path の canonical target が変われば旧 cache を破棄する", async () => {
    const runner = new FakeRunner();
    runner.runResult.stdout = "claude 1.2.3\n";
    const canonicalPaths = [
      "/opt/v1/claude",
      "/opt/v1/claude",
      "/opt/v2/claude",
      "/opt/v2/claude",
    ];
    const authorizeExecutable = vi.fn(async () => true);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async () => canonicalPaths.shift() ?? "/opt/v2/claude",
      hashFile: stableHashFile,
      authorizeExecutable,
    });

    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });
    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });

    expect(authorizeExecutable).toHaveBeenNthCalledWith(
      1,
      "claude",
      "/opt/v1/claude",
      { sha256: "stable-sha256" },
    );
    expect(authorizeExecutable).toHaveBeenNthCalledWith(
      2,
      "claude",
      "/opt/v2/claude",
      { sha256: "stable-sha256" },
    );
    expect(runner.runCalls.map(({ spec }) => spec.executable)).toEqual([
      "/opt/v1/claude",
      "/opt/v2/claude",
    ]);
  });

  it("許可後に内容が変われば cache を無効化し、stream spawn 前に再確認する", async () => {
    const runner = new FakeRunner();
    runner.runResult.stdout = "claude 1.2.3\n";
    const hashes = [
      "approved-sha",
      "approved-sha",
      "replacement-sha",
      "replacement-sha",
    ];
    const hashFile = vi.fn(async () => hashes.shift() ?? "replacement-sha");
    const authorizeExecutable = vi.fn(async () => true);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile,
      authorizeExecutable,
      forceKillAfterMs: 20,
    });

    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: {
        cli: "claude",
        binaryPath: "/opt/claude",
        prompt: "hello",
      },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.finish();
    await expect(send).resolves.toBeNull();

    expect(authorizeExecutable).toHaveBeenNthCalledWith(
      1,
      "claude",
      "/opt/claude",
      { sha256: "approved-sha" },
    );
    expect(authorizeExecutable).toHaveBeenNthCalledWith(
      2,
      "claude",
      "/opt/claude",
      { sha256: "replacement-sha" },
    );
    expect(hashFile).toHaveBeenCalledTimes(4);
  });

  it("再確認ダイアログ中に再び内容が変われば spawn しない", async () => {
    const runner = new FakeRunner();
    runner.runResult.stdout = "claude 1.2.3\n";
    const hashes = [
      "approved-sha",
      "approved-sha",
      "replacement-sha",
      "second-replacement-sha",
    ];
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: async () => hashes.shift() ?? "second-replacement-sha",
      authorizeExecutable: async () => true,
    });

    await manager.handlers.test_cli_connection({
      binaryPath: "/opt/claude",
    });
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-test",
        payload: {
          cli: "claude",
          binaryPath: "/opt/claude",
          prompt: "hello",
        },
      }),
    ).rejects.toThrow("CLI executable changed after authorization");
    expect(runner.startCalls).toHaveLength(0);
  });

  it("Windowsのforward-slash UNC pathはrealpath前に拒否する", async () => {
    const runner = new FakeRunner();
    const resolveRealPath = vi.fn(async (candidate: string) => candidate);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "win32",
      isFile: async () => true,
      realPath: resolveRealPath,
      authorizeExecutable: async () => true,
    });

    await expect(
      manager.handlers.test_cli_connection({
        binaryPath: "//attacker/share/codex.cmd",
      }),
    ).rejects.toThrow("network path");
    expect(resolveRealPath).not.toHaveBeenCalled();
    expect(runner.runCalls).toHaveLength(0);
  });

  it("Windowsのcase-sensitive directoryでは大小文字違いを別grantにする", async () => {
    const runner = new FakeRunner();
    const authorizeExecutable = vi.fn(async () => true);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "win32",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: stableHashFile,
      authorizeExecutable,
    });

    await manager.handlers.test_cli_connection({
      binaryPath: "C:\\Tools\\claude.cmd",
    });
    await manager.handlers.test_cli_connection({
      binaryPath: "C:\\tools\\claude.cmd",
    });
    expect(authorizeExecutable).toHaveBeenCalledTimes(2);
  });

  it("refresh検出失敗後は古いauto-detected pathを再利用しない", async () => {
    const runner = new FakeRunner();
    const detected: Array<string | null> = [
      "/usr/local/bin/claude",
      null,
      null,
    ];
    const detectBinary = vi.fn(async () => detected.shift() ?? null);
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      detectBinary,
    });

    await expect(
      manager.handlers.detect_cli_binary({ cli: "claude" }),
    ).resolves.toBe("/usr/local/bin/claude");
    await expect(
      manager.handlers.detect_cli_binary({ cli: "claude" }),
    ).resolves.toBeNull();
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-test",
        payload: { cli: "claude", prompt: "hello" },
      }),
    ).rejects.toThrow("CLI executable not found: claude");
    expect(runner.startCalls).toHaveLength(0);
    expect(detectBinary).toHaveBeenCalledTimes(3);
  });

  it("並行refreshでは遅れて完了した古い検出結果を復活させない", async () => {
    const runner = new FakeRunner();
    let resolveFirst!: (value: string | null) => void;
    let callCount = 0;
    const detectBinary = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise<string | null>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return null;
    });
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      detectBinary,
    });

    const first = manager.handlers.detect_cli_binary({ cli: "claude" });
    await vi.waitFor(() => expect(detectBinary).toHaveBeenCalledOnce());
    await expect(
      manager.handlers.detect_cli_binary({ cli: "claude" }),
    ).resolves.toBeNull();
    resolveFirst("/usr/local/bin/claude");
    await expect(first).resolves.toBeNull();
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-test",
        payload: { cli: "claude", prompt: "hello" },
      }),
    ).rejects.toThrow("CLI executable not found: claude");
    expect(runner.startCalls).toHaveLength(0);
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
    expect(runner.runCalls.at(-1)?.spec.kind).toBe("opencode");
  });

  it("streamはchunkを配信し、adapter Doneを終端で一度だけemitする", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
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
        payload: {
          streamId: "stream-test",
          delta: "Hello",
          block_type: "text",
        },
      },
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-test",
          stop_reason: "end_turn",
          input_tokens: 3,
          output_tokens: 1,
        },
      },
    ]);
  });

  it("streamIdをstrict検証し、mismatched binaryと並行2本目をevent誤配信なしで拒否する", async () => {
    const { manager, runner, events } = createHarness();
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "   ",
        payload: { cli: "codex", prompt: "missing correlation" },
      }),
    ).rejects.toThrow(/streamId.*non-empty/iu);
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-test",
        payload: {
          cli: "claude",
          binaryPath: "/usr/bin/node",
          prompt: "console.log('pwned')",
        },
      }),
    ).rejects.toThrow(/does not match CLI kind/);
    expect(runner.startCalls).toHaveLength(0);

    const first = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: { cli: "codex", prompt: "first" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-busy",
        payload: { cli: "codex", prompt: "second" },
      }),
    ).rejects.toThrow("CLI stream is already running");
    expect(events).toEqual([]);
    runner.nextRunning.finish();
    await first;
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-test",
          stop_reason: "end_turn",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("abortは対象childだけをTERMし、late deltaを旧IDのまま残してから次streamを分離する", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: { cli: "opencode", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));

    const abort = manager.handlers.abort_cli_chat_stream({
      streamId: "stream-test",
    });
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM");
    runner.nextRunning.stdout.write(
      '{"type":"text","part":{"id":"p1","text":"late"}}\n',
    );
    runner.nextRunning.finish(null, "SIGTERM");
    await expect(abort).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await expect(send).resolves.toBeNull();
    runner.nextRunning = new FakeRunningProcess();
    const next = manager.handlers.send_cli_chat_stream({
      streamId: "stream-next",
      payload: { cli: "claude", prompt: "next" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(2));
    runner.nextRunning.stdout.write(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"next"}]}}\n',
    );
    runner.nextRunning.finish();
    await next;
    expect(events).toEqual([
      {
        channel: "cli:stream-chunk",
        payload: {
          streamId: "stream-test",
          delta: "late",
          block_type: "text",
        },
      },
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-test",
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
      {
        channel: "cli:stream-chunk",
        payload: {
          streamId: "stream-next",
          delta: "next",
          block_type: "text",
        },
      },
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-next",
          stop_reason: "end_turn",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("provider terminalがabortより先なら後続semantic bytesを抑止して最初のterminalを維持する", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-provider-first",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write(
      '{"type":"result","usage":{"input_tokens":7,"output_tokens":3},"stop_reason":"end_turn"}\n',
    );

    const abort = manager.handlers.abort_cli_chat_stream({
      streamId: "stream-provider-first",
    });
    runner.nextRunning.stdout.write(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"late evidence"}]}}\n',
    );
    runner.nextRunning.stdout.write(
      '{"type":"result","usage":{"input_tokens":99,"output_tokens":99},"stop_reason":"error"}\n',
    );
    runner.nextRunning.finish(null, "SIGTERM");

    await expect(abort).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    await expect(send).resolves.toBeNull();
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-provider-first",
          stop_reason: "end_turn",
          input_tokens: 7,
          output_tokens: 3,
        },
      },
    ]);
  });

  it("provider terminal後のnon-zero exitは成功terminalを上書きしない", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-provider-exit",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write(
      '{"type":"result","usage":{"input_tokens":7,"output_tokens":3},"stop_reason":"end_turn"}\n',
    );
    runner.nextRunning.stderr.write("late process diagnostic");
    runner.nextRunning.finish(2);

    await expect(send).resolves.toBeNull();
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-provider-exit",
          stop_reason: "end_turn",
          input_tokens: 7,
          output_tokens: 3,
        },
      },
    ]);
  });

  it("provider terminal後のstdout limit失敗も成功terminalを上書きしない", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-provider-stdout-limit",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));
    runner.nextRunning.stdout.write(
      '{"type":"result","usage":{"input_tokens":5,"output_tokens":2},"stop_reason":"end_turn"}\n',
    );
    runner.nextRunning.stdout.write("x".repeat(MAX_CLI_LINE_BYTES + 1));
    runner.nextRunning.finish(2);

    await expect(send).resolves.toBeNull();
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-provider-stdout-limit",
          stop_reason: "end_turn",
          input_tokens: 5,
          output_tokens: 2,
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
        hashFile: stableHashFile,
        authorizeExecutable: async () => true,
        forceKillAfterMs: 20,
      },
    );

    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: {
        cli: "claude",
        binaryPath: "/usr/local/bin/claude",
        prompt: "hello",
      },
    });
    await vi.waitFor(() => expect(isFile).toHaveBeenCalledOnce());
    const abort = manager.handlers.abort_cli_chat_stream({
      streamId: "stream-test",
    });
    resolveIsFile(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.startCalls).toHaveLength(0);
    await expect(send).resolves.toBeNull();
    await expect(abort).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-test",
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("abort-before-send tombstoneは同じstreamIdだけをzero-spawn stoppedにする", async () => {
    const { manager, runner, events } = createHarness();
    await expect(
      manager.handlers.abort_cli_chat_stream({ streamId: "stream-future" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });

    await expect(
      manager.handlers.send_cli_chat_stream({
        streamId: "stream-future",
        payload: { cli: "claude", prompt: "must not spawn" },
      }),
    ).resolves.toBeNull();

    expect(runner.startCalls).toHaveLength(0);
    expect(events).toEqual([
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-future",
          stop_reason: "stopped",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
  });

  it("wrong streamId abortはactive runへ影響せず、completed IDのreceiptを再利用する", async () => {
    const { manager, runner, events } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-a",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));

    await expect(
      manager.handlers.abort_cli_chat_stream({ streamId: "stream-wrong" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    expect(runner.nextRunning.terminate).not.toHaveBeenCalled();
    runner.nextRunning.stdout.write(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n',
    );
    runner.nextRunning.finish();
    await send;

    expect(events).toEqual([
      {
        channel: "cli:stream-chunk",
        payload: { streamId: "stream-a", delta: "A", block_type: "text" },
      },
      {
        channel: "cli:stream-done",
        payload: {
          streamId: "stream-a",
          stop_reason: "end_turn",
          input_tokens: null,
          output_tokens: null,
        },
      },
    ]);
    await expect(
      manager.handlers.abort_cli_chat_stream({ streamId: "stream-a" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: true,
    });
  });

  it("timeout fallbackだけのabort receiptはtransportTerminationObserved=false", async () => {
    const { manager, runner } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-timeout",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));

    await expect(
      manager.handlers.abort_cli_chat_stream({ streamId: "stream-timeout" }),
    ).resolves.toEqual({
      abortCommandAcknowledged: true,
      transportTerminationObserved: false,
    });
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM");
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGKILL");

    runner.nextRunning.finish(null, "SIGKILL");
    await send;
  });

  it("spawn/非zero/巨大lineはerror eventとinvoke rejectの両方にする", async () => {
    const spawnHarness = createHarness();
    spawnHarness.runner.startError = new Error("ENOENT");
    await expect(
      spawnHarness.manager.handlers.send_cli_chat_stream({
        streamId: "stream-test",
        payload: { cli: "claude", prompt: "hello" },
      }),
    ).rejects.toThrow("Failed to spawn CLI");
    expect(spawnHarness.events).toEqual([
      {
        channel: "cli:stream-error",
        payload: {
          streamId: "stream-test",
          message: expect.stringContaining("Failed to spawn CLI"),
        },
      },
    ]);

    const exitHarness = createHarness();
    const failed = exitHarness.manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
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
      streamId: "stream-test",
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
        detectBinary: async (kind) => `/usr/local/bin/${kind}`,
        hashFile: stableHashFile,
        authorizeExecutable: async () => true,
        maxStreamBytes: 64,
        maxStreamLines: 100,
        forceKillAfterMs: 20,
      },
    );
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
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
      detectBinary: async (kind) => `/usr/local/bin/${kind}`,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      maxStreamBytes: 1024,
      maxStreamLines: 2,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
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
      detectBinary: async (kind) => `/usr/local/bin/${kind}`,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      streamTimeoutMs: 20,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() =>
      expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM"),
    );
    runner.nextRunning.finish(null, "SIGTERM");

    await expect(send).rejects.toThrow("CLI stream timed out after 20ms");
  });

  it("main側deadlineはpath解決時間も含み、期限後にchildを起動しない", async () => {
    const runner = new FakeRunner();
    let resolveRealPath!: (candidate: string) => void;
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async () =>
        new Promise<string>((resolve) => {
          resolveRealPath = resolve;
        }),
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      streamTimeoutMs: 20,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: {
        cli: "claude",
        binaryPath: "/usr/local/bin/claude",
        prompt: "hello",
      },
    });
    const expectation = expect(send).rejects.toThrow(
      "CLI stream timed out after 20ms",
    );
    await vi.waitFor(() => expect(resolveRealPath).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    resolveRealPath("/usr/local/bin/claude");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.startCalls).toHaveLength(0);
    await expectation;
  });

  it("disposeAllはactive childを停止する", async () => {
    const { manager, runner } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
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

  it("disposeAll後はcapture系handlerもfail-closedにする", async () => {
    const { manager, runner } = createHarness();
    manager.disposeAll();

    await expect(
      manager.handlers.test_cli_connection({
        binaryPath: "/usr/local/bin/claude",
      }),
    ).rejects.toThrow("CLI manager is disposed");
    expect(runner.runCalls).toHaveLength(0);
  });

  it("profile egress quiescence cancels pending detection before spawn", async () => {
    const runner = new FakeRunner();
    let resolveDetection!: (value: string) => void;
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      detectBinary: async () =>
        new Promise<string>((resolve) => {
          resolveDetection = resolve;
        }),
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
    });
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(resolveDetection).toBeTypeOf("function"));

    const quiesce = manager.quiesceForProfileEgress();
    expect(runner.startCalls).toHaveLength(0);
    resolveDetection("/usr/local/bin/claude");

    await expect(send).rejects.toThrow("CLI manager is disposed");
    await quiesce;
    expect(runner.startCalls).toHaveLength(0);
  });

  it("profile egress quiescence awaits a direct detection handler", async () => {
    let resolveDetection!: (value: string) => void;
    const manager = createCliAiManager(() => {}, {
      runner: new FakeRunner(),
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      detectBinary: async () =>
        new Promise<string>((resolve) => {
          resolveDetection = resolve;
        }),
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
    });
    const detection = manager.handlers.detect_cli_binary({ cli: "claude" });
    await vi.waitFor(() => expect(resolveDetection).toBeTypeOf("function"));

    let quiesced = false;
    const quiesce = manager.quiesceForProfileEgress().then(() => {
      quiesced = true;
    });
    expect(quiesced).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(quiesced).toBe(false);
    resolveDetection("/usr/local/bin/claude");

    await expect(detection).rejects.toThrow("CLI manager is disposed");
    await quiesce;
    expect(quiesced).toBe(true);
  });

  it("profile egress quiescence awaits active CLI transport termination", async () => {
    const { manager, runner } = createHarness();
    const send = manager.handlers.send_cli_chat_stream({
      streamId: "stream-test",
      payload: { cli: "claude", prompt: "hello" },
    });
    await vi.waitFor(() => expect(runner.startCalls).toHaveLength(1));

    let quiesced = false;
    const quiesce = manager.quiesceForProfileEgress().then(() => {
      quiesced = true;
    });
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGTERM");
    expect(runner.nextRunning.terminate).toHaveBeenCalledWith("SIGKILL");
    await Promise.resolve();
    expect(quiesced).toBe(false);

    runner.nextRunning.finish(null, "SIGTERM");
    await expect(send).resolves.toBeNull();
    await quiesce;
    expect(quiesced).toBe(true);
  });

  it("profile egress quiescence awaits an in-flight capture command", async () => {
    let resolveRun!: (result: CliProcessResult) => void;
    const run = vi.fn(
      () =>
        new Promise<CliProcessResult>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const disposeAll = vi.fn();
    const runner: CliProcessRunner = {
      run,
      start: () => {
        throw new Error("unexpected stream child");
      },
      disposeAll,
    };
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
    });
    const checking = manager.handlers.test_cli_connection({
      binaryPath: "/usr/local/bin/claude",
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    const quiesce = manager.quiesceForProfileEgress();
    expect(disposeAll).toHaveBeenCalledOnce();
    resolveRun({ exitCode: 0, signal: null, stdout: "claude 1.0", stderr: "" });

    await expect(checking).resolves.toBe("claude 1.0");
    await quiesce;
  });

  it.each([
    ["4MiB output overflow", "CLI command output exceeds limit"],
    ["capture timeout", "CLI command timed out after 10000ms"],
  ])(
    "profile egress waits for the child close after an early %s capture rejection",
    async (_label, rejectionMessage) => {
      let resolveChildClose!: () => void;
      const childClosed = new Promise<void>((resolve) => {
        resolveChildClose = resolve;
      });
      const runner: CliProcessRunner = {
        run: vi.fn(async () => {
          throw new Error(rejectionMessage);
        }),
        start: () => {
          throw new Error("unexpected stream child");
        },
        disposeAll: vi.fn(),
        quiesceForProfileEgress: vi.fn(() => childClosed),
      };
      const manager = createCliAiManager(() => {}, {
        runner,
        platform: "linux",
        isFile: async () => true,
        realPath: async (candidate) => candidate,
        hashFile: stableHashFile,
        authorizeExecutable: async () => true,
        forceKillAfterMs: 20,
      });

      const capture = manager.handlers.test_cli_connection({
        binaryPath: "/usr/local/bin/claude",
      });
      await expect(capture).rejects.toThrow(rejectionMessage);

      let quiesced = false;
      const quiesce = manager.quiesceForProfileEgress().then(() => {
        quiesced = true;
      });
      await Promise.resolve();
      expect(quiesced).toBe(false);
      expect(runner.quiesceForProfileEgress).toHaveBeenCalledOnce();

      resolveChildClose();
      await quiesce;
      expect(quiesced).toBe(true);
    },
  );

  it("fails profile egress closed when a captured child close is unconfirmed", async () => {
    const runner: CliProcessRunner = {
      run: vi.fn(async () => {
        throw new Error("CLI command output exceeds limit");
      }),
      start: () => {
        throw new Error("unexpected stream child");
      },
      disposeAll: vi.fn(),
      quiesceForProfileEgress: vi.fn(async () => {
        throw new Error("child close was not observed");
      }),
    };
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
    });
    const capture = manager.handlers.test_cli_connection({
      binaryPath: "/usr/local/bin/claude",
    });
    await expect(capture).rejects.toThrow("CLI command output exceeds limit");

    await expect(manager.quiesceForProfileEgress()).rejects.toThrow(
      "CLI egress transport did not quiesce",
    );
  });

  it("times out profile egress when a captured child never reports close", async () => {
    const childNeverCloses = new Promise<void>(() => {});
    const runner: CliProcessRunner = {
      run: vi.fn(async () => {
        throw new Error("CLI command timed out after 10000ms");
      }),
      start: () => {
        throw new Error("unexpected stream child");
      },
      disposeAll: vi.fn(),
      quiesceForProfileEgress: vi.fn(() => childNeverCloses),
    };
    const manager = createCliAiManager(() => {}, {
      runner,
      platform: "linux",
      isFile: async () => true,
      realPath: async (candidate) => candidate,
      hashFile: stableHashFile,
      authorizeExecutable: async () => true,
      forceKillAfterMs: 20,
    });
    const capture = manager.handlers.test_cli_connection({
      binaryPath: "/usr/local/bin/claude",
    });
    await expect(capture).rejects.toThrow("CLI command timed out after 10000ms");

    await expect(manager.quiesceForProfileEgress()).rejects.toThrow(
      "CLI egress transport did not quiesce",
    );
  });
});

describe("createNodeCliProcessRunner", () => {
  it("passes prompt input through stdin instead of argv", async () => {
    const runner = createNodeCliProcessRunner(process.platform);
    const result = await runner.run(
      {
        executable: process.execPath,
        kind: "claude",
        args: [
          "-e",
          "let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(s));",
        ],
        input: 'secret prompt "not in argv"',
      },
      { timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('secret prompt "not in argv"');
    runner.disposeAll?.();
  });

  it("does not inherit unrelated environment secrets", async () => {
    vi.stubEnv("GRIMODEX_UNRELATED_SECRET", "must-not-leak");
    try {
      const runner = createNodeCliProcessRunner(process.platform);
      const result = await runner.run(
        {
          executable: process.execPath,
          kind: "claude",
          args: [
            "-e",
            "process.stdout.write(process.env.GRIMODEX_UNRELATED_SECRET || 'absent')",
          ],
        },
        { timeoutMs: 5_000, maxOutputBytes: 1024 },
      );
      expect(result.stdout).toBe("absent");
      runner.disposeAll?.();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes only environment keys referenced by OpenCode config", async () => {
    vi.stubEnv(
      "OPENCODE_CONFIG_CONTENT",
      JSON.stringify({
        provider: {
          custom: {
            options: { apiKey: "{env:CUSTOM_LLM_TOKEN}" },
          },
        },
      }),
    );
    vi.stubEnv("CUSTOM_LLM_TOKEN", "allowed-token");
    vi.stubEnv("UNRELATED_PAYMENT_TOKEN", "must-not-leak");
    try {
      const runner = createNodeCliProcessRunner(process.platform);
      const result = await runner.run(
        {
          executable: process.execPath,
          kind: "opencode",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({ allowed: process.env.CUSTOM_LLM_TOKEN, unrelated: process.env.UNRELATED_PAYMENT_TOKEN }))",
          ],
        },
        { timeoutMs: 5_000, maxOutputBytes: 1024 },
      );
      expect(JSON.parse(result.stdout)).toEqual({ allowed: "allowed-token" });
      runner.disposeAll?.();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes environment keys referenced by an OpenCode config file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "grimodex-opencode-env-"));
    const configPath = path.join(dir, "opencode.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          custom: {
            options: { apiKey: "{env:FILE_LLM_TOKEN}" },
          },
        },
      }),
    );
    vi.stubEnv("OPENCODE_CONFIG", configPath);
    vi.stubEnv("FILE_LLM_TOKEN", "file-token");
    try {
      const runner = createNodeCliProcessRunner(process.platform);
      const result = await runner.run(
        {
          executable: process.execPath,
          kind: "opencode",
          args: [
            "-e",
            "process.stdout.write(process.env.FILE_LLM_TOKEN || 'absent')",
          ],
        },
        { timeoutMs: 5_000, maxOutputBytes: 1024 },
      );
      expect(result.stdout).toBe("file-token");
      runner.disposeAll?.();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spec.cwdをshellを介さずchildの作業ディレクトリへ渡す", async () => {
    const runner = createNodeCliProcessRunner(process.platform);
    const cwd = process.cwd();
    const result = await runner.run(
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.cwd())"],
        cwd,
      },
      { timeoutMs: 5_000, maxOutputBytes: 1024 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(cwd);
    runner.disposeAll?.();
  });

  it("disposeAllは実childを即時回収する", async () => {
    const runner = createNodeCliProcessRunner(process.platform);
    const running = runner.start({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (!runner.disposeAll) {
      running.terminate("SIGKILL");
      await running.completion;
      throw new Error("CliProcessRunner.disposeAll is missing");
    }
    runner.disposeAll();
    const result = await running.completion;
    expect(result.exitCode !== 0 || result.signal !== null).toBe(true);
  }, 10_000);

  it("profile egress quiescence waits for an actual child close", async () => {
    const runner = createNodeCliProcessRunner(process.platform);
    const running = runner.start({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 250)"],
    });
    await running.started;

    let quiesced = false;
    const quiesce = runner.quiesceForProfileEgress?.().then(() => {
      quiesced = true;
    });
    expect(quiesce).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quiesced).toBe(false);

    await running.completion;
    await quiesce;
    expect(quiesced).toBe(true);
    runner.disposeAll?.();
  }, 10_000);

  it("disposeAll後のrun/startは新しいchildを起動しない", async () => {
    const runner = createNodeCliProcessRunner(process.platform);
    const spec: CliCommandSpec = {
      executable: process.execPath,
      args: ["-e", ""],
    };
    runner.disposeAll?.();

    let started: RunningCliProcess | null = null;
    let startError: unknown;
    try {
      started = runner.start(spec);
    } catch (cause) {
      startError = cause;
    }
    if (started) await started.completion;
    expect(startError).toEqual(
      expect.objectContaining({ message: "CLI process runner is disposed" }),
    );
    await expect(
      runner.run(spec, { timeoutMs: 1_000, maxOutputBytes: 1024 }),
    ).rejects.toThrow("CLI process runner is disposed");
  });
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
