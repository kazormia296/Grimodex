/**
 * Vivliostyle CLI の Electron main 実装。
 *
 * renderer から受けるのは既存 Tauri command と同じ6コマンドだけとし、入力temp、
 * child process tree、成果物token、保存ダイアログをmainの単一managerへ閉じ込める。
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  copyFile,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import {
  createNodeCliProcessRunner,
  type CliCommandSpec,
  type CliProcessRunner,
  type RunningCliProcess,
} from "./cliAi.js";

const VIVLIOSTYLE_BINARY = "vivliostyle";
const INPUT_FILE_NAME = "book.html";
const ALLOWED_FILE_NAMES = new Set([INPUT_FILE_NAME, "theme.css"]);
const DEFAULT_MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_LINES = 10_000;
const MAX_PROCESS_LINE_BYTES = 1024 * 1024;
const MAX_EMITTED_LOG_BYTES = 8 * 1024 * 1024;
const DETECT_TIMEOUT_MS = 10_000;
const DETECT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_FORCE_KILL_AFTER_MS = 2_000;
const MAX_EXECUTABLE_PATH_LENGTH = 4_096;
const MAX_OPAQUE_ID_LENGTH = 256;

type Broadcast = (channel: string, payload: unknown) => void;
type VivliostyleFormat = "pdf" | "epub";

interface VivliostyleFile {
  name: string;
  contents: string;
}

interface ValidatedExecutable {
  requestedPath: string;
  executable: string;
}

interface BuildRun {
  runId: string;
  dir: string;
  format: VivliostyleFormat;
  outputName: string;
  binaryPath: string | null;
  aborted: boolean;
  process: RunningCliProcess | null;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
}

interface OutputArtifact {
  file: string;
  dir: string;
  format: VivliostyleFormat;
  saving: boolean;
  /** 新build開始中に保存dialogが開いていた場合、lease解放時に掃除する。 */
  expired: boolean;
}

interface PreviewProcess {
  generation: number;
  process: RunningCliProcess;
  dir: string;
}

export interface VivliostyleSaveDialogOptions {
  suggestedName: string;
  filterName: string;
  extensions: string[];
}

export interface VivliostyleManager {
  handlers: ShellCommandHandlers;
  /** Main-only D2a barrier: close starts and await all admitted work. */
  quiesceForProfileEgress(): Promise<void>;
  /** will-quit向け。同期的に全process treeとtempを回収する。 */
  disposeAll(): void;
}

interface VivliostyleDependencies {
  runner?: CliProcessRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  detectBinary?: () => Promise<string | null>;
  isFile?: (candidate: string) => Promise<boolean>;
  realPath?: (candidate: string) => Promise<string>;
  /** custom absolute pathをnative UIで許可する。未注入時はfail-closed。 */
  authorizeExecutable?: (executable: string) => Promise<boolean>;
  /** rendererへ保存先pathを渡さず、native dialog由来pathだけを返す。 */
  pickSavePath?: (
    options: VivliostyleSaveDialogOptions,
  ) => Promise<string | null>;
  randomId?: () => string;
  forceKillAfterMs?: number;
  maxInputBytes?: number;
}

interface OutputBudget {
  bytes: number;
  lines: number;
  emittedBytes: number;
}

class BuildAbortedError extends Error {
  constructor() {
    super("ビルドを中断しました");
    this.name = "BuildAbortedError";
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requireString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`invalid args \`${name}\`: expected a string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, name).trim();
}

function requireOpaqueId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > MAX_OPAQUE_ID_LENGTH) {
    throw new Error(`invalid args \`${name}\`: value is too long`);
  }
  return id;
}

function parseFormat(value: unknown): VivliostyleFormat {
  if (value !== "pdf" && value !== "epub") {
    throw new Error(`未対応の出力形式です: ${String(value)} (pdf | epub のみ)`);
  }
  return value;
}

