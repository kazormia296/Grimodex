import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CliCommandSpec,
  CliProcessResult,
  CliProcessRunner,
  RunningCliProcess,
} from "./cliAi.js";
import {
  createVivliostyleManager,
  type VivliostyleManager,
  type VivliostyleSaveDialogOptions,
} from "./vivliostyle.js";

class FakeRunningProcess implements RunningCliProcess {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly started?: Promise<void>;
  readonly terminate = vi.fn<(signal: "SIGTERM" | "SIGKILL") => void>();
  readonly completion: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private resolveCompletion!: (result: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  private rejectCompletion!: (cause: unknown) => void;

  constructor(started?: Promise<void>) {
    this.started = started;
    this.completion = new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  finish(
    exitCode: number | null = 0,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.stdout.end();
    this.stderr.end();
    this.resolveCompletion({ exitCode, signal });
  }

  fail(cause: unknown): void {
    this.stdout.destroy();
    this.stderr.destroy();
    this.rejectCompletion(cause);
  }
}

class FakeRunner implements CliProcessRunner {
  readonly runCalls: Array<{
    spec: CliCommandSpec;
    options: { timeoutMs: number; maxOutputBytes: number };
  }> = [];
  readonly startCalls: CliCommandSpec[] = [];
  readonly started: FakeRunningProcess[] = [];
  readonly queued: FakeRunningProcess[] = [];
  readonly disposeAll = vi.fn<() => void>();
  runResult: CliProcessResult = {
    exitCode: 0,
    signal: null,
    stdout: "vivliostyle 9.1.0\n",
    stderr: "",
  };
  runError: Error | null = null;
  startError: Error | null = null;

  enqueue(process = new FakeRunningProcess()): FakeRunningProcess {
    this.queued.push(process);
    return process;
  }

  async run(
    spec: CliCommandSpec,
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CliProcessResult> {
    this.runCalls.push({ spec, options });
    if (this.runError) throw this.runError;
    return this.runResult;
  }

  start(spec: CliCommandSpec): RunningCliProcess {
    this.startCalls.push(spec);
    if (this.startError) throw this.startError;
    const process = this.queued.shift() ?? new FakeRunningProcess();
    this.started.push(process);
    return process;
  }
}

interface EventRecord {
  channel: string;
  payload: unknown;
}

interface Harness {
  baseDir: string;
  tempRoot: string;
  events: EventRecord[];
  runner: FakeRunner;
  manager: VivliostyleManager;
  detectBinary: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  authorizeExecutable: ReturnType<
    typeof vi.fn<(executable: string) => Promise<boolean>>
  >;
  pickSavePath: ReturnType<
    typeof vi.fn<
      (options: VivliostyleSaveDialogOptions) => Promise<string | null>
    >
  >;
}

const created: string[] = [];

function createHarness(
  overrides: {
    detectBinary?: () => Promise<string | null>;
    isFile?: (candidate: string) => Promise<boolean>;
    maxInputBytes?: number;
    authorize?: boolean;
  } = {},
): Harness {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "gmx-viv-test-"));
  created.push(baseDir);
  const tempRoot = path.join(baseDir, "runtime");
  const events: EventRecord[] = [];
  const runner = new FakeRunner();
  const detectBinary = vi.fn(
    overrides.detectBinary ?? (async () => "/usr/local/bin/vivliostyle"),
  );
  const authorizeExecutable = vi.fn(async () => overrides.authorize ?? true);
  const pickSavePath = vi.fn(async () => null as string | null);
  let nextId = 0;
  const manager = createVivliostyleManager(
    (channel, payload) => events.push({ channel, payload }),
    {
      runner,
      platform: "linux",
      tempRoot,
      detectBinary,
      isFile:
        overrides.isFile ??
        (async (candidate) =>
          path.basename(candidate) === "vivliostyle" || existsSync(candidate)),
      realPath: async (candidate) => candidate,
      authorizeExecutable,
      pickSavePath,
      randomId: () => `id-${++nextId}`,
      forceKillAfterMs: 20,
      maxInputBytes: overrides.maxInputBytes,
    },
  );
  return {
    baseDir,
    tempRoot,
    events,
    runner,
    manager,
    detectBinary,
    authorizeExecutable,
    pickSavePath,
  };
}

const files = [
  { name: "book.html", contents: "<!doctype html><main>本文</main>" },
  { name: "theme.css", contents: "main { writing-mode: vertical-rl; }" },
];

function buildArgs(format: "pdf" | "epub" = "pdf") {
  return { files, format, binaryPath: null };
}

async function waitForStarts(runner: FakeRunner, count: number): Promise<void> {
  await vi.waitFor(() => expect(runner.startCalls).toHaveLength(count));
}

function outputPath(spec: CliCommandSpec, format: "pdf" | "epub" = "pdf") {
  if (!spec.cwd) throw new Error("test process cwd was not set");
  return path.join(spec.cwd, `output.${format}`);
}

afterEach(() => {
  vi.useRealTimers();
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("VivliostyleManager detect / validation", () => {
  it("detectは固定バイナリを--versionで確認し、失敗時はnullへ縮退する", async () => {
    const h = createHarness();
    await expect(h.manager.handlers.vivliostyle_detect({})).resolves.toEqual({
      path: "/usr/local/bin/vivliostyle",
      version: "vivliostyle 9.1.0",
    });
    expect(h.runner.runCalls[0]?.spec).toMatchObject({
      executable: "/usr/local/bin/vivliostyle",
      args: ["--version"],
    });

    h.runner.runError = new Error("not executable");
    await expect(h.manager.handlers.vivliostyle_detect({})).resolves.toBeNull();
  });

  it("panel detectとpreviewの同時PATH probeをsingle-flightへ畳む", async () => {
    let resolveDetection!: (candidate: string | null) => void;
    const h = createHarness({
      detectBinary: () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        }),
    });
    const process = h.runner.enqueue();
    const detection = h.manager.handlers.vivliostyle_detect({});
    await vi.waitFor(() => expect(h.detectBinary).toHaveBeenCalledOnce());
    const preview = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    resolveDetection("/usr/local/bin/vivliostyle");

    await expect(detection).resolves.toEqual({
      path: "/usr/local/bin/vivliostyle",
      version: "vivliostyle 9.1.0",
    });
    await expect(preview).resolves.toBeNull();
    expect(h.detectBinary).toHaveBeenCalledOnce();
    const stop = h.manager.handlers.vivliostyle_preview_stop({});
    await vi.waitFor(() =>
      expect(process.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    process.finish(null, "SIGKILL");
    await stop;
  });

  it("files/formatを厳格検証し、traversal・重複・上限超過をspawn前に拒否する", async () => {
    const h = createHarness({ maxInputBytes: 32 });
    await expect(
      h.manager.handlers.vivliostyle_build({
        files: [{ name: "../book.html", contents: "x" }],
        format: "pdf",
      }),
    ).rejects.toThrow(/許可されていないファイル名/);
    await expect(
      h.manager.handlers.vivliostyle_build({
        files: [
          { name: "book.html", contents: "x" },
          { name: "book.html", contents: "y" },
        ],
        format: "pdf",
      }),
    ).rejects.toThrow(/重複/);
    await expect(
      h.manager.handlers.vivliostyle_build({
        files: [{ name: "theme.css", contents: "x" }],
        format: "pdf",
      }),
    ).rejects.toThrow(/book\.html/);
    await expect(
      h.manager.handlers.vivliostyle_build({
        files: [{ name: "book.html", contents: "x".repeat(33) }],
        format: "pdf",
      }),
    ).rejects.toThrow(/上限/);
    await expect(
      h.manager.handlers.vivliostyle_build({ files, format: "html" }),
    ).rejects.toThrow(/未対応の出力形式/);
    expect(h.runner.startCalls).toHaveLength(0);
  });

  it("手入力の実行ファイルはvivliostyle名・絶対path・native許可を要求する", async () => {
    const h = createHarness({ authorize: false });
    await expect(
      h.manager.handlers.vivliostyle_preview_start({
        files,
        binaryPath: "/usr/bin/node",
      }),
    ).rejects.toThrow(/Vivliostyle executable/);
    await expect(
      h.manager.handlers.vivliostyle_preview_start({
        files,
        binaryPath: "relative/vivliostyle",
      }),
    ).rejects.toThrow(/absolute/);
    await expect(
      h.manager.handlers.vivliostyle_preview_start({
        files,
        binaryPath: "/opt/custom/vivliostyle",
      }),
    ).rejects.toThrow(/not authorized/);
    expect(h.authorizeExecutable).toHaveBeenCalledWith(
      "/opt/custom/vivliostyle",
    );
    expect(h.runner.startCalls).toHaveLength(0);
  });
});

describe("VivliostyleManager build / output token", () => {
  it("buildはrunIdを先に返し、stdout/stderrログとdoneを全窓イベントへ写像する", async () => {
    const h = createHarness();
    const process = h.runner.enqueue();
    const runId = await h.manager.handlers.vivliostyle_build(buildArgs());
    expect(runId).toBe("id-1");
    await waitForStarts(h.runner, 1);
    const spec = h.runner.startCalls[0];
    expect(spec).toMatchObject({
      executable: "/usr/local/bin/vivliostyle",
      args: ["build", "book.html", "-f", "pdf", "-o", "output.pdf"],
    });
    expect(spec?.cwd).toMatch(/grimodex-vivliostyle|runtime/u);

    process.stdout.write("layout page 1\n");
    process.stderr.write("rendering fonts\n");
    writeFileSync(outputPath(spec), "PDF");
    process.finish();

    await vi.waitFor(() =>
      expect(
        h.events.some((event) => event.channel === "vivliostyle:done"),
      ).toBe(true),
    );
    expect(h.events).toContainEqual({
      channel: "vivliostyle:log",
      payload: { runId: "id-1", line: "layout page 1" },
    });
    expect(h.events).toContainEqual({
      channel: "vivliostyle:log",
      payload: { runId: "id-1", line: "rendering fonts" },
    });
    expect(h.events).toContainEqual({
      channel: "vivliostyle:done",
      payload: { runId: "id-1", outputToken: "id-2" },
    });
    expect(existsSync(spec?.cwd ?? "")).toBe(true);
  });

  it("バイナリ解決中でもrunIdを即返し、abortはspawn前にも取りこぼさない", async () => {
    let resolveDetection!: (path: string | null) => void;
    const h = createHarness({
      detectBinary: () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        }),
    });
    const runId = await h.manager.handlers.vivliostyle_build(buildArgs());
    expect(runId).toBe("id-1");
    await h.manager.handlers.vivliostyle_abort_build({ runId });
    resolveDetection("/usr/local/bin/vivliostyle");

    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:error",
        payload: { runId: "id-1", message: "ビルドを中断しました" },
      }),
    );
    expect(h.runner.startCalls).toHaveLength(0);
  });

  it("active build abortはTERMからKILLへ昇格し、doneではなくerrorで終端する", async () => {
    vi.useFakeTimers();
    const h = createHarness();
    const process = h.runner.enqueue();
    const runId = await h.manager.handlers.vivliostyle_build(buildArgs());
    await vi.waitFor(() => expect(h.runner.startCalls).toHaveLength(1));

    await h.manager.handlers.vivliostyle_abort_build({ runId });
    expect(process.terminate).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(21);
    expect(process.terminate).toHaveBeenCalledWith("SIGKILL");
    process.finish(null, "SIGTERM");
    await vi.runAllTimersAsync();

    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:error",
        payload: { runId, message: "ビルドを中断しました" },
      }),
    );
    expect(h.events.some((event) => event.channel === "vivliostyle:done")).toBe(
      false,
    );
  });

  it("成果物確認のawait中にabortしてもdone/tokenをcommitしない", async () => {
    let deferOutputCheck = false;
    let resolveOutputCheck!: (exists: boolean) => void;
    const h = createHarness({
      isFile: async (candidate) => {
        if (path.basename(candidate) === "vivliostyle") return true;
        if (deferOutputCheck && candidate.endsWith("output.pdf")) {
          return new Promise((resolve) => {
            resolveOutputCheck = resolve;
          });
        }
        return existsSync(candidate);
      },
    });
    const process = h.runner.enqueue();
    const runId = await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    const spec = h.runner.startCalls[0];
    writeFileSync(outputPath(spec), "PDF");
    deferOutputCheck = true;
    process.finish();
    await vi.waitFor(() => expect(resolveOutputCheck).toBeTypeOf("function"));

    await expect(
      h.manager.handlers.vivliostyle_abort_build({ runId }),
    ).resolves.toBeNull();
    resolveOutputCheck(true);
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:error",
        payload: { runId, message: "ビルドを中断しました" },
      }),
    );
    expect(h.events.some((event) => event.channel === "vivliostyle:done")).toBe(
      false,
    );
    expect(existsSync(spec?.cwd ?? "")).toBe(false);
  });

  it("saveはopaque tokenだけを受け、cancel時は再試行可・成功時だけ消費する", async () => {
    const h = createHarness();
    const process = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    const spec = h.runner.startCalls[0];
    writeFileSync(outputPath(spec), "PDF-BYTES");
    process.finish();
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:done",
        payload: { runId: "id-1", outputToken: "id-2" },
      }),
    );

    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).resolves.toBeNull();
    const destination = path.join(h.baseDir, "saved.pdf");
    h.pickSavePath.mockResolvedValueOnce(destination);
    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).resolves.toBe(destination);
    expect(readFileSync(destination, "utf8")).toBe("PDF-BYTES");
    expect(h.pickSavePath).toHaveBeenLastCalledWith({
      suggestedName: "book.pdf",
      filterName: "PDF",
      extensions: ["pdf"],
    });
    expect(existsSync(spec?.cwd ?? "")).toBe(false);
    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).rejects.toThrow(/成果物が見つかりません/);
  });

  it("異常終了・成果物欠落・spawn失敗はいずれもerror終端してtempを掃除する", async () => {
    const h = createHarness();
    const failed = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    const failedDir = h.runner.startCalls[0]?.cwd;
    failed.finish(2, null);
    await vi.waitFor(() =>
      expect(
        h.events.some((event) => event.channel === "vivliostyle:error"),
      ).toBe(true),
    );
    expect(existsSync(failedDir ?? "")).toBe(false);

    const missing = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 2);
    const missingDir = h.runner.startCalls[1]?.cwd;
    missing.finish(0, null);
    await vi.waitFor(() =>
      expect(
        h.events.filter((event) => event.channel === "vivliostyle:error"),
      ).toHaveLength(2),
    );
    expect(h.events.at(-1)?.payload).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("生成されませんでした"),
      }),
    );
    expect(existsSync(missingDir ?? "")).toBe(false);

    h.runner.startError = new Error("spawn boom");
    await h.manager.handlers.vivliostyle_build(buildArgs("epub"));
    await vi.waitFor(() =>
      expect(
        h.events.filter((event) => event.channel === "vivliostyle:error"),
      ).toHaveLength(3),
    );
    expect(h.events.at(-1)?.payload).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("spawn boom"),
      }),
    );
  });

  it("保存dialog中のtokenを二重消費させず、次build開始後はlease解放時に失効する", async () => {
    const h = createHarness();
    const completed = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    const firstSpec = h.runner.startCalls[0];
    writeFileSync(outputPath(firstSpec), "PDF");
    completed.finish();
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:done",
        payload: { runId: "id-1", outputToken: "id-2" },
      }),
    );

    let resolveDialog!: (picked: string | null) => void;
    h.pickSavePath.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDialog = resolve;
        }),
    );
    const saving = h.manager.handlers.vivliostyle_save_output({
      outputToken: "id-2",
    });
    await vi.waitFor(() => expect(h.pickSavePath).toHaveBeenCalledOnce());
    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).rejects.toThrow(/保存処理中/);

    const nextProcess = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 2);
    // save lease中のsourceは新build開始でもcopy/cancel完了まで保持する。
    expect(existsSync(outputPath(firstSpec))).toBe(true);
    resolveDialog(null);
    await expect(saving).resolves.toBeNull();
    expect(existsSync(firstSpec?.cwd ?? "")).toBe(false);
    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).rejects.toThrow(/成果物が見つかりません/);

    h.manager.disposeAll();
    nextProcess.finish(null, "SIGKILL");
  });

  it("成果物確認のawait中にもtoken leaseを同期獲得して二重保存を拒否する", async () => {
    let deferArtifactCheck = false;
    let resolveArtifactCheck!: (exists: boolean) => void;
    const h = createHarness({
      isFile: async (candidate) => {
        if (path.basename(candidate) === "vivliostyle") return true;
        if (deferArtifactCheck && candidate.endsWith("output.pdf")) {
          return new Promise((resolve) => {
            resolveArtifactCheck = resolve;
          });
        }
        return existsSync(candidate);
      },
    });
    const completed = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    const spec = h.runner.startCalls[0];
    writeFileSync(outputPath(spec), "PDF");
    completed.finish();
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        channel: "vivliostyle:done",
        payload: { runId: "id-1", outputToken: "id-2" },
      }),
    );

    deferArtifactCheck = true;
    const first = h.manager.handlers.vivliostyle_save_output({
      outputToken: "id-2",
    });
    await vi.waitFor(() => expect(resolveArtifactCheck).toBeTypeOf("function"));
    await expect(
      h.manager.handlers.vivliostyle_save_output({ outputToken: "id-2" }),
    ).rejects.toThrow(/保存処理中/);
    resolveArtifactCheck(true);
    await expect(first).resolves.toBeNull();
  });
});

