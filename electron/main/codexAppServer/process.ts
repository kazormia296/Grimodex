import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import type { ChildProcess } from "node:child_process";

import crossSpawn from "cross-spawn";

import {
  buildCliEnvironment,
  createNodeCliProcessRunner,
  detectCliBinaryMain,
  type CliProcessRunner,
} from "../cliAi.js";
import type { JsonRpcWire } from "./jsonRpcConnection.js";

const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"] as const;
const FORCE_KILL_AFTER_MS = 2_000;
const MAX_STDERR_TAIL_BYTES = 64 * 1024;

export interface CodexAppServerProcessOptions {
  platform?: NodeJS.Platform;
  resolveExecutable?: () => Promise<string | null>;
  authorizeExecutable?: (input: {
    executable: string;
    sha256: string | null;
  }) => Promise<boolean>;
  realPath?: (candidate: string) => Promise<string>;
  isFile?: (candidate: string) => Promise<boolean>;
  hashFile?: (candidate: string) => Promise<string | null>;
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

async function defaultHashFile(candidate: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const stream = createReadStream(candidate);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", () => resolve(null));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function defaultResolveExecutable(): Promise<string | null> {
  const platform = process.platform;
  const runner = createNodeCliProcessRunner(platform);
  try {
    return await detectCliBinaryMain("codex", {
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
  } finally {
    runner.disposeAll?.();
  }
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
  private stderrTail = Buffer.alloc(0);
  private readonly dataListeners = new Set<DataListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly options: Required<
    Pick<CodexAppServerProcessOptions, "platform" | "forceKillAfterMs">
  > &
    Omit<CodexAppServerProcessOptions, "platform" | "forceKillAfterMs">;
  private closePromise: Promise<void> | null = null;

  constructor(options: CodexAppServerProcessOptions = {}) {
    this.options = {
      platform: options.platform ?? process.platform,
      forceKillAfterMs: options.forceKillAfterMs ?? FORCE_KILL_AFTER_MS,
      resolveExecutable: options.resolveExecutable,
      authorizeExecutable: options.authorizeExecutable,
      realPath: options.realPath,
      isFile: options.isFile,
      hashFile: options.hashFile,
      runner: options.runner,
      spawn: options.spawn,
      onStderr: options.onStderr,
    };
  }

  async start(): Promise<void> {
    if (this.child && !this.closed) return;
    this.closed = false;
    this.closeError = undefined;
    const resolveExecutable =
      this.options.resolveExecutable ?? defaultResolveExecutable;
    const candidate = await resolveExecutable();
    if (!candidate) throw new Error("Codex CLI executable was not found");
    const canonical = await (this.options.realPath ?? realpath)(candidate);
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
    if (
      this.options.authorizeExecutable &&
      !(await this.options.authorizeExecutable({
        executable: canonical,
        sha256,
      }))
    ) {
      throw new Error("Codex CLI executable was not authorized");
    }

    const spawn = this.options.spawn ?? crossSpawn;
    let child: ChildProcess;
    try {
      child = spawn(canonical, [...CODEX_APP_SERVER_ARGS], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.options.platform !== "win32",
        env: buildCliEnvironment("codex"),
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
    if (!child.stdin || !child.stdout || !child.stderr) {
      killProcessTree(child, this.options.platform, "SIGKILL");
      this.child = null;
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
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      const child = this.child;
      if (!child || this.closed) {
        this.closed = true;
        return;
      }
      this.closed = true;
      killProcessTree(child, this.options.platform, "SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killProcessTree(child, this.options.platform, "SIGKILL");
          resolve();
        }, this.options.forceKillAfterMs);
        timer.unref?.();
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.child = null;
      for (const listener of [...this.closeListeners])
        listener(this.closeError);
      this.closeListeners.clear();
      this.dataListeners.clear();
      this.errorListeners.clear();
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
}