function parseFiles(value: unknown, maxInputBytes: number): VivliostyleFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ビルド対象ファイルがありません");
  }
  if (value.length > ALLOWED_FILE_NAMES.size) {
    throw new Error("ビルド対象ファイルが多すぎます");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  const files = value.map((entry, index): VivliostyleFile => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid args \`files[${index}]\`: expected an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = requireString(record.name, `files[${index}].name`);
    const contents = requireString(
      record.contents,
      `files[${index}].contents`,
      true,
    );
    if (!ALLOWED_FILE_NAMES.has(name)) {
      throw new Error(
        `許可されていないファイル名です: ${name} (book.html / theme.css のみ)`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`ビルド対象ファイル名が重複しています: ${name}`);
    }
    seen.add(name);
    totalBytes += Buffer.byteLength(contents, "utf8");
    if (totalBytes > maxInputBytes) {
      throw new Error(`ビルド入力が上限 ${maxInputBytes} bytes を超えています`);
    }
    return { name, contents };
  });

  if (!seen.has(INPUT_FILE_NAME)) {
    throw new Error(`${INPUT_FILE_NAME} が含まれていません`);
  }
  return files;
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function allowedExecutableLeaves(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? [
        VIVLIOSTYLE_BINARY,
        `${VIVLIOSTYLE_BINARY}.exe`,
        `${VIVLIOSTYLE_BINARY}.cmd`,
        `${VIVLIOSTYLE_BINARY}.bat`,
      ]
    : [VIVLIOSTYLE_BINARY];
}

function isWindowsNetworkOrDevicePath(candidate: string): boolean {
  return candidate.replaceAll("/", "\\").startsWith("\\\\");
}

async function defaultIsFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function validateExecutable(
  raw: unknown,
  platform: NodeJS.Platform,
  isFile: (candidate: string) => Promise<boolean>,
  resolveRealPath: (candidate: string) => Promise<string>,
): Promise<ValidatedExecutable> {
  const requestedPath = requireString(raw, "binaryPath").trim();
  if (requestedPath.length > MAX_EXECUTABLE_PATH_LENGTH) {
    throw new Error("Vivliostyle executable path is too long");
  }
  if (requestedPath.includes("\0")) {
    throw new Error("Vivliostyle executable contains a NUL byte");
  }
  const api = pathApi(platform);
  const leaf = api.basename(requestedPath).toLowerCase();
  if (!allowedExecutableLeaves(platform).includes(leaf)) {
    throw new Error(
      "Vivliostyle executable must be named vivliostyle (including native Windows shims)",
    );
  }
  if (!api.isAbsolute(requestedPath)) {
    throw new Error("Vivliostyle executable path must be absolute");
  }
  if (platform === "win32" && isWindowsNetworkOrDevicePath(requestedPath)) {
    throw new Error(
      "Vivliostyle executable cannot be loaded from a network/device path",
    );
  }

  let executable: string;
  try {
    executable = await resolveRealPath(requestedPath);
  } catch (cause) {
    throw new Error(
      `Failed to resolve Vivliostyle executable: ${requestedPath}`,
      { cause },
    );
  }
  if (platform === "win32" && isWindowsNetworkOrDevicePath(executable)) {
    throw new Error(
      "Vivliostyle executable cannot resolve to a network/device path",
    );
  }
  if (!(await isFile(executable))) {
    throw new Error(
      `Vivliostyle executable is not a regular file: ${executable}`,
    );
  }
  return { requestedPath, executable };
}

function firstNonEmptyLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

async function defaultDetectBinary(
  runner: CliProcessRunner,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (candidate: string) => Promise<boolean>,
): Promise<string | null> {
  const probes: CliCommandSpec[] =
    platform === "win32"
      ? [{ executable: "where.exe", args: [VIVLIOSTYLE_BINARY] }]
      : [
          {
            executable: "bash",
            args: ["-lc", `command -v ${VIVLIOSTYLE_BINARY}`],
          },
          {
            executable: "zsh",
            args: ["-lc", `command -v ${VIVLIOSTYLE_BINARY}`],
          },
        ];

  for (const spec of probes) {
    try {
      const result = await runner.run(spec, {
        timeoutMs: DETECT_TIMEOUT_MS,
        maxOutputBytes: DETECT_MAX_OUTPUT_BYTES,
      });
      const found =
        result.exitCode === 0 ? firstNonEmptyLine(result.stdout) : null;
      if (found && (await isFile(found))) return found;
    } catch {
      // 検出はfail-soft。PATH直走査へ進む。
    }
  }

  const api = pathApi(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const leaves = allowedExecutableLeaves(platform);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const leaf of leaves) {
      const candidate = api.join(dir, leaf);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function writeInputDir(
  tempRoot: string,
  files: readonly VivliostyleFile[],
): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const dir = path.join(tempRoot, randomUUID());
  await mkdir(dir);
  try {
    for (const file of files) {
      await writeFile(path.join(dir, file.name), file.contents, "utf8");
    }
    return dir;
  } catch (cause) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Vivliostyle入力の書き出しに失敗しました: ${toError(cause).message}`,
      {
        cause,
      },
    );
  }
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