describe("VivliostyleManager preview / lifecycle", () => {
  it("previewはsingletonで旧世代をKILLし、現役の自然終了だけexitedをemitする", async () => {
    const h = createHarness();
    const first = h.runner.enqueue();
    const second = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    expect(h.runner.startCalls[0]).toMatchObject({
      args: ["preview", "book.html"],
    });
    const replacement = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    await vi.waitFor(() =>
      expect(first.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    first.finish(null, "SIGKILL");
    await replacement;
    expect(first.terminate).toHaveBeenCalledWith("SIGKILL");

    await Promise.resolve();
    expect(
      h.events.filter(
        (event) => event.channel === "vivliostyle:preview-exited",
      ),
    ).toHaveLength(0);
    second.finish(0, null);
    await vi.waitFor(() =>
      expect(
        h.events.filter(
          (event) => event.channel === "vivliostyle:preview-exited",
        ),
      ).toEqual([{ channel: "vivliostyle:preview-exited", payload: {} }]),
    );
  });

  it("明示stopは冪等でexitedを出さず、解決待ちstartもstop epochで無効化する", async () => {
    let resolveDetection!: (path: string | null) => void;
    const h = createHarness({
      detectBinary: () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        }),
    });
    const start = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    await h.manager.handlers.vivliostyle_preview_stop({});
    await h.manager.handlers.vivliostyle_preview_stop({});
    resolveDetection("/usr/local/bin/vivliostyle");
    await start;

    expect(h.runner.startCalls).toHaveLength(0);
    expect(h.events).toContainEqual({
      channel: "vivliostyle:preview-exited",
      payload: {},
    });
  });

  it("旧start→stop→新startでは旧世代の遅延exitedを現役世代へ送らない", async () => {
    let resolveDetection!: (path: string | null) => void;
    const h = createHarness({
      detectBinary: () =>
        new Promise((resolve) => {
          resolveDetection = resolve;
        }),
    });
    const currentProcess = h.runner.enqueue();
    const staleStart = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    await vi.waitFor(() => expect(h.detectBinary).toHaveBeenCalledOnce());
    await h.manager.handlers.vivliostyle_preview_stop({});
    const currentStart = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    resolveDetection("/usr/local/bin/vivliostyle");
    await Promise.all([staleStart, currentStart]);

    expect(h.runner.startCalls).toHaveLength(1);
    expect(
      h.events.some((event) => event.channel === "vivliostyle:preview-exited"),
    ).toBe(false);
    const stop = h.manager.handlers.vivliostyle_preview_stop({});
    await vi.waitFor(() =>
      expect(currentProcess.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    currentProcess.finish(null, "SIGKILL");
    await stop;
  });

  it("active previewの明示stopはKILLしても自然終了イベントを出さない", async () => {
    const h = createHarness();
    const process = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    const previewDir = h.runner.startCalls[0]?.cwd;
    const stop = h.manager.handlers.vivliostyle_preview_stop({});
    await vi.waitFor(() =>
      expect(process.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    process.finish(null, "SIGKILL");
    await stop;
    expect(existsSync(previewDir ?? "")).toBe(false);
    await Promise.resolve();
    expect(
      h.events.some((event) => event.channel === "vivliostyle:preview-exited"),
    ).toBe(false);
  });

  it("非同期spawn失敗はpreview_startをrejectしてtempを掃除する", async () => {
    let rejectStarted!: (cause: unknown) => void;
    const started = new Promise<void>((_resolve, reject) => {
      rejectStarted = reject;
    });
    const h = createHarness();
    const process = h.runner.enqueue(new FakeRunningProcess(started));
    const start = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    await waitForStarts(h.runner, 1);
    const previewDir = h.runner.startCalls[0]?.cwd;
    rejectStarted(new Error("spawn EACCES"));
    process.fail(new Error("spawn EACCES"));

    await expect(start).rejects.toThrow(/spawn EACCES/);
    expect(process.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(existsSync(previewDir ?? "")).toBe(false);
    expect(
      h.events.some((event) => event.channel === "vivliostyle:preview-exited"),
    ).toBe(false);
  });

  it("spawn成功待ちのstartをstopした場合は遅延childを登録せず回収する", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const h = createHarness();
    const process = h.runner.enqueue(new FakeRunningProcess(started));
    const start = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    const startExpectation = expect(start).resolves.toBeNull();
    await waitForStarts(h.runner, 1);
    const stop = h.manager.handlers.vivliostyle_preview_stop({});
    // stop handlerのready()後 continuation（epoch/generation更新）を先に流す。
    await Promise.resolve();

    resolveStarted();
    await vi.waitFor(() =>
      expect(process.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    process.finish(null, "SIGKILL");
    await startExpectation;
    await stop;
    expect(h.events).toContainEqual({
      channel: "vivliostyle:preview-exited",
      payload: {},
    });
  });

  it("spawn待ちの旧startは新startを上書きせず自身だけを回収する", async () => {
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const h = createHarness();
    const first = h.runner.enqueue(new FakeRunningProcess(firstStarted));
    const second = h.runner.enqueue(new FakeRunningProcess(secondStarted));
    const oldStart = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    const oldExpectation = expect(oldStart).resolves.toBeNull();
    await waitForStarts(h.runner, 1);
    const newStart = h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    const newExpectation = expect(newStart).resolves.toBeNull();
    // 新startのgeneration更新とtransition queue投入を旧started解決より先にする。
    await Promise.resolve();

    resolveFirst();
    await vi.waitFor(() =>
      expect(first.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    first.finish(null, "SIGKILL");
    await oldExpectation;
    await waitForStarts(h.runner, 2);
    resolveSecond();
    await newExpectation;
    expect(second.terminate).not.toHaveBeenCalled();
    expect(
      h.events.some((event) => event.channel === "vivliostyle:preview-exited"),
    ).toBe(false);

    const stop = h.manager.handlers.vivliostyle_preview_stop({});
    await vi.waitFor(() =>
      expect(second.terminate).toHaveBeenCalledWith("SIGKILL"),
    );
    second.finish(null, "SIGKILL");
    await stop;
  });

  it("起動時に前セッションtempを掃除し、disposeAllは全child/outputを同期回収する", async () => {
    const h = createHarness();
    mkdirSync(h.tempRoot, { recursive: true });
    writeFileSync(path.join(h.tempRoot, "stale"), "x");
    await h.manager.handlers.vivliostyle_detect({});
    expect(existsSync(path.join(h.tempRoot, "stale"))).toBe(false);

    const build = h.runner.enqueue();
    const preview = h.runner.enqueue();
    await h.manager.handlers.vivliostyle_build(buildArgs());
    await waitForStarts(h.runner, 1);
    await h.manager.handlers.vivliostyle_preview_start({
      files,
      binaryPath: null,
    });
    const dirs = h.runner.startCalls.map((call) => call.cwd ?? "");
    h.manager.disposeAll();
    expect(build.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(preview.terminate).toHaveBeenCalledWith("SIGKILL");
    expect(h.runner.disposeAll).toHaveBeenCalledOnce();
    expect(dirs.every((dir) => !existsSync(dir))).toBe(true);
    await expect(h.manager.handlers.vivliostyle_detect({})).rejects.toThrow(
      /disposed/,
    );

    build.finish(null, "SIGKILL");
    preview.finish(null, "SIGKILL");
  });
});
