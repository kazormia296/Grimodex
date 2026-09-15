import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import crossSpawn from "cross-spawn";

import {
  buildCliEnvironment,
  createNodeCliProcessRunner,
  detectCliBinaryMain,
  type CliProcessRunner,
} from "../cliAi.js";
import { prepareIsolatedCodexHome } from "./isolatedHome.js";
import type { JsonRpcWire } from "./jsonRpcConnection.js";

const CODEX_APP_SERVER_ARGS = [
  "app-server",
  "--strict-config",
  "--listen",
  "stdio://",
] as const;
const FORCE_KILL_AFTER_MS = 2_000;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

export interface CodexAppServerProcessOptions {
  platform?: NodeJS.Platform;
  /** Main-owned persisted setting. Renderer payloads must never supply this. */
  getConfiguredExecutable?: () => Promise<string | null>;
  resolveExecutable?: () => Promise<string | null>;
  authorizeExecutable?: (input: {
    executable: string;
    sha256: string | null;
  }) => Promise<boolean>;
  realPath?: (candidate: string) => Promise<string>;
  isFile?: (candidate: string) => Promise<boolean>;
  hashFile?: (candidate: string) => Promise<string | null>;
  /** Grimodex-owned CODEX_HOME. The app-server refuses to spawn without it. */
  codexHomeDir?: string;
  /** Real user CODEX_HOME used only as the source of auth.json. */
  sourceCodexHomeDir?: string;
  runner?: CliProcessRunner;
  spawn?: typeof crossSpawn;
  forceKillAfterMs?: number;
  onStderr?: (text: string) => void;
}

type DataListener = (chunk: Buffer | string) => void;
type CloseListener = (cause?: Error) => void;
type ErrorListener = (cause: Error) => void;

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class CodexAppServerTerminationUnconfirmedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CodexAppServerTerminationUnconfirmedError";
  }
}

export function isCodexAppServerTerminationUnconfirmedError(
  value: unknown,
): value is CodexAppServerTerminationUnconfirmedError {
  return value instanceof CodexAppServerTerminationUnconfirmedError;
}

async function defaultHashFile(candidate: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(candidate);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", () => resolve(null));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function defaultResolveExecutable(
  suppliedRunner?: CliProcessRunner,
): Promise<string | null> {
  const platform = process.platform;
  const runner = suppliedRunner ?? createNodeCliProcessRunner(platform);
  let detectionFailed = false;
  let detectionFailure: unknown;
  let detectionResult: string | null = null;
  try {
    detectionResult = await detectCliBinaryMain("codex", {
      runner,
      platform,
      env: process.env,
      homeDir: os.homedir(),
      isFile: async (candidate) => {
        try {
          return (await stat(candidate)).isFile();
        } catch {
          return false;
        }
      },
    });
  } catch (cause) {
    detectionFailed = true;
    detectionFailure = cause;
  }
  let disposeFailed = false;
  let disposeFailure: unknown;
  try {
    runner.disposeAll?.();
  } catch (cause) {
    disposeFailed = true;
    disposeFailure = cause;
  }
  let barrierFailed = false;
  let barrierFailure: unknown;
  try {
    await runner.quiesceForProfileEgress?.();
  } catch (cause) {
    barrierFailed = true;
    barrierFailure = cause;
  }
  const cleanupFailures: unknown[] = [];
  if (disposeFailed) cleanupFailures.push(disposeFailure);
  if (barrierFailed) cleanupFailures.push(barrierFailure);
  if (cleanupFailures.length > 0) {
    const failures = detectionFailed
      ? [detectionFailure, ...cleanupFailures]
      : cleanupFailures;
    const cause =
      failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Codex CLI detector cleanup did not complete",
          );
    throw new CodexAppServerTerminationUnconfirmedError(
      "Codex CLI detector child termination was not confirmed",
      cause,
    );
  }
  if (detectionFailed) throw detectionFailure;
  return detectionResult;
}

function normalizeConfiguredExecutable(
  value: string | null,
  platform: NodeJS.Platform,
): string | null {
  if (value === null || value.trim() === "") return null;
  const candidate = value.trim();
  if (candidate.includes("\0")) {
    throw new Error("Configured Codex CLI executable contains a NUL byte");
  }
  const api = platform === "win32" ? path.win32 : path.posix;
  const leaf = api.basename(candidate).toLowerCase();
  const allowedLeaves =
    platform === "win32"
      ? ["codex", "codex.exe", "codex.cmd", "codex.bat"]
      : ["codex"];
  if (!allowedLeaves.includes(leaf)) {
    throw new Error("Configured Codex CLI executable must be named `codex`");
  }
  const containsSeparator = candidate.includes("/") || candidate.includes("\\");
  if (!containsSeparator) {
    // A bare `codex` setting has the same documented meaning as an empty path:
    // resolve it through the main-owned PATH detector.
    return null;
  }
  if (!api.isAbsolute(candidate)) {
    throw new Error("Configured Codex CLI executable path must be absolute");
  }
  if (
    platform === "win32" &&
    candidate.replaceAll("/", "\\").startsWith("\\\\")
  ) {
    throw new Error(
      "Configured Codex CLI executable cannot be loaded from a network path",
    );
  }
  return candidate;
}