function cleanupDirSync(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 次回起動時のtemp root一括掃除が回収する。
  }
}

function consumeLines(
  stream: Readable,
  budget: OutputBudget,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let settled = false;

    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toError(cause));
    };
    const deliver = (raw: string): void => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      budget.lines += 1;
      if (budget.lines > MAX_PROCESS_OUTPUT_LINES) {
        throw new Error("Vivliostyle output exceeds line limit");
      }
      if (Buffer.byteLength(line, "utf8") > MAX_PROCESS_LINE_BYTES) {
        throw new Error("Vivliostyle output line exceeds limit");
      }
      if (line !== "") onLine(line);
    };
    const drain = (final: boolean): void => {
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        deliver(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_PROCESS_LINE_BYTES) {
        throw new Error("Vivliostyle output line exceeds limit");
      }
      if (final && pending !== "") {
        deliver(pending);
        pending = "";
      }
    };
    function onData(chunk: Buffer | string): void {
      try {
        budget.bytes += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk, "utf8");
        if (budget.bytes > MAX_PROCESS_OUTPUT_BYTES) {
          throw new Error("Vivliostyle output exceeds byte limit");
        }
        pending += Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk;
        drain(false);
      } catch (cause) {
        fail(cause);
      }
    }
    function onEnd(): void {
      if (settled) return;
      try {
        pending += decoder.end();
        drain(true);
        settled = true;
        cleanup();
        resolve();
      } catch (cause) {
        fail(cause);
      }
    }
    function onError(cause: unknown): void {
      fail(cause);
    }

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

/**
 * Tauri VivliostyleState相当を1個生成する。handlersはregisterIpcRouterの
 * extraShellHandlersへ注入し、manager自体はapp lifetimeで共有する。
 */
export function createVivliostyleManager(
  broadcast: Broadcast,
  supplied: VivliostyleDependencies = {},
): VivliostyleManager {
  const platform = supplied.platform ?? process.platform;
  const env = supplied.env ?? process.env;
  const runner = supplied.runner ?? createNodeCliProcessRunner(platform);
  const tempRoot =
    supplied.tempRoot ?? path.join(os.tmpdir(), "grimodex-vivliostyle");
  const isFile = supplied.isFile ?? defaultIsFile;
  const resolveRealPath = supplied.realPath ?? realpath;
  const detectBinary =
    supplied.detectBinary ??
    (() => defaultDetectBinary(runner, platform, env, isFile));
  const authorizeExecutable =
    supplied.authorizeExecutable ?? (async () => false);
  const pickSavePath =
    supplied.pickSavePath ??
    (async () => {
      throw new Error("Vivliostyle save dialog is unavailable");
    });
  const randomId = supplied.randomId ?? randomUUID;
  const forceKillAfterMs =
    supplied.forceKillAfterMs ?? DEFAULT_FORCE_KILL_AFTER_MS;
  const maxInputBytes = supplied.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;

  if (!path.isAbsolute(tempRoot)) {
    throw new Error("Vivliostyle tempRoot must be absolute");
  }
  for (const [name, value] of [
    ["forceKillAfterMs", forceKillAfterMs],
    ["maxInputBytes", maxInputBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  // 前セッションの未保存成果物を掃除する。全handlerがawaitするため、初回buildと
  // cleanupが競合して新しいdirを消すことはない。
  const initialCleanup = rm(tempRoot, { recursive: true, force: true }).catch(
    () => {},
  );
  const runs = new Map<string, BuildRun>();
  const outputs = new Map<string, OutputArtifact>();
  const trustedCustomExecutables = new Set<string>();
  let detectedExecutable: ValidatedExecutable | null = null;
  let detectionInFlight: Promise<ValidatedExecutable | null> | null = null;
  let preview: PreviewProcess | null = null;
  let previewGeneration = 0;
  let latestPreviewStartGeneration = 0;
  let previewStopEpoch = 0;
  let notifiedStopEpoch = 0;
  let previewTransition: Promise<void> = Promise.resolve();
  let disposed = false;
  let quiescenceFlight: Promise<void> | null = null;
  const buildOperations = new Set<Promise<void>>();
  const handlerOperations = new Set<Promise<unknown>>();
  const pendingPreviewProcesses = new Set<RunningCliProcess>();

  const trackBuildOperation = (operation: Promise<void>): void => {
    buildOperations.add(operation);
    void operation.then(
      () => buildOperations.delete(operation),
      () => buildOperations.delete(operation),
    );
  };
  const trackHandlerOperation = <T>(operation: Promise<T>): Promise<T> => {
    handlerOperations.add(operation);
    void operation.then(
      () => handlerOperations.delete(operation),
      () => handlerOperations.delete(operation),
    );
    return operation;
  };
  const trackedHandler =
    <T>(
      handler: (args: CommandArgs) => Promise<T>,
    ): ((args: CommandArgs) => Promise<T>) =>
    (args) =>
      trackHandlerOperation(handler(args));

  const ensureNotDisposed = (): void => {
    if (disposed) throw new Error("Vivliostyle manager is disposed");
  };
  const ready = async (): Promise<void> => {
    await initialCleanup;
    ensureNotDisposed();
  };
  const withPreviewTransition = async <T>(
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = previewTransition;
    let release!: () => void;
    previewTransition = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
  const emit = (channel: string, payload: unknown): void => {
    if (disposed) return;
    try {
      broadcast(channel, payload);
    } catch (cause) {
      console.warn(`[vivliostyle] event broadcast failed: ${channel}`, cause);
    }
  };

  const detectAndTrust = async (
    refresh = false,
  ): Promise<ValidatedExecutable | null> => {
    ensureNotDisposed();
    if (!refresh && detectedExecutable) return detectedExecutable;
    // build / preview / panel-open detect が同時に来ても、PATH probeを多重起動せず
    // 同じ結果へ収束させる。refreshはin-flight完了後の次回呼び出しから効く。
    if (detectionInFlight) return detectionInFlight;
    if (refresh) detectedExecutable = null;
    const task = (async (): Promise<ValidatedExecutable | null> => {
      const found = await detectBinary();
      ensureNotDisposed();
      if (!found) return null;
      const validated = await validateExecutable(
        found,
        platform,
        isFile,
        resolveRealPath,
      );
      ensureNotDisposed();
      detectedExecutable = validated;
      return validated;
    })();
    detectionInFlight = task;
    try {
      return await task;
    } finally {
      if (detectionInFlight === task) detectionInFlight = null;
    }
  };

  const resolveExecutable = async (raw: unknown): Promise<string> => {
    ensureNotDisposed();
    const requested = optionalString(raw, "binaryPath");
    if (requested === null || requested.toLowerCase() === VIVLIOSTYLE_BINARY) {
      const detected = await detectAndTrust();
      if (!detected) {
        throw new Error(
          "vivliostyle CLI が見つかりません。`npm install -g @vivliostyle/cli` でインストールするか、設定でパスを指定してください",
        );
      }
      return detected.executable;
    }

    const validated = await validateExecutable(
      requested,
      platform,
      isFile,
      resolveRealPath,
    );
    ensureNotDisposed();
    if (
      detectedExecutable?.executable === validated.executable ||
      trustedCustomExecutables.has(validated.executable)
    ) {
      return validated.executable;
    }
    if (!(await authorizeExecutable(validated.executable))) {
      throw new Error(
        `Vivliostyle executable was not authorized: ${validated.executable}`,
      );
    }
    ensureNotDisposed();
    trustedCustomExecutables.add(validated.executable);
    return validated.executable;
  };

  const expireOutputs = async (): Promise<void> => {
    const cleanup: Promise<void>[] = [];
    for (const [token, artifact] of outputs) {
      if (artifact.saving) {
        artifact.expired = true;
        continue;
      }
      outputs.delete(token);
      cleanup.push(cleanupDir(artifact.dir));
    }
    await Promise.all(cleanup);
  };

  const clearForceKillTimer = (run: BuildRun): void => {
    if (run.forceKillTimer !== null) {
      clearTimeout(run.forceKillTimer);
      run.forceKillTimer = null;
    }
  };
  const stopBuildProcess = (run: BuildRun): void => {
    if (!run.process) return;
    run.process.terminate("SIGTERM");
    if (run.forceKillTimer === null) {
      run.forceKillTimer = setTimeout(() => {
        run.process?.terminate("SIGKILL");
      }, forceKillAfterMs);
      run.forceKillTimer.unref();
    }
  };
  const waitForProcessStopped = async (
    process: RunningCliProcess,
  ): Promise<boolean> => {
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const stopped = await Promise.race([
      process.completion.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        fallback = setTimeout(() => resolve(false), forceKillAfterMs + 250);
        fallback.unref();
      }),
    ]);
    if (fallback) clearTimeout(fallback);
    return stopped;
  };
  const waitForRunnerQuiescence = async (
    operation: Promise<void>,
  ): Promise<boolean> => {
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      operation.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolve) => {
        fallback = setTimeout(() => resolve(false), forceKillAfterMs + 250);
        fallback.unref();
      }),
    ]);
    if (fallback) clearTimeout(fallback);
    return settled;
  };
  const waitForProcessStarted = async (
    process: RunningCliProcess,
  ): Promise<void> => {
    if (!process.started) return;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        process.started,
        process.completion.then(
          () => {
            throw new Error(
              "vivliostyle preview exited before spawn confirmation",
            );
          },
          (cause) => {
            throw toError(cause);
          },
        ),
        new Promise<never>((_resolve, reject) => {
          fallback = setTimeout(
            () => reject(new Error("vivliostyle preview spawn timed out")),
            forceKillAfterMs + 250,
          );
          fallback.unref();
        }),
      ]);
    } finally {
      if (fallback) clearTimeout(fallback);
    }
  };
  const waitForStopped = async (run: BuildRun): Promise<void> => {
    if (!run.process) return;
    await waitForProcessStopped(run.process);
  };
  const waitForOperation = async (
    operation: Promise<unknown>,
  ): Promise<boolean> => {
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      operation.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        fallback = setTimeout(() => resolve(false), forceKillAfterMs + 250);
        fallback.unref();
      }),
    ]);
    if (fallback) clearTimeout(fallback);
    return settled;
  };

  const executeBuild = async (run: BuildRun): Promise<void> => {
    let preserveDir = false;
    try {
      const executable = await resolveExecutable(run.binaryPath);
      if (run.aborted) throw new BuildAbortedError();
      ensureNotDisposed();
      const spec: CliCommandSpec = {
        executable,
        args: [
          "build",
          INPUT_FILE_NAME,
          "-f",
          run.format,
          "-o",
          run.outputName,
        ],
        cwd: run.dir,
      };
      try {
        run.process = runner.start(spec);
      } catch (cause) {
        throw new Error(
          `vivliostyle の起動に失敗しました (${executable}): ${toError(cause).message}`,
          { cause },
        );
      }
      if (run.aborted) stopBuildProcess(run);

      const budget: OutputBudget = { bytes: 0, lines: 0, emittedBytes: 0 };
      const relay = (line: string): void => {
        if (run.aborted || disposed) return;
        budget.emittedBytes += Buffer.byteLength(line, "utf8");
        if (budget.emittedBytes > MAX_EMITTED_LOG_BYTES) {
          throw new Error("Vivliostyle emitted log exceeds limit");
        }
        emit("vivliostyle:log", { runId: run.runId, line });
      };

      let result: { exitCode: number | null; signal: NodeJS.Signals | null };
      try {
        [result] = await Promise.all([
          run.process.completion,
          consumeLines(run.process.stdout, budget, relay),
          consumeLines(run.process.stderr, budget, relay),
        ]);
      } catch (cause) {
        if (!run.aborted) stopBuildProcess(run);
        await waitForStopped(run);
        throw cause;
      } finally {
        clearForceKillTimer(run);
      }

      if (run.aborted) throw new BuildAbortedError();
      if (result.exitCode !== 0) {
        const status =
          result.exitCode !== null
            ? `exit code ${result.exitCode}`
            : `signal ${result.signal ?? "unknown"}`;
        throw new Error(`vivliostyle build が異常終了しました (${status})`);
      }
      const outputFile = path.join(run.dir, run.outputName);
      if (!(await isFile(outputFile))) {
        throw new Error(`成果物 ${run.outputName} が生成されませんでした`);
      }
      // stat 待ち中の abort を取りこぼさない。この後 token 登録・done emit までは
      // await を挟まないため、ここを abort / done 終端の線形化点にする。
      if (run.aborted) throw new BuildAbortedError();
      ensureNotDisposed();
      const outputToken = randomId();
      outputs.set(outputToken, {
        file: outputFile,
        dir: run.dir,
        format: run.format,
        saving: false,
        expired: false,
      });
      preserveDir = true;
      emit("vivliostyle:done", { runId: run.runId, outputToken });
    } catch (cause) {
      if (!disposed) {
        const message = run.aborted
          ? "ビルドを中断しました"
          : toError(cause).message;
        emit("vivliostyle:error", { runId: run.runId, message });
      }
    } finally {
      clearForceKillTimer(run);
      if (runs.get(run.runId) === run) runs.delete(run.runId);
      if (!preserveDir) await cleanupDir(run.dir);
    }
  };

  const notifyStoppedStart = (
    startEpoch: number,
    startGeneration: number,
  ): void => {
    if (
      latestPreviewStartGeneration === startGeneration &&
      previewStopEpoch !== startEpoch &&
      notifiedStopEpoch !== previewStopEpoch
    ) {
      notifiedStopEpoch = previewStopEpoch;
      emit("vivliostyle:preview-exited", {});
    }
  };

  /** withPreviewTransition 内からだけ呼ぶ。 */
  const evictPreview = async (): Promise<void> => {
    const current = preview;
    preview = null;
    if (!current) return;
    current.process.terminate("SIGKILL");
    // signal送信（Windowsでは非同期taskkill起動）だけでは終了完了ではない。
    // 旧server/Chromiumが既定portを解放してから次世代をspawnする。
    await waitForProcessStopped(current.process);
    await cleanupDir(current.dir);
  };

  const handlers: ShellCommandHandlers = {
    vivliostyle_detect: async (args: CommandArgs) => {
      await ready();
      const raw = optionalString(args.binaryPath, "binaryPath");
      try {
        const validated =
          raw === null
            ? await detectAndTrust(true)
            : await validateExecutable(raw, platform, isFile, resolveRealPath);
        if (!validated) return null;
        if (
          raw !== null &&
          detectedExecutable?.executable !== validated.executable &&
          !trustedCustomExecutables.has(validated.executable)
        ) {
          if (!(await authorizeExecutable(validated.executable))) return null;
          trustedCustomExecutables.add(validated.executable);
        }
        const result = await runner.run(
          { executable: validated.executable, args: ["--version"] },
          {
            timeoutMs: DETECT_TIMEOUT_MS,
            maxOutputBytes: DETECT_MAX_OUTPUT_BYTES,
          },
        );
        if (result.exitCode !== 0) return null;
        const version =
          firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
        return version ? { path: validated.requestedPath, version } : null;
      } catch {
        // Tauri契約: 未検出・起動確認失敗はinvoke errorではなくnull。
        return null;
      }
    },

    vivliostyle_build: trackedHandler(async (args: CommandArgs) => {
      await ready();
      const format = parseFormat(args.format);
      const inputFiles = parseFiles(args.files, maxInputBytes);
      const binaryPath = optionalString(args.binaryPath, "binaryPath");
      await expireOutputs();
      const dir = await writeInputDir(tempRoot, inputFiles);
      if (disposed) {
        await cleanupDir(dir);
        ensureNotDisposed();
      }
      const runId = randomId();
      const run: BuildRun = {
        runId,
        dir,
        format,
        outputName: `output.${format}`,
        binaryPath,
        aborted: false,
        process: null,
        forceKillTimer: null,
      };
      runs.set(runId, run);
      trackBuildOperation(executeBuild(run));
      return runId;
    }),

    vivliostyle_abort_build: async (args: CommandArgs) => {
      await ready();
      const runId = requireOpaqueId(args.runId, "runId");
      const run = runs.get(runId);
      if (!run) return null;
      run.aborted = true;
      stopBuildProcess(run);
      return null;
    },

    vivliostyle_save_output: async (args: CommandArgs) => {
      await ready();
      const outputToken = requireOpaqueId(args.outputToken, "outputToken");
      const artifact = outputs.get(outputToken);
      if (!artifact) {
        throw new Error(
          "成果物が見つかりません (期限切れの可能性があります。再ビルドしてください)",
        );
      }
      if (artifact.saving) {
        throw new Error("この成果物は保存処理中です");
      }
      // await より前に single-use lease を獲得する。同じ token の同期2 invokeが
      // isFile 待ちへ入って保存dialogを二重表示するのを防ぐ。
      artifact.saving = true;
      const releaseAfterFailure = async (): Promise<void> => {
        if (outputs.get(outputToken) !== artifact) return;
        if (artifact.expired || disposed) {
          outputs.delete(outputToken);
          await cleanupDir(artifact.dir);
        } else {
          artifact.saving = false;
        }
      };

      try {
        if (!(await isFile(artifact.file))) {
          outputs.delete(outputToken);
          await cleanupDir(artifact.dir);
          throw new Error(
            "成果物が見つかりません (期限切れの可能性があります。再ビルドしてください)",
          );
        }
        ensureNotDisposed();
      } catch (cause) {
        await releaseAfterFailure();
        throw cause;
      }

      const options: VivliostyleSaveDialogOptions =
        artifact.format === "epub"
          ? {
              suggestedName: "book.epub",
              filterName: "EPUB",
              extensions: ["epub"],
            }
          : {
              suggestedName: "book.pdf",
              filterName: "PDF",
              extensions: ["pdf"],
            };
      let destination: string | null;
      try {
        destination = await pickSavePath(options);
      } catch (cause) {
        await releaseAfterFailure();
        throw cause;
      }
      if (destination === null) {
        await releaseAfterFailure();
        return null;
      }
      try {
        ensureNotDisposed();
      } catch (cause) {
        await releaseAfterFailure();
        throw cause;
      }
      if (!path.isAbsolute(destination)) {
        await releaseAfterFailure();
        throw new Error("Vivliostyle save dialog returned a non-absolute path");
      }

      try {
        await copyFile(artifact.file, destination);
      } catch (cause) {
        await releaseAfterFailure();
        throw new Error(
          `成果物のコピーに失敗しました ${artifact.file} → ${destination}: ${toError(cause).message}`,
          { cause },
        );
      }
      if (outputs.get(outputToken) === artifact) outputs.delete(outputToken);
      await cleanupDir(artifact.dir);
      return destination;
    },

    vivliostyle_preview_start: trackedHandler(async (args: CommandArgs) => {
      await ready();
      const inputFiles = parseFiles(args.files, maxInputBytes);
      const binaryPath = optionalString(args.binaryPath, "binaryPath");
      const generation = ++previewGeneration;
      latestPreviewStartGeneration = generation;
      const startEpoch = previewStopEpoch;

      const executable = await resolveExecutable(binaryPath);
      if (generation !== previewGeneration) {
        notifyStoppedStart(startEpoch, generation);
        return null;
      }
      ensureNotDisposed();
      const dir = await writeInputDir(tempRoot, inputFiles);
      if (generation !== previewGeneration) {
        await cleanupDir(dir);
        notifyStoppedStart(startEpoch, generation);
        return null;
      }
      return withPreviewTransition(async () => {
        if (generation !== previewGeneration || disposed) {
          await cleanupDir(dir);
          if (disposed) ensureNotDisposed();
          notifyStoppedStart(startEpoch, generation);
          return null;
        }

        // 旧previewの完全終了と新previewのspawnを同じtransitionに閉じる。
        // 並行startが旧childのport解放前に次childをspawnするのを防ぐ。
        await evictPreview();
        if (generation !== previewGeneration || disposed) {
          await cleanupDir(dir);
          if (disposed) ensureNotDisposed();
          notifyStoppedStart(startEpoch, generation);
          return null;
        }

        let process: RunningCliProcess | null = null;
        try {
          process = runner.start({
            executable,
            args: ["preview", INPUT_FILE_NAME],
            cwd: dir,
          });
          pendingPreviewProcesses.add(process);
          // Node spawn の ENOENT/EACCES は start() の同期throwではなく child の
          // error event になる。OSのspawn成功までboundedに待ち、Tauriと同じ
          // invoke reject契約に揃える。旧/test runnerは started を省略できる。
          await waitForProcessStarted(process);
        } catch (cause) {
          if (process !== null) {
            process.terminate("SIGKILL");
            await waitForProcessStopped(process);
          }
          await cleanupDir(dir);
          throw new Error(
            `vivliostyle preview の起動に失敗しました (${executable}): ${toError(cause).message}`,
            { cause },
          );
        } finally {
          if (process !== null) pendingPreviewProcesses.delete(process);
        }
        if (process === null) {
          await cleanupDir(dir);
          throw new Error("vivliostyle preview process was not created");
        }
        if (generation !== previewGeneration || disposed) {
          // spawn通知待ちの間に stop / 次世代start / app終了が入った旧childを、
          // preview slotへ公開する前に確実に回収する。
          process.terminate("SIGKILL");
          await waitForProcessStopped(process);
          await cleanupDir(dir);
          if (disposed) ensureNotDisposed();
          notifyStoppedStart(startEpoch, generation);
          return null;
        }
        const entry: PreviewProcess = { generation, process, dir };
        preview = entry;

        const budget: OutputBudget = { bytes: 0, lines: 0, emittedBytes: 0 };
        void Promise.all([
          consumeLines(process.stdout, budget, () => {}),
          consumeLines(process.stderr, budget, () => {}),
        ]).catch(() => {
          if (preview === entry) process.terminate("SIGKILL");
        });
        void process.completion
          .then(
            () => undefined,
            () => undefined,
          )
          .then(async () => {
            if (preview !== entry) return;
            preview = null;
            await cleanupDir(dir);
            // cleanup の await 中に stop / 次世代 start が入った場合、旧世代の
            // exited で現役 preview の楽観状態を落とさない。
            if (previewGeneration !== generation) return;
            emit("vivliostyle:preview-exited", {});
          });
        return null;
      });
    }),

    vivliostyle_preview_stop: async () => {
      await ready();
      previewStopEpoch += 1;
      previewGeneration += 1;
      await withPreviewTransition(evictPreview);
      return null;
    },
  };

  const quiesceForProfileEgress = (): Promise<void> => {
    if (quiescenceFlight) return quiescenceFlight;
    const activeBuildRuns = [...runs.values()];
    const activeBuildOperations = [...buildOperations];
    const activeHandlerOperations = [...handlerOperations];
    const activeBuildProcesses = activeBuildRuns.flatMap((run) =>
      run.process ? [run.process] : [],
    );
    const activePreview = preview;
    const activePreviewProcesses = new Set<RunningCliProcess>(
      pendingPreviewProcesses,
    );
    if (activePreview) activePreviewProcesses.add(activePreview.process);

    quiescenceFlight = (async () => {
      let closeError: unknown = null;
      // Close admission before the first await. Pending resolve/authorization
      // continuations then fail their existing ensureNotDisposed checks.
      disposed = true;
      previewGeneration += 1;
      previewStopEpoch += 1;

      for (const run of activeBuildRuns) {
        run.aborted = true;
        try {
          stopBuildProcess(run);
        } catch (error) {
          closeError ??= error;
        }
      }
      for (const process of activePreviewProcesses) {
        try {
          process.terminate("SIGKILL");
        } catch (error) {
          closeError ??= error;
        }
      }
      try {
        // This is only a synchronous admission/child stop request. Completion
        // is proved below by the tracked operations and process promises.
        runner.disposeAll?.();
      } catch (error) {
        closeError ??= error;
      }

      let runnerQuiescence: Promise<boolean>;
      try {
        const barrier = runner.quiesceForProfileEgress?.();
        runnerQuiescence = barrier
          ? waitForRunnerQuiescence(barrier)
          : Promise.resolve(true);
      } catch {
        runnerQuiescence = Promise.resolve(false);
      }
      const hasRunnerQuiescence =
        typeof runner.quiesceForProfileEgress === "function";

      const [
        handlersSettled,
        buildsSettled,
        buildProcessesStopped,
        previewsStopped,
        runnerQuiesced,
      ] = await Promise.all([
        Promise.all(
          activeHandlerOperations.map((operation) =>
            waitForOperation(operation),
          ),
        ),
        Promise.all(
          activeBuildOperations.map((operation) => waitForOperation(operation)),
        ),
        Promise.all(
          hasRunnerQuiescence
            ? []
            : activeBuildProcesses.map((process) =>
                waitForProcessStopped(process),
              ),
        ),
        Promise.all(
          hasRunnerQuiescence
            ? []
            : [...activePreviewProcesses].map((process) =>
                waitForProcessStopped(process),
              ),
        ),
        runnerQuiescence,
      ]);

      if (closeError) throw toError(closeError);
      if (
        handlersSettled.some((value) => !value) ||
        buildsSettled.some((value) => !value) ||
        buildProcessesStopped.some((value) => !value) ||
        previewsStopped.some((value) => !value) ||
        !runnerQuiesced
      ) {
        throw new Error("Vivliostyle egress transport did not quiesce");
      }
      if (activePreview) await cleanupDir(activePreview.dir);
    })().finally(() => {
      quiescenceFlight = null;
    });
    return quiescenceFlight;
  };

  return {
    handlers,
    quiesceForProfileEgress,
    disposeAll() {
      if (disposed) return;
      disposed = true;
      previewGeneration += 1;
      previewStopEpoch += 1;

      for (const run of runs.values()) {
        run.aborted = true;
        clearForceKillTimer(run);
        run.process?.terminate("SIGKILL");
        cleanupDirSync(run.dir);
      }
      runs.clear();
      if (preview) {
        preview.process.terminate("SIGKILL");
        cleanupDirSync(preview.dir);
        preview = null;
      }
      for (const process of pendingPreviewProcesses) {
        process.terminate("SIGKILL");
      }
      pendingPreviewProcesses.clear();
      for (const artifact of outputs.values()) cleanupDirSync(artifact.dir);
      outputs.clear();
      cleanupDirSync(tempRoot);
      runner.disposeAll?.();
    },
  };
}