function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: "SIGTERM" | "SIGKILL",
): void {
  const pid = child.pid;
  if (pid == null) {
    child.kill(signal);
    return;
  }
  if (platform === "win32") {
    const result = crossSpawn.sync(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Main-only stdio process for `codex app-server --listen stdio://`. */
export class CodexAppServerProcess implements JsonRpcWire {
  private child: ChildProcess | null = null;
  private closed = false;
  private closeError: Error | undefined;
  private disposeRequested = false;
  private stderrTail = Buffer.alloc(0);
  private readonly dataListeners = new Set<DataListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly options: Required<
    Pick<CodexAppServerProcessOptions, "platform" | "forceKillAfterMs">
  > &
    Omit<CodexAppServerProcessOptions, "platform" | "forceKillAfterMs">;
  private closePromise: Promise<void> | null = null;
  private childClosePromise: Promise<void> | null = null;
  private childCloseObserved = false;

  constructor(options: CodexAppServerProcessOptions = {}) {
    this.options = {
      platform: options.platform ?? process.platform,
      forceKillAfterMs: options.forceKillAfterMs ?? FORCE_KILL_AFTER_MS,
      getConfiguredExecutable: options.getConfiguredExecutable,
      resolveExecutable: options.resolveExecutable,
      authorizeExecutable: options.authorizeExecutable,
      realPath: options.realPath,
      isFile: options.isFile,
      hashFile: options.hashFile,
      codexHomeDir: options.codexHomeDir,
      sourceCodexHomeDir: options.sourceCodexHomeDir,
      runner: options.runner,
      spawn: options.spawn,
      onStderr: options.onStderr,
    };
  }

  async start(): Promise<void> {
    this.ensureStartAllowed();
    if (this.child && !this.closed) return;
    this.closed = false;
    this.closeError = undefined;
    this.stderrTail = Buffer.alloc(0);
    const configured = normalizeConfiguredExecutable(
      (await this.options.getConfiguredExecutable?.()) ?? null,
      this.options.platform,
    );
    this.ensureStartAllowed();
    const resolveExecutable =
      this.options.resolveExecutable ??
      (() => defaultResolveExecutable(this.options.runner));
    const candidate = configured ?? (await resolveExecutable());
    this.ensureStartAllowed();
    if (!candidate) throw new Error("Codex CLI executable was not found");
    const canonical = await (this.options.realPath ?? realpath)(candidate);
    this.ensureStartAllowed();
    const isFile =
      this.options.isFile ??
      (async (value: string) => {
        try {
          return (await stat(value)).isFile();
        } catch {
          return false;
        }
      });
    if (!(await isFile(canonical))) {
      throw new Error("Codex CLI executable is not a regular file");
    }
    const sha256 = await (this.options.hashFile ?? defaultHashFile)(canonical);
    if (!sha256) {
      throw new Error("Codex CLI executable could not be fingerprinted");
    }
    this.ensureStartAllowed();
    const authorizeExecutable =
      this.options.authorizeExecutable ?? (async () => false);
    if (
      !(await authorizeExecutable({
        executable: canonical,
        sha256,
      }))
    ) {
      throw new Error("Codex CLI executable was not authorized");
    }
    this.ensureStartAllowed();

    const codexHomeDir = this.options.codexHomeDir;
    if (!codexHomeDir) {
      throw new Error("Grimodex Codex home was not configured");
    }
    const isolatedCodexHome = await prepareIsolatedCodexHome({
      codexHomeDir,
      sourceCodexHomeDir: this.options.sourceCodexHomeDir,
    });
    this.ensureStartAllowed();

    // Authorization covers an executable identity, not merely a pathname.
    // Re-resolve and re-hash immediately before spawn so a symlink target or
    // file replaced while the confirmation dialog was open is rejected.
    const spawnCanonical = await (this.options.realPath ?? realpath)(candidate);
    if (spawnCanonical !== canonical || !(await isFile(spawnCanonical))) {
      throw new Error("Codex CLI executable changed after authorization");
    }
    const spawnSha256 = await (this.options.hashFile ?? defaultHashFile)(
      spawnCanonical,
    );
    if (!spawnSha256 || spawnSha256 !== sha256) {
      throw new Error("Codex CLI executable changed after authorization");
    }
    this.ensureStartAllowed();

    const spawn = this.options.spawn ?? crossSpawn;
    let child: ChildProcess;
    try {
      child = spawn(canonical, [...CODEX_APP_SERVER_ARGS], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.options.platform !== "win32",
        cwd: isolatedCodexHome,
        env: {
          ...buildCliEnvironment("codex"),
          CODEX_HOME: isolatedCodexHome,
        },
      });
    } catch (cause) {
      throw new Error(
        `Failed to spawn Codex app-server: ${errorFrom(cause).message}`,
        {
          cause,
        },
      );
    }
    this.child = child;
    this.childCloseObserved = false;
    let resolveChildClose!: () => void;
    this.childClosePromise = new Promise((resolve) => {
      resolveChildClose = resolve;
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      killProcessTree(child, this.options.platform, "SIGKILL");
      this.child = null;
      this.childClosePromise = null;
      throw new Error("Codex app-server stdio is unavailable");
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      for (const listener of [...this.dataListeners]) listener(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stderrTail = Buffer.concat([this.stderrTail, buffer]).subarray(
        -MAX_STDERR_TAIL_BYTES,
      );
      this.options.onStderr?.(buffer.toString("utf8"));
    });
    child.once("error", (cause) => this.fail(errorFrom(cause)));
    child.once("close", (code, signal) => {
      this.childCloseObserved = true;
      resolveChildClose();
      if (this.closed) return;
      const status =
        code == null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      this.fail(new Error(`Codex app-server exited with ${status}`));
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };
      const onError = (cause: Error): void => {
        cleanup();
        reject(cause);
      };
      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      // Some injected test children are already usable and do not emit spawn.
      if (child.pid != null) queueMicrotask(onSpawn);
    });
    this.ensureStartAllowed();
  }

  write(line: string): void {
    if (this.closed || !this.child?.stdin) {
      throw new Error("Codex app-server process is not running");
    }
    this.child.stdin.write(line, "utf8");
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    if (this.closed) listener(this.closeError);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    if (this.closeError) listener(this.closeError);
    return () => this.errorListeners.delete(listener);
  }

  close(): void {
    void this.dispose();
  }

  async dispose(): Promise<void> {
    this.disposeRequested = true;
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const child = this.child;
      if (!child) {
        this.closed = true;
        this.childClosePromise = null;
        this.childCloseObserved = false;
        this.clearListeners();
        return;
      }
      this.closed = true;
      const waitForClose = async (timeoutMs: number): Promise<boolean> => {
        if (this.childCloseObserved) return true;
        const closePromise = this.childClosePromise;
        if (!closePromise) return false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const closed = await Promise.race([
          closePromise.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
        return closed;
      };

      if (child.exitCode === null && child.signalCode === null) {
        try {
          killProcessTree(child, this.options.platform, "SIGTERM");
        } catch (cause) {
          throw new Error(
            `Codex app-server child termination failed: ${errorFrom(cause).message}`,
            { cause },
          );
        }
      }
      if (!(await waitForClose(this.options.forceKillAfterMs))) {
        try {
          killProcessTree(child, this.options.platform, "SIGKILL");
        } catch (cause) {
          throw new Error(
            `Codex app-server child force termination failed: ${errorFrom(cause).message}`,
            { cause },
          );
        }
        if (!(await waitForClose(this.options.forceKillAfterMs))) {
          throw new Error("Codex app-server child did not close");
        }
      }
      this.child = null;
      this.childClosePromise = null;
      this.childCloseObserved = false;
      for (const listener of [...this.closeListeners])
        listener(this.closeError);
      this.clearListeners();
    })();
    return this.closePromise;
  }

  getStderrTail(): string {
    return this.stderrTail.toString("utf8");
  }

  private fail(cause: Error): void {
    if (this.closed) return;
    this.closeError = cause;
    this.closed = true;
    for (const listener of [...this.errorListeners]) listener(cause);
    for (const listener of [...this.closeListeners]) listener(cause);
    this.closeListeners.clear();
  }

  private ensureStartAllowed(): void {
    if (this.disposeRequested) {
      throw new Error("Codex app-server process is disposed");
    }
  }

  private clearListeners(): void {
    this.closeListeners.clear();
    this.dataListeners.clear();
    this.errorListeners.clear();
  }
}
